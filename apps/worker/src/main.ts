import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import PgBoss from "pg-boss";
import * as schema from "@bukuwa/db";
import { hashPii, piiKeysFromBase64, toE164, type Db } from "@bukuwa/db";
import { aiConfigFromEnv, anthropicChatModel, anthropicModel } from "@bukuwa/ai";
import { cloudApiMediaFetcher, cloudApiSender, WA_INBOUND_QUEUE } from "@bukuwa/wa";
import { loadConfig } from "./config.js";
import { processInbound } from "./inbound.js";
import { runDueSummaries } from "./summary.js";
import { runDueTaxNotices } from "./tax.js";
import { linkKeyFromBase64, linkSigner } from "@bukuwa/reports";
import { fsMediaStore } from "./media/store.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as Db;

const keys = piiKeysFromBase64(config.PII_HMAC_KEY, config.PII_ENC_KEY);
const deps = {
  db,
  sender: cloudApiSender({
    phoneNumberId: config.WA_PHONE_NUMBER_ID,
    accessToken: config.WA_ACCESS_TOKEN,
    apiVersion: config.WA_GRAPH_API_VERSION,
  }),
  keys,
  dashboard: {
    webBaseUrl: config.WEB_BASE_URL,
    loginTtlMinutes: config.LOGIN_LINK_TTL_MINUTES,
    adminLoginTtlMinutes: config.ADMIN_LOGIN_TTL_MINUTES,
    adminPhoneHashes: new Set(
      config.ADMIN_PHONES.split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => hashPii(keys, toE164(p))),
    ),
  },
  // Credentials resolve from the environment (ANTHROPIC_API_KEY or a profile).
  // No speech-to-text provider yet (spec 7.4: choose by benchmark), so voice notes get a "not yet" reply.
  ai: { model: anthropicModel(), chat: anthropicChatModel(), config: aiConfigFromEnv() },
  media: {
    fetcher: cloudApiMediaFetcher({
      accessToken: config.WA_ACCESS_TOKEN,
      apiVersion: config.WA_GRAPH_API_VERSION,
      maxBytes: config.MEDIA_MAX_BYTES,
    }),
    store: fsMediaStore(config.MEDIA_DIR),
  },
  tax: {
    defaultRegime: config.TAX_DEFAULT_REGIME,
    noticeLocalTime: config.TAX_NOTICE_LOCAL_TIME,
    reportLinkTtlMinutes: config.REPORT_LINK_TTL_MINUTES,
    links: linkSigner({
      key: linkKeyFromBase64(config.REPORT_LINK_KEY),
      baseUrl: config.PUBLIC_BASE_URL,
      reportTtlMinutes: config.REPORT_LINK_TTL_MINUTES,
      evidenceTtlHours: config.EVIDENCE_LINK_TTL_HOURS,
    }),
  },
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
// F9: one tick a minute sends the summaries that are due (spec: within 5 minutes).
const SUMMARY_TICK_QUEUE = "summaries.tick";
await boss.createQueue(SUMMARY_TICK_QUEUE);
await boss.schedule(SUMMARY_TICK_QUEUE, "* * * * *");
await boss.work(SUMMARY_TICK_QUEUE, async () => {
  await runDueSummaries(deps, new Date());
});
// Flow E: month-end tax notices, checked every 10 minutes (they go out on the 1st).
const TAX_NOTICE_TICK_QUEUE = "tax_notices.tick";
await boss.createQueue(TAX_NOTICE_TICK_QUEUE);
await boss.schedule(TAX_NOTICE_TICK_QUEUE, "*/10 * * * *");
await boss.work(TAX_NOTICE_TICK_QUEUE, async () => {
  await runDueTaxNotices(deps, new Date());
});
console.log(JSON.stringify({ level: "info", event: "worker.started", queues: [WA_INBOUND_QUEUE, SUMMARY_TICK_QUEUE, TAX_NOTICE_TICK_QUEUE] }));
