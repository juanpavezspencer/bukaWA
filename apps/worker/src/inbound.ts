import { eq } from "drizzle-orm";
import {
  businesses,
  consumeInvite,
  findUsableInvite,
  findUserByPhoneHash,
  normalizeInviteCode,
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
  type ChatModel,
  type Intent,
  type NormalizedEntry,
  type RawExtraction,
  type SpeechToText,
  type StructuredModel,
  noSpeechToText,
  SttUnavailableError,
  withUsageMeter,
} from "@bukuwa/ai";
import { parsePaymentMethod, parseRupiah, parseSummaryRequest, parseTaxRequest, type SummaryRequest, type TaxRequest } from "@bukuwa/idn";
import type { ReportFormat } from "@bukuwa/reports";
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
import { askBooks } from "./agent/ask.js";
import type { CorrectionProposal } from "./agent/tools.js";
import { createCorrection } from "./capture/correction.js";
import type { JournalSummary } from "@bukuwa/ledger";
import { createBusinessFromOnboarding, localDate } from "./business.js";
import { parseCaptureReply } from "./capture/card.js";
import {
  answerAmount,
  answerCounterparty,
  answerPayment,
  answerSettles,
  cancelCapture,
  confirmAsSettlement,
  confirmCapture,
  createCapture,
  findPendingCapture,
} from "./capture/flow.js";
import { MAX_INVITE_ATTEMPTS, onboardingStep, wantsInviteCode, type OnboardingState } from "./onboarding.js";
import { handleSummaryRequest } from "./summary.js";
import { adminLink, dashboardLink, isAdminRequest, isDashboardRequest, type DashboardDeps } from "./dashboard.js";
import { ensureTaxNoticeSchedule, handleTaxRequest, parseReportReply, reportReply, type TaxDeps } from "./tax.js";
import { inboundToday, recordUsage, type LimitDeps, type MeteringDeps } from "./usage.js";
import { handlePrivacyReply, handlePrivacyRequest, parsePrivacyReply, parsePrivacyRequest, type PrivacyDeps, type PrivacyRequest } from "./privacy.js";

export interface InboundDeps {
  db: Db;
  sender: WaSender;
  keys: PiiKeys;
  ai: { model: StructuredModel; config: AiConfig; stt?: SpeechToText; chat?: ChatModel };
  /** Photo and voice capture; without it media gets a "not yet" reply. */
  media?: { fetcher: MediaFetcher; store: MediaStore };
  /** Tax estimates, reports and the month-end notice (F10); without it they get a "not yet" reply. */
  tax?: TaxDeps;
  /** Magic-link login to the web dashboard and admin console. */
  dashboard?: DashboardDeps;
  config: { privacyPolicyUrl: string; consentVersion: string; trialDays: number; timezone: string };
  /** Per-business model cost (usage_events); without it calls are not recorded. */
  metering?: MeteringDeps;
  /** Daily message cap per business; without it there is no cap. */
  limits?: LimitDeps;
  /** "ekspor data" / "hapus data" (UU PDP); without it they get a "contact us" reply. */
  privacy?: PrivacyDeps;
  /** Pilot gating: new numbers need an invite code (pilot_invites). */
  pilot?: { inviteRequired: boolean };
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

const EXAMPLES = "Contoh:\n• jual nasi box 25 x 18rb tf BCA\n• belanja ayam 175rb cash\n• bayar listrik 350rb transfer";

const REPLIES: Record<Exclude<Intent, "transaction">, string> = {
  // Used only when no chat model is configured; otherwise the agent answers.
  question:
    "Fitur tanya laporan (misalnya \"untung minggu ini berapa?\") lagi disiapin, segera hadir ya. Sementara ini aku bisa bantu catat transaksi dulu.",
  correction:
    "Koreksi lewat chat segera hadir. Kalau belum tercatat, tekan Batal di kartu konfirmasinya ya.",
  command: `Aku bisa catat penjualan, pengeluaran, modal dan prive dari chat. Kirim aja transaksinya. ${EXAMPLES}`,
  chitchat: `Siap! 😊 Kirim transaksi kapan aja ya. ${EXAMPLES}`,
  unsupported: `Maaf, aku belum ngerti maksudnya. ${EXAMPLES}`,
};

const PRIVACY_NOT_YET: OutboundMessage = {
  kind: "text",
  body: "Untuk ekspor atau hapus data, balas pesan ini dengan permintaanmu ya, tim BukuWA akan bantu langsung. 🙏",
};
const TAX_NOT_YET: OutboundMessage = { kind: "text", body: "Perkiraan pajak dan laporan bulanan segera hadir ya. 🙏" };
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
const dailyCapReached = (limit: number): OutboundMessage => ({
  kind: "text",
  body:
    `Hari ini udah ${limit} pesan, banyak banget! 😅 Biar aman, aku istirahat dulu sampai besok ya. ` +
    "Semua transaksi yang udah tercatat tetap aman. Tombol di kartu konfirmasi masih bisa dipakai.",
});
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
  | { kind: "answer_counterparty"; captureId: string; name: string }
  | { kind: "summary"; request: SummaryRequest }
  | { kind: "tax"; request: TaxRequest }
  | { kind: "login" }
  | { kind: "privacy"; request: PrivacyRequest }
  | { kind: "privacy_reply"; reply: "erase_yes" | "erase_no" }
  | { kind: "admin_login" }
  | { kind: "report"; month: string; format: ReportFormat }
  | { kind: "correction"; proposal: CorrectionProposal; summary: JournalSummary; modelVersion: string; text: string }
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
  s: Sender,
  text: string,
  today: string,
  origin: { source: "text" } | { source: "voice"; mediaUrl: string; transcript: string; sttModel: string },
): Promise<Plan> {
  const routed = await routeMessage(deps.ai.model, deps.ai.config, text);
  if ((routed.intent === "question" || routed.intent === "correction") && deps.ai.chat) {
    // F7 / Flow D: answered from the ledger through read-only tools.
    const r = await askBooks(deps.ai.chat, deps.ai.config, {
      db: deps.db,
      businessId: s.user!.businessId,
      businessName: s.businessName,
      today,
      text,
      tax: deps.tax ? { defaultRegime: deps.tax.defaultRegime } : undefined,
    });
    if (r.kind === "report") return { kind: "report", month: r.month, format: r.format };
    if (r.kind === "proposal") return { kind: "correction", proposal: r.proposal, summary: r.summary, modelVersion: r.modelVersion, text };
    if (r.kind === "reminder") {
      return {
        kind: "reply",
        replies: [
          { kind: "text", body: `Ini draft pengingatnya, tinggal diteruskan ke ${r.contactName} ya 👇` },
          { kind: "text", body: r.text },
        ],
      };
    }
    return { kind: "reply", replies: [{ kind: "text", body: r.text }] };
  }
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
    return planText(deps, s, transcript.text, today, { source: "voice", mediaUrl, transcript: transcript.text, sttModel: transcript.model });
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
  // Staff may not own a business, so this comes before onboarding.
  if (deps.dashboard?.adminPhoneHashes.has(s.phoneHash) && isAdminRequest(s.input.text ?? "")) return { kind: "admin_login" };
  if (!s.user) return { kind: "onboarding" };
  if (parseCaptureReply(s.input.replyId)) return { kind: "capture_action" };
  const reportTap = parseReportReply(s.input.replyId);
  if (reportTap) return deps.tax ? { kind: "report", ...reportTap } : { kind: "reply", replies: [TAX_NOT_YET] };
  const privacyTap = parsePrivacyReply(s.input.replyId);
  if (privacyTap) return deps.privacy ? { kind: "privacy_reply", reply: privacyTap } : { kind: "reply", replies: [PRIVACY_NOT_YET] };
  // Data rights need no model and must work even over the daily cap.
  const privacyRequest = s.input.replyId ? null : parsePrivacyRequest(s.input.text ?? "");
  if (privacyRequest) return deps.privacy ? { kind: "privacy", request: privacyRequest } : { kind: "reply", replies: [PRIVACY_NOT_YET] };
  if (deps.limits) {
    // Button taps above need no model; everything below may.
    const n = await withAppRole(deps.db, async (tx) => {
      await setBusinessScope(tx, s.user!.businessId);
      return inboundToday(tx, s.user!.businessId, (deps.now ?? (() => new Date()))(), s.timezone);
    });
    if (n >= deps.limits.dailyInbound) {
      log({ level: "warn", event: "inbound.daily_cap", waMessageId, businessId: s.user.businessId, count: n });
      return { kind: "reply", replies: n === deps.limits.dailyInbound ? [dailyCapReached(n)] : [] };
    }
  }
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
    const words = text.split(/\s+/).length;
    if (!missing.includes("amount") && missing.includes("counterparty") && amount === null && words <= 4 && /\p{L}/u.test(text) && !/[\d?]/.test(text)) {
      return { kind: "answer_counterparty", captureId: pending.id, name: text.replace(/[.!?]+$/, "") };
    }
    const method = parsePaymentMethod(text);
    if (!missing.includes("amount") && !missing.includes("counterparty") && missing.includes("payment_method") && method && words <= 3) {
      return { kind: "answer_payment", captureId: pending.id, method };
    }
  }

  // "ringkasan harian jam 9 malam", "stop ringkasan", "rekap": settings, parsed by code.
  const summary = parseSummaryRequest(text);
  if (summary) return { kind: "summary", request: summary };

  if (isDashboardRequest(text)) {
    return deps.dashboard ? { kind: "login" } : { kind: "reply", replies: [{ kind: "text", body: "Dashboard web segera hadir ya. 🙏" }] };
  }

  // "pajak bulan lalu berapa?", "laporan oktober excel", "stop pengingat pajak".
  const taxRequest = parseTaxRequest(text, today);
  if (taxRequest) return deps.tax ? { kind: "tax", request: taxRequest } : { kind: "reply", replies: [TAX_NOT_YET] };

  try {
    return await planText(deps, s, text, today, { source: "text" });
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
  let state = { ...(session!.data as object), step: session!.step } as OnboardingState;
  const inviteRequired = deps.pilot?.inviteRequired ?? false;
  // Too many wrong codes locks the number for a day, then it may try again.
  if (state.step === "awaiting_invite" && (state.inviteAttempts ?? 0) >= MAX_INVITE_ATTEMPTS && now().getTime() - session!.updatedAt.getTime() > 86_400_000) {
    state = { step: "new" };
  }
  const code = wantsInviteCode(state, inviteRequired) && !s.input.replyId ? normalizeInviteCode(s.input.text ?? "") : null;
  const found = code ? await findUsableInvite(tx, code, now()) : null;
  const result = onboardingStep(state, s.input, { privacyPolicyUrl: deps.config.privacyPolicyUrl, invite: { required: inviteRequired, found }, now });
  let businessId: string | undefined;

  let invite: { code: string; cohort: string } | undefined;
  if (result.complete?.inviteCode) {
    // Counted only when the business is created; a code can run out meanwhile.
    const used = await consumeInvite(tx, result.complete.inviteCode, now());
    if (!used) {
      await tx.update(onboardingSessions).set({ step: "awaiting_invite", data: { inviteAttempts: 0 }, updatedAt: now() }).where(eq(onboardingSessions.phoneHash, s.phoneHash));
      return {
        replies: [{ kind: "text" as const, body: "Yah, kuota kode undangannya baru aja habis. 🙏 Minta kode baru ke tim BukuWA, lalu kirim ke sini ya. Data yang tadi kamu isi belum disimpan." }],
        businessId: undefined,
        event: "onboarding.invite_exhausted",
      };
    }
    invite = { code: used.code, cohort: used.cohort };
  }

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
      invite,
    }));
    await tx.delete(onboardingSessions).where(eq(onboardingSessions.phoneHash, s.phoneHash));
    if (deps.tax) await ensureTaxNoticeSchedule(tx, businessId, deps.config.timezone, now(), deps.tax.noticeLocalTime);
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
  const { result: p, calls } = await withUsageMeter(() => plan(deps, sender, waMessageId, today, log));

  const outcome = await withAppRole(deps.db, async (tx) => {
    const [row] = await tx.select().from(waInbound).where(eq(waInbound.waMessageId, waMessageId)).for("update");
    if (!row || row.processedAt) return undefined;

    let replies: OutboundMessage[];
    let businessId = sender.user?.businessId;
    let event: string;

    if (p.kind === "onboarding") {
      ({ replies, businessId, event } = await runOnboarding(tx, deps, sender, now));
    } else if (p.kind === "admin_login") {
      // Not logged to any business's messages: staff aren't tenants.
      replies = await adminLink(tx, deps.dashboard!, { phoneHash: sender.phoneHash, now: now() });
      businessId = undefined;
      event = "inbound.admin_login";
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
        case "summary":
          replies = await handleSummaryRequest(
            tx,
            { businessId: ctx.businessId, businessName: sender.businessName ?? "usahamu", today, timezone: sender.timezone, now: now() },
            p.request,
          );
          break;
        case "privacy":
          replies = await handlePrivacyRequest(tx, deps.keys, deps.privacy!, { ...ctx, now: now(), timezone: sender.timezone }, p.request);
          event = `privacy.${p.request}`;
          break;
        case "privacy_reply":
          replies = await handlePrivacyReply(tx, deps.keys, deps.privacy!, { ...ctx, now: now(), timezone: sender.timezone }, p.reply);
          event = `privacy.${p.reply}`;
          break;
        case "login":
          replies = await dashboardLink(tx, deps.dashboard!, { businessId: ctx.businessId, userId: ctx.userId, now: now() });
          break;
        case "tax":
          replies = await handleTaxRequest(tx, { ...ctx, now: now(), timezone: sender.timezone }, deps.tax!, p.request);
          break;
        case "report":
          replies = await reportReply(tx, { ...ctx, now: now() }, deps.tax!, p.month, p.format);
          break;
        case "answer_counterparty":
          replies = await answerCounterparty(tx, p.captureId, p.name);
          break;
        case "correction":
          replies = await createCorrection(tx, {
            businessId: ctx.businessId,
            waMessageId,
            text: p.text,
            proposal: p.proposal,
            summary: p.summary,
            modelVersion: p.modelVersion,
          });
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
            : a.action === "settle" ? await confirmAsSettlement(tx, ctx, a.captureId)
            : a.action === "pay" ? await answerPayment(tx, a.captureId, a.method)
            : a.action === "side" ? await answerSettles(tx, a.captureId, a.settles)
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
          createdAt: now(),
        },
        ...replies.map((r) => ({
          businessId: businessId!,
          direction: "outbound" as const,
          type: r.kind,
          body: messageLogBody(r),
          createdAt: now(),
        })),
      ]);
    }
    if (businessId && deps.metering) {
      await recordUsage(tx, deps.metering, { businessId, waMessageId, now: now(), timezone: sender.timezone }, calls, log);
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
