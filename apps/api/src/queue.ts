import type PgBoss from "pg-boss";
import { WA_INBOUND_QUEUE } from "@bukuwa/wa";

export const INBOUND_QUEUE = WA_INBOUND_QUEUE;

export interface JobQueue {
  /** Enqueue processing of one stored inbound message. May be called more than once per id. */
  enqueueInbound(waMessageId: string): Promise<void>;
}

/**
 * pg-boss adapter. singletonKey dedupes repeat sends within the window; the
 * worker must still be idempotent on wa_message_id (captures has a unique index).
 */
export function pgBossQueue(boss: PgBoss): JobQueue {
  return {
    async enqueueInbound(waMessageId) {
      await boss.send(INBOUND_QUEUE, { waMessageId }, { singletonKey: waMessageId, singletonHours: 24 });
    },
  };
}
