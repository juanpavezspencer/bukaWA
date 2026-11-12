import { and, inArray, isNull, sql } from "drizzle-orm";
import { waInbound, withAppRole, type Db } from "@bukuwa/db";
import type { InboundMessage } from "./whatsapp/payload.js";

/**
 * Store inbound messages, idempotent on wa_message_id. Returns ids that still
 * need a job: newly inserted ones plus earlier ones whose enqueue failed
 * (Meta retries the delivery, so we get another chance).
 */
export async function recordInbound(db: Db, msgs: InboundMessage[]): Promise<string[]> {
  if (msgs.length === 0) return [];
  return withAppRole(db, async (tx) => {
    await tx
      .insert(waInbound)
      .values(msgs.map((m) => ({ waMessageId: m.waMessageId, fromPhone: m.from, type: m.type, payload: m.raw })))
      .onConflictDoNothing({ target: waInbound.waMessageId });
    const pending = await tx
      .select({ id: waInbound.waMessageId })
      .from(waInbound)
      .where(and(inArray(waInbound.waMessageId, msgs.map((m) => m.waMessageId)), isNull(waInbound.enqueuedAt)));
    return pending.map((p) => p.id);
  });
}

export async function markEnqueued(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withAppRole(db, (tx) =>
    tx.update(waInbound).set({ enqueuedAt: sql`now()` }).where(inArray(waInbound.waMessageId, ids)),
  );
}
