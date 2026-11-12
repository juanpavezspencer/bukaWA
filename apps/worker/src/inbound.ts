import { eq } from "drizzle-orm";
import {
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
} from "@bukuwa/db";
import { inboundInput, messageLogBody, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { createBusinessFromOnboarding } from "./business.js";
import { onboardingStep, type OnboardingState } from "./onboarding.js";

export interface InboundDeps {
  db: Db;
  sender: WaSender;
  keys: PiiKeys;
  config: { privacyPolicyUrl: string; consentVersion: string; trialDays: number; timezone: string };
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const NOT_YET: OutboundMessage = {
  kind: "text",
  body: "Pesan kamu sudah aku terima ✅ Fitur catat transaksi lagi disiapin, sebentar lagi bisa dipakai ya.",
};

const defaultLog = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

/**
 * Process one stored inbound message. Idempotent: the wa_inbound row is locked
 * and marked processed in the same transaction as every state change, so a
 * redelivered job does nothing. Replies are sent after commit (at most once;
 * a failed send is logged, not retried, to avoid double replies).
 */
export async function processInbound(deps: InboundDeps, waMessageId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  const outcome = await withAppRole(deps.db, async (tx) => {
    const [row] = await tx.select().from(waInbound).where(eq(waInbound.waMessageId, waMessageId)).for("update");
    if (!row || row.processedAt) return undefined;

    const phone = toE164(row.fromPhone);
    const phoneHash = hashPii(deps.keys, phone);
    const input = inboundInput(row.payload as Record<string, unknown>);
    let businessId: string | undefined;
    let replies: OutboundMessage[];
    let event: string;

    const user = await findUserByPhoneHash(tx, phoneHash);
    if (user) {
      businessId = user.businessId;
      await setBusinessScope(tx, businessId);
      replies = [NOT_YET]; // milestone 2: router + capture
      event = "inbound.known_sender";
    } else {
      await tx.insert(onboardingSessions).values({ phoneHash, step: "new" }).onConflictDoNothing();
      const [session] = await tx
        .select()
        .from(onboardingSessions)
        .where(eq(onboardingSessions.phoneHash, phoneHash))
        .for("update");
      const state = { ...(session!.data as object), step: session!.step } as OnboardingState;
      const result = onboardingStep(state, input, { privacyPolicyUrl: deps.config.privacyPolicyUrl, now });
      replies = result.replies;
      event = `onboarding.${result.state.step}`;

      if (result.complete) {
        ({ businessId } = await createBusinessFromOnboarding(tx, deps.keys, {
          phoneE164: phone,
          phoneHash,
          name: result.complete.name,
          type: result.complete.type,
          openingCash: result.complete.openingCash,
          consentAt: new Date(result.complete.consentAt),
          consentVersion: deps.config.consentVersion,
          trialDays: deps.config.trialDays,
          timezone: deps.config.timezone,
          now: now(),
        }));
        await tx.delete(onboardingSessions).where(eq(onboardingSessions.phoneHash, phoneHash));
      } else if (result.state.step === "declined") {
        await tx.delete(onboardingSessions).where(eq(onboardingSessions.phoneHash, phoneHash));
      } else {
        const { step, ...data } = result.state;
        await tx
          .update(onboardingSessions)
          .set({ step, data, updatedAt: now() })
          .where(eq(onboardingSessions.phoneHash, phoneHash));
      }
    }

    if (businessId) {
      await tx.insert(messages).values([
        { businessId, direction: "inbound", waMessageId, type: row.type, body: input.text ?? null },
        ...replies.map((r) => ({
          businessId: businessId!,
          direction: "outbound" as const,
          type: r.kind,
          body: messageLogBody(r),
        })),
      ]);
    }
    await tx.update(waInbound).set({ processedAt: now() }).where(eq(waInbound.waMessageId, waMessageId));
    return { phone, replies, event, businessId };
  });

  if (!outcome) {
    log({ level: "info", event: "inbound.skip_processed", waMessageId });
    return;
  }
  log({ level: "info", event: outcome.event, waMessageId, businessId: outcome.businessId });
  for (const reply of outcome.replies) {
    try {
      await deps.sender.send(outcome.phone, reply);
    } catch (err) {
      log({ level: "error", event: "wa.send_failed", waMessageId, error: (err as Error).message });
      break;
    }
  }
}
