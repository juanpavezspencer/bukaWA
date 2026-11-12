import { z } from "zod";

// Only the fields we rely on are validated; everything else is kept verbatim in `raw`.
const MessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.string().optional(),
    type: z.string().min(1),
  })
  .passthrough();

const WebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              metadata: z.object({ phone_number_id: z.string() }).partial().optional(),
              messages: z.array(MessageSchema).optional(),
            })
            .passthrough(),
        }),
      ),
    }),
  ),
});

export interface InboundMessage {
  waMessageId: string;
  from: string;
  type: string;
  raw: Record<string, unknown>;
}

export type ParseResult = { ok: true; messages: InboundMessage[] } | { ok: false; error: string };

/** Extract inbound user messages; delivery/read statuses are ignored for now. */
export function parseWebhook(body: unknown): ParseResult {
  const parsed = WebhookSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid payload" };

  const seen = new Set<string>();
  const messages: InboundMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      for (const m of change.value.messages ?? []) {
        if (seen.has(m.id)) continue; // same id twice in one delivery
        seen.add(m.id);
        messages.push({ waMessageId: m.id, from: m.from, type: m.type, raw: m });
      }
    }
  }
  return { ok: true, messages };
}
