import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "@bukuwa/db";
import type { ApiConfig } from "./config.js";
import { markEnqueued, recordInbound } from "./inbox.js";
import type { JobQueue } from "./queue.js";
import { parseWebhook } from "./whatsapp/payload.js";
import { verifyWebhookSignature } from "./whatsapp/signature.js";

export interface AppDeps {
  db: Db;
  queue: JobQueue;
  config: Pick<ApiConfig, "WA_APP_SECRET" | "WA_VERIFY_TOKEN" | "WA_WEBHOOK_MAX_BYTES">;
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

export function createApp({ db, queue, config, log = defaultLog }: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));

  // Meta subscription handshake.
  app.get("/webhooks/whatsapp", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && token === config.WA_VERIFY_TOKEN && challenge) {
      return c.text(challenge);
    }
    return c.text("forbidden", 403);
  });

  app.post(
    "/webhooks/whatsapp",
    bodyLimit({ maxSize: config.WA_WEBHOOK_MAX_BYTES, onError: (c) => c.text("payload too large", 413) }),
    async (c) => {
      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (!verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), config.WA_APP_SECRET)) {
        log({ level: "warn", event: "wa.webhook.bad_signature" });
        return c.text("invalid signature", 401);
      }

      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return c.text("invalid json", 400);
      }
      const parsed = parseWebhook(body);
      if (!parsed.ok) {
        log({ level: "warn", event: "wa.webhook.invalid_payload", error: parsed.error });
        return c.text("invalid payload", 400);
      }

      const pending = await recordInbound(db, parsed.messages);
      const enqueued: string[] = [];
      try {
        for (const id of pending) {
          await queue.enqueueInbound(id);
          enqueued.push(id);
        }
      } finally {
        await markEnqueued(db, enqueued);
      }

      log({
        level: "info",
        event: "wa.webhook.received",
        messages: parsed.messages.length,
        enqueued: enqueued.length,
        duplicates: parsed.messages.length - pending.length,
      });
      return c.text("ok");
    },
  );

  app.onError((err, c) => {
    log({ level: "error", event: "api.unhandled", path: c.req.path, error: err.message });
    // Non-2xx makes Meta retry; stored rows without enqueued_at get re-enqueued then.
    return c.text("internal error", 500);
  });

  return app;
}
