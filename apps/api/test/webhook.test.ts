import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { rows, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { createApp } from "../src/app.js";
import type { JobQueue } from "../src/queue.js";
import { signWebhookBody } from "../src/whatsapp/signature.js";

const config = {
  WA_APP_SECRET: "test-app-secret-0123456789",
  WA_VERIFY_TOKEN: "verify-me-please",
  WA_WEBHOOK_MAX_BYTES: 100_000,
};

class FakeQueue implements JobQueue {
  sent: string[] = [];
  failNext = 0;
  async enqueueInbound(id: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("queue down");
    }
    this.sent.push(id);
  }
}

function payload(...ids: string[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "6281100000000", phone_number_id: "PNID" },
              contacts: [{ profile: { name: "Rina" }, wa_id: "6281234567890" }],
              messages: ids.map((id) => ({
                id,
                from: "6281234567890",
                timestamp: "1762934400",
                type: "text",
                text: { body: "jual nasi box 25 x 18rb transfer BCA" },
              })),
            },
          },
        ],
      },
    ],
  };
}

let db: Db;
let queue: FakeQueue;
let app: ReturnType<typeof createApp>;

function post(body: unknown, signature?: string | null) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = signature === undefined ? signWebhookBody(raw, config.WA_APP_SECRET) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return app.request("/webhooks/whatsapp", { method: "POST", headers, body: raw });
}

async function inboundRows() {
  const r = await db.execute(sql`select wa_message_id, enqueued_at from wa_inbound order by wa_message_id`);
  return rows<{ wa_message_id: string; enqueued_at: Date | null }>(r);
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  queue = new FakeQueue();
  app = createApp({ db, queue, config, log: () => {} });
});

describe("GET /webhooks/whatsapp (subscription handshake)", () => {
  it("echoes the challenge for the right verify token", async () => {
    const res = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=12345");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("rejects a wrong verify token", async () => {
    const res = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345");
    expect(res.status).toBe(403);
  });
});

describe("POST /webhooks/whatsapp", () => {
  it("rejects requests without a valid signature and stores nothing", async () => {
    expect((await post(payload("wamid.A"), null)).status).toBe(401);
    expect((await post(payload("wamid.A"), "sha256=" + "0".repeat(64))).status).toBe(401);
    const otherBody = JSON.stringify(payload("wamid.OTHER"));
    expect((await post(payload("wamid.A"), signWebhookBody(otherBody, config.WA_APP_SECRET))).status).toBe(401);
    expect(await inboundRows()).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("stores and enqueues a new message", async () => {
    const res = await post(payload("wamid.A"));
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual(["wamid.A"]);
    const rows = await inboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enqueued_at).not.toBeNull();
  });

  it("is idempotent on wa_message_id across redeliveries", async () => {
    await post(payload("wamid.A"));
    const again = await post(payload("wamid.A"));
    expect(again.status).toBe(200);
    expect(queue.sent).toEqual(["wamid.A"]);
    expect(await inboundRows()).toHaveLength(1);
  });

  it("only enqueues the new messages in a mixed batch, and dedupes within one delivery", async () => {
    await post(payload("wamid.A"));
    await post(payload("wamid.A", "wamid.B", "wamid.B"));
    expect(queue.sent).toEqual(["wamid.A", "wamid.B"]);
    expect((await inboundRows()).map((r) => r.wa_message_id)).toEqual(["wamid.A", "wamid.B"]);
  });

  it("returns 500 when the queue fails, then enqueues on Meta's retry", async () => {
    queue.failNext = 1;
    expect((await post(payload("wamid.A"))).status).toBe(500);
    expect((await inboundRows())[0]!.enqueued_at).toBeNull();
    expect((await post(payload("wamid.A"))).status).toBe(200);
    expect(queue.sent).toEqual(["wamid.A"]);
    expect((await inboundRows())[0]!.enqueued_at).not.toBeNull();
  });

  it("accepts status-only callbacks without storing anything", async () => {
    const statusOnly = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    };
    expect((await post(statusOnly)).status).toBe(200);
    expect(await inboundRows()).toEqual([]);
  });

  it("rejects signed but malformed payloads", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ object: "page", entry: [] })).status).toBe(400);
  });

  it("rejects oversized bodies", async () => {
    const big = { ...payload("wamid.A"), pad: "x".repeat(200_000) };
    expect((await post(big)).status).toBe(413);
    expect(await inboundRows()).toEqual([]);
  });
});
