import { eq } from "drizzle-orm";
import {
  businesses,
  findUserByPhoneHash,
  hashPii,
  messages,
  onboardingSessions,
  setBusinessScope,
  toE164,
  waInbound,
  withAppRole,
  type Db,
  type PiiKeys,
  type Tx,
} from "@bukuwa/db";
import {
  extractFromDocument,
  extractTransaction,
  ModelOutputError,
  ModelRefusalError,
  normalizeExtraction,
  routeMessage,
  type AiConfig,
  type Intent,
  type NormalizedEntry,
  type RawExtraction,
  type SpeechToText,
  type StructuredModel,
  noSpeechToText,
  SttUnavailableError,
} from "@bukuwa/ai";
import { parsePaymentMethod, parseRupiah } from "@bukuwa/idn";
import {
  IMAGE_MIME_TYPES,
  inboundInput,
  inboundMedia,
  MediaTooLargeError,
  messageLogBody,
  type InboundInput,
  type InboundMedia,
  type MediaFetcher,
  type OutboundMessage,
  type WaSender,
} from "@bukuwa/wa";
import { mediaKey, type MediaStore } from "./media/store.js";
import { createBusinessFromOnboarding, localDate } from "./business.js";
import { parseCaptureReply } from "./capture/card.js";
import {
  answerAmount,
  answerPayment,
  cancelCapture,
  confirmCapture,
  createCapture,
  findPendingCapture,
} from "./capture/flow.js";
import { onboardingStep, type OnboardingState } from "./onboarding.js";

export interface InboundDeps {
  db: Db;
  sender: WaSender;
  keys: PiiKeys;
  ai: { model: StructuredModel; config: AiConfig; stt?: SpeechToText };
  /** Photo and voice capture; without it media gets a "not yet" reply. */
  media?: { fetcher: MediaFetcher; store: MediaStore };
  config: { privacyPolicyUrl: string; consentVersion: string; trialDays: number; timezone: string };
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

const EXAMPLES = "Contoh:\n• jual nasi box 25 x 18rb tf BCA\n• belanja ayam 175rb cash\n• bayar listrik 350rb transfer";

const REPLIES: Record<Exclude<Intent, "transaction">, string> = {
  question:
    "Fitur tanya laporan (misalnya \"untung minggu ini berapa?\") lagi disiapin, segera hadir ya. Sementara ini aku bisa bantu catat transaksi dulu.",
  correction:
    "Koreksi lewat chat segera hadir. Kalau belum tercatat, tekan Batal di kartu konfirmasinya ya.",
  command: `Aku bisa catat penjualan, pengeluaran, modal dan prive dari chat. Kirim aja transaksinya. ${EXAMPLES}`,
  chitchat: `Siap! 😊 Kirim transaksi kapan aja ya. ${EXAMPLES}`,
  unsupported: `Maaf, aku belum ngerti maksudnya. ${EXAMPLES}`,
};

const NOT_UNDERSTOOD: OutboundMessage = { kind: "text", body: REPLIES.unsupported };
const MEDIA_NOT_YET: OutboundMessage = {
  kind: "text",
  body: "Foto nota dan voice note segera bisa aku baca ya. Sementara ini kirim lewat teks dulu. 🙏",
};
const VOICE_NOT_YET: OutboundMessage = {
  kind: "text",
  body: "Voice note belum bisa aku dengerin, segera hadir ya. Sementara ini ketik aja transaksinya. 🙏",
};
const UNSUPPORTED_TYPE: OutboundMessage = {
  kind: "text",
  body: "Aku bisa baca teks, foto nota / bukti transfer, PDF invoice dan voice note. Yang ini belum bisa ya. 🙏",
};
const TOO_LARGE: OutboundMessage = {
  kind: "text",
  body: "Filenya kegedean buat aku baca. Coba kirim fotonya langsung (bukan sebagai dokumen) ya.",
};
const NOT_A_DOCUMENT: OutboundMessage = {
  kind: "text",
  body: "Aku nggak nemu transaksi di gambar ini. Kirim foto nota, struk atau bukti transfer ya, atau ketik aja transaksinya.",
};
const NOT_HEARD: OutboundMessage = {
  kind: "text",
  body: "Maaf, voice note-nya kurang jelas. Coba ulangi pelan-pelan, atau ketik aja transaksinya.",
};
const READING: Record<InboundMedia["kind"], OutboundMessage> = {
  image: { kind: "text", body: "Sebentar ya, lagi dibaca… 👀" },
  pdf: { kind: "text", body: "Sebentar ya, lagi dibaca… 👀" },
  audio: { kind: "text", body: "Sebentar ya, lagi didengerin… 🎧" },
};

/** Work done before the main transaction: model calls must not hold DB locks. */
type Plan =
  | { kind: "skip" }
  | { kind: "onboarding" }
  | { kind: "reply"; replies: OutboundMessage[] }
  | { kind: "capture_action" }
  | { kind: "answer_amount"; captureId: string; amount: bigint }
  | { kind: "answer_payment"; captureId: string; method: string }
  | {
      kind: "new_capture";
      raw: RawExtraction;
      entries: NormalizedEntry[];
      modelVersion: string;
      routerModelVersion: string | null;
      source: "text" | "photo" | "voice";
      text: string | null;
      mediaUrl?: string;
      transcript?: string;
      document?: { type: string; visibleText: string };
    };

interface Sender {
  phone: string;
  phoneHash: string;
  input: InboundInput;
  media: InboundMedia | null;
  rowType: string;
  user?: { userId: string; businessId: string };
  businessName?: string;
  timezone: string;
}

async function identify(deps: InboundDeps, waMessageId: string): Promise<Sender | null> {
  return withAppRole(deps.db, async (tx) => {
    const [row] = await tx.select().from(waInbound).where(eq(waInbound.waMessageId, waMessageId));
    if (!row || row.processedAt) return null;
    const phone = toE164(row.fromPhone);
    const phoneHash = hashPii(deps.keys, phone);
    const user = await findUserByPhoneHash(tx, phoneHash);
    let timezone = deps.config.timezone;
    let businessName: string | undefined;
    if (user) {
      await setBusinessScope(tx, user.businessId);
      const [b] = await tx.select({ tz: businesses.timezone, name: businesses.name }).from(businesses);
      timezone = b?.tz ?? timezone;
      businessName = b?.name;
    }
    const payload = row.payload as Record<string, unknown>;
    return { phone, phoneHash, input: inboundInput(payload), media: inboundMedia(payload), rowType: row.type, user, businessName, timezone };
  });
}

/** Text (typed or transcribed) -> router -> extractor -> normalizer. */
async function planText(
  deps: InboundDeps,
  text: string,
  today: string,
  origin: { source: "text" } | { source: "voice"; mediaUrl: string; transcript: string; sttModel: string },
): Promise<Plan> {
  const routed = await routeMessage(deps.ai.model, deps.ai.config, text);
  if (routed.intent !== "transaction") {
    return { kind: "reply", replies: [{ kind: "text", body: REPLIES[routed.intent] }] };
  }
  const { extraction, modelVersion } = await extractTransaction(deps.ai.model, deps.ai.config, { text, today });
  return {
    kind: "new_capture",
    raw: extraction,
    entries: normalizeExtraction(extraction, text, today, deps.ai.config.lowConfidenceThreshold),
    modelVersion: origin.source === "voice" ? `${origin.sttModel}+${modelVersion}` : modelVersion,
    routerModelVersion: routed.modelVersion,
    source: origin.source,
    text: origin.source === "text" ? text : null,
    ...(origin.source === "voice" ? { mediaUrl: origin.mediaUrl, transcript: origin.transcript } : {}),
  };
}

/**
 * Photos, PDFs and voice notes (F3, F4). The original is stored first so it is
 * kept as evidence even if reading it fails.
 */
async function planMedia(deps: InboundDeps, s: Sender, media: InboundMedia, waMessageId: string, today: string, log: Log): Promise<Plan> {
  if (!deps.media) return { kind: "reply", replies: [MEDIA_NOT_YET] };
  const stt = deps.ai.stt ?? noSpeechToText;
  if (media.kind === "audio" && stt === noSpeechToText) return { kind: "reply", replies: [VOICE_NOT_YET] };

  // Owners should hear back within seconds; reading takes longer. A retried job may repeat this.
  await deps.sender.send(s.phone, READING[media.kind]).catch((err: Error) =>
    log({ level: "warn", event: "wa.ack_failed", waMessageId, error: err.message }),
  );

  let file: { bytes: Uint8Array; mimeType: string };
  try {
    file = await deps.media.fetcher.fetch(media.id);
  } catch (err) {
    if (err instanceof MediaTooLargeError) return { kind: "reply", replies: [TOO_LARGE] };
    throw err;
  }
  const mimeType = media.kind === "pdf" ? "application/pdf" : file.mimeType || media.mimeType;
  const mediaUrl = await deps.media.store.put(mediaKey(s.user!.businessId, waMessageId, mimeType), file.bytes, mimeType);
  log({ level: "info", event: "media.stored", waMessageId, kind: media.kind, bytes: file.bytes.byteLength });

  if (media.kind === "audio") {
    let transcript;
    try {
      transcript = await stt.transcribe({ bytes: file.bytes, mimeType });
    } catch (err) {
      if (err instanceof SttUnavailableError) return { kind: "reply", replies: [VOICE_NOT_YET] };
      throw err;
    }
    if (!transcript.text) return { kind: "reply", replies: [NOT_HEARD] };
    return planText(deps, transcript.text, today, { source: "voice", mediaUrl, transcript: transcript.text, sttModel: transcript.model });
  }

  if (media.kind === "image" && !(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { kind: "reply", replies: [UNSUPPORTED_TYPE] };
  }
  if (media.kind === "image" && file.bytes.byteLength > deps.ai.config.visionMaxImageBytes) {
    return { kind: "reply", replies: [TOO_LARGE] };
  }
  const read = await extractFromDocument(deps.ai.model, deps.ai.config, {
    attachment: { mediaType: mimeType, data: file.bytes },
    caption: media.caption,
    today,
    businessName: s.businessName,
  });
  if (read.documentType === "not_a_document" || read.extraction.entries.length === 0) {
    return { kind: "reply", replies: [NOT_A_DOCUMENT] };
  }
  return {
    kind: "new_capture",
    raw: read.extraction,
    entries: normalizeExtraction(read.extraction, read.sourceText, today, deps.ai.config.lowConfidenceThreshold),
    modelVersion: read.modelVersion,
    routerModelVersion: null,
    source: "photo",
    text: media.caption?.trim() || null,
    mediaUrl,
    document: { type: read.documentType, visibleText: read.visibleText },
  };
}

type Log = (event: Record<string, unknown>) => void;

async function plan(deps: InboundDeps, s: Sender, waMessageId: string, today: string, log: Log): Promise<Plan> {
  if (!s.user) return { kind: "onboarding" };
  if (parseCaptureReply(s.input.replyId)) return { kind: "capture_action" };
  try {
    if (s.media) return await planMedia(deps, s, s.media, waMessageId, today, log);
  } catch (err) {
    if (err instanceof ModelRefusalError || err instanceof ModelOutputError) return { kind: "reply", replies: [NOT_UNDERSTOOD] };
    throw err;
  }
  const text = s.input.replyId ? "" : (s.input.text ?? "").trim();
  if (!text) return { kind: "reply", replies: [s.input.replyId ? NOT_UNDERSTOOD : UNSUPPORTED_TYPE] };

  // A short answer to a pending question ("Nominalnya berapa?") needs no model.
  const pending = await withAppRole(deps.db, async (tx) => {
    await setBusinessScope(tx, s.user!.businessId);
    return findPendingCapture(tx);
  });
  if (pending) {
    const missing = (pending.extractionJson as { entries: Array<{ missing: string[] }> }).entries.flatMap((e) => e.missing);
    const amount = parseRupiah(text);
    if (missing.includes("amount") && amount !== null && amount > 0n) {
      return { kind: "answer_amount", captureId: pending.id, amount };
    }
    const method = parsePaymentMethod(text);
    if (!missing.includes("amount") && missing.includes("payment_method") && method && text.split(/\s+/).length <= 3) {
      return { kind: "answer_payment", captureId: pending.id, method };
    }
  }

  try {
    return await planText(deps, text, today, { source: "text" });
  } catch (err) {
    // Refusals and malformed output won't improve on retry; API/network errors will (job retries).
    if (err instanceof ModelRefusalError || err instanceof ModelOutputError) {
      return { kind: "reply", replies: [NOT_UNDERSTOOD] };
    }
    throw err;
  }
}

async function runOnboarding(tx: Tx, deps: InboundDeps, s: Sender, now: () => Date) {
  await tx.insert(onboardingSessions).values({ phoneHash: s.phoneHash, step: "new" }).onConflictDoNothing();
  const [session] = await tx
    .select()
    .from(onboardingSessions)
    .where(eq(onboardingSessions.phoneHash, s.phoneHash))
    .for("update");
  const state = { ...(session!.data as object), step: session!.step } as OnboardingState;
  const result = onboardingStep(state, s.input, { privacyPolicyUrl: deps.config.privacyPolicyUrl, now });
  let businessId: string | undefined;

  if (result.complete) {
    ({ businessId } = await createBusinessFromOnboarding(tx, deps.keys, {
      phoneE164: s.phone,
      phoneHash: s.phoneHash,
      name: result.complete.name,
      type: result.complete.type,
      openingCash: result.complete.openingCash,
      consentAt: new Date(result.complete.consentAt),
      consentVersion: deps.config.consentVersion,
      trialDays: deps.config.trialDays,
      timezone: deps.config.timezone,
      now: now(),
    }));
    await tx.delete(onboardingSessions).where(eq(onboardingSessions.phoneHash, s.phoneHash));
  } else if (result.state.step === "declined") {
    await tx.delete(onboardingSessions).where(eq(onboardingSessions.phoneHash, s.phoneHash));
  } else {
    const { step, ...data } = result.state;
    await tx.update(onboardingSessions).set({ step, data, updatedAt: now() }).where(eq(onboardingSessions.phoneHash, s.phoneHash));
  }
  return { replies: result.replies, businessId, event: `onboarding.${result.state.step}` };
}

/**
 * Process one stored inbound message. Idempotent: the wa_inbound row is locked
 * and marked processed in the same transaction as every state change, so a
 * redelivered job does nothing. Model calls happen before that transaction.
 * Replies are sent after commit (at most once; failures are logged).
 */
export async function processInbound(deps: InboundDeps, waMessageId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  const sender = await identify(deps, waMessageId);
  if (!sender) {
    log({ level: "info", event: "inbound.skip_processed", waMessageId });
    return;
  }
  const today = localDate(now(), sender.timezone);
  const p = await plan(deps, sender, waMessageId, today, log);

  const outcome = await withAppRole(deps.db, async (tx) => {
    const [row] = await tx.select().from(waInbound).where(eq(waInbound.waMessageId, waMessageId)).for("update");
    if (!row || row.processedAt) return undefined;

    let replies: OutboundMessage[];
    let businessId = sender.user?.businessId;
    let event: string;

    if (p.kind === "onboarding") {
      ({ replies, businessId, event } = await runOnboarding(tx, deps, sender, now));
    } else {
      await setBusinessScope(tx, businessId!);
      const ctx = { businessId: businessId!, userId: sender.user!.userId, today };
      event = `inbound.${p.kind}`;
      switch (p.kind) {
        case "reply":
          replies = p.replies;
          break;
        case "answer_amount":
          replies = await answerAmount(tx, p.captureId, p.amount);
          break;
        case "answer_payment":
          replies = await answerPayment(tx, p.captureId, p.method);
          break;
        case "new_capture":
          replies = await createCapture(tx, {
            businessId: ctx.businessId,
            waMessageId,
            source: p.source,
            text: p.text,
            mediaUrl: p.mediaUrl,
            transcript: p.transcript,
            document: p.document,
            modelVersion: p.modelVersion,
            routerModelVersion: p.routerModelVersion,
            raw: p.raw,
            entries: p.entries,
          });
          break;
        case "capture_action": {
          const a = parseCaptureReply(sender.input.replyId)!;
          event = `capture.${a.action}`;
          replies =
            a.action === "ok" ? await confirmCapture(tx, ctx, a.captureId)
            : a.action === "pay" ? await answerPayment(tx, a.captureId, a.method)
            : await cancelCapture(tx, a.captureId, a.action);
          break;
        }
        default:
          replies = [];
      }
    }

    if (businessId) {
      await tx.insert(messages).values([
        {
          businessId,
          direction: "inbound",
          waMessageId,
          type: row.type,
          body: sender.input.text ?? sender.media?.caption ?? (p.kind === "new_capture" ? p.transcript ?? null : null),
        },
        ...replies.map((r) => ({
          businessId: businessId!,
          direction: "outbound" as const,
          type: r.kind,
          body: messageLogBody(r),
        })),
      ]);
    }
    await tx.update(waInbound).set({ processedAt: now() }).where(eq(waInbound.waMessageId, waMessageId));
    return { replies, event, businessId };
  });

  if (!outcome) {
    log({ level: "info", event: "inbound.skip_processed", waMessageId });
    return;
  }
  log({ level: "info", event: outcome.event, waMessageId, businessId: outcome.businessId });
  for (const reply of outcome.replies) {
    try {
      await deps.sender.send(sender.phone, reply);
    } catch (err) {
      log({ level: "error", event: "wa.send_failed", waMessageId, error: (err as Error).message });
      break;
    }
  }
}
