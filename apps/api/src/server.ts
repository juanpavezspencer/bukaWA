import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import PgBoss from "pg-boss";
import * as schema from "@bukuwa/db";
import { fsMediaStore, type Db } from "@bukuwa/db";
import { linkKeyFromBase64, linkSigner } from "@bukuwa/reports";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { INBOUND_QUEUE, pgBossQueue } from "./queue.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as Db;

const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (err) => console.error(JSON.stringify({ level: "error", event: "pgboss.error", error: err.message })));
await boss.start();
await boss.createQueue(INBOUND_QUEUE);

const linkKey = linkKeyFromBase64(config.REPORT_LINK_KEY);
const webOrigin = new URL(config.WEB_ORIGIN).origin;
const app = createApp({
  db,
  queue: pgBossQueue(boss),
  config,
  files: { key: linkKey, store: fsMediaStore(config.MEDIA_DIR) },
  dashboard: {
    webOrigin,
    sessionTtlDays: config.DASHBOARD_SESSION_DAYS,
    cookieSecure: config.COOKIE_SECURE,
    defaultRegime: config.TAX_DEFAULT_REGIME,
    maxBuckets: config.PNL_MAX_BUCKETS,
    signer: linkSigner({
      key: linkKey,
      baseUrl: config.PUBLIC_BASE_URL,
      reportTtlMinutes: config.REPORT_LINK_TTL_MINUTES,
      evidenceTtlHours: config.EVIDENCE_LINK_TTL_HOURS,
    }),
  },
  // The login role must be a member of bukuwa_admin (GRANT bukuwa_admin TO <api role>).
  admin: {
    webOrigin,
    sessionHours: config.ADMIN_SESSION_HOURS,
    cookieSecure: config.COOKIE_SECURE,
    reviewConfidenceBelow: config.REVIEW_CONFIDENCE_BELOW,
  },
});
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(JSON.stringify({ level: "info", event: "api.listening", port: info.port }));
});
