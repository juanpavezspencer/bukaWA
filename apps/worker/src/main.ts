import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import PgBoss from "pg-boss";
import * as schema from "@bukuwa/db";
import { piiKeysFromBase64, type Db } from "@bukuwa/db";
import { cloudApiSender, WA_INBOUND_QUEUE } from "@bukuwa/wa";
import { loadConfig } from "./config.js";
import { processInbound } from "./inbound.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as Db;

const deps = {
  db,
  sender: cloudApiSender({
    phoneNumberId: config.WA_PHONE_NUMBER_ID,
    accessToken: config.WA_ACCESS_TOKEN,
    apiVersion: config.WA_GRAPH_API_VERSION,
  }),
  keys: piiKeysFromBase64(config.PII_HMAC_KEY, config.PII_ENC_KEY),
  config: {
    privacyPolicyUrl: config.PRIVACY_POLICY_URL,
    consentVersion: config.CONSENT_VERSION,
    trialDays: config.TRIAL_DAYS,
    timezone: config.DEFAULT_TIMEZONE,
  },
};

const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (err) => console.error(JSON.stringify({ level: "error", event: "pgboss.error", error: err.message })));
await boss.start();
await boss.createQueue(WA_INBOUND_QUEUE);
await boss.work<{ waMessageId: string }>(WA_INBOUND_QUEUE, async (jobs) => {
  for (const job of jobs) await processInbound(deps, job.data.waMessageId);
});
console.log(JSON.stringify({ level: "info", event: "worker.started", queue: WA_INBOUND_QUEUE }));
