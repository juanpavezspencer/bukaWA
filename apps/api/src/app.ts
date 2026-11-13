import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db, MediaStore } from "@bukuwa/db";
import { openSignedFile, type LinkKind } from "@bukuwa/reports";
import { adminRoutes, type AdminConfig } from "./admin.js";
import type { ApiConfig } from "./config.js";
import { dashboardRoutes, type DashboardConfig } from "./dashboard.js";
import { markEnqueued, recordInbound } from "./inbox.js";
import type { JobQueue } from "./queue.js";
import { parseWebhook } from "./whatsapp/payload.js";
import { verifyWebhookSignature } from "./whatsapp/signature.js";

export interface AppDeps {
  db: Db;
  queue: JobQueue;
  config: Pick<ApiConfig, "WA_APP_SECRET" | "WA_VERIFY_TOKEN" | "WA_WEBHOOK_MAX_BYTES">;
  /** Signed report and evidence downloads (F10). */
  files?: { key: Buffer; store?: MediaStore };
  /** Owner dashboard API under /api (milestone 7). */
  dashboard?: DashboardConfig;
  /** Staff console API under /api/admin. */
  admin?: AdminConfig;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

export function createApp({ db, queue, config, files, dashboard, admin, now = () => new Date(), log = defaultLog }: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));

  if (files) app.route("/", fileRoutes({ db, ...files, now, log }));
  // Admin first: the dashboard's session check would otherwise claim /api/admin/*.
  if (admin) app.route("/api/admin", adminRoutes({ db, cfg: admin, now }));
  if (dashboard) app.route("/api", dashboardRoutes({ db, cfg: dashboard, now, log }));

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

const FILE_ERRORS: Record<404 | 410, string> = {
  404: "Link tidak ditemukan.",
  410: "Link ini sudah kedaluwarsa. Minta link baru lewat WhatsApp ya.",
};

/**
 * GET /r/:token (report) and /e/:token (evidence). Also mounted by the dev
 * chat simulator. Responses are never cached and leak nothing about why a
 * link failed beyond "expired".
 */
export function fileRoutes(deps: { db: Db; key: Buffer; store?: MediaStore; now: () => Date; log?: (e: Record<string, unknown>) => void }): Hono {
  const app = new Hono();
  const log = deps.log ?? defaultLog;
  const serve = (kind: LinkKind) => async (c: import("hono").Context) => {
    const f = await openSignedFile(deps, kind, c.req.param("token") ?? "", deps.now());
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    if (f.status !== 200) {
      log({ level: "info", event: `files.${kind}.${f.status}` });
      return c.text(FILE_ERRORS[f.status], f.status);
    }
    log({ level: "info", event: `files.${kind}.served`, bytes: f.bytes.byteLength });
    c.header("Content-Type", f.mimeType);
    c.header("Content-Disposition", `${f.disposition}; filename="${f.fileName.replace(/[^\w.-]/g, "_")}"`);
    return c.body(f.bytes as Uint8Array<ArrayBuffer>);
  };
  app.get("/r/:token", serve("report"));
  app.get("/e/:token", serve("evidence"));
  return app;
}
