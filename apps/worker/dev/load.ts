/**
 * DEV ONLY. Load test for the inbound pipeline (spec 9.3, week 10).
 *
 * Drives the real processInbound (onboarding, capture, confirm, metering,
 * daily cap) for many businesses at once, with a stand-in model that sleeps
 * like the real one and reports usage, then checks the books still balance
 * and every model call was metered.
 *
 *   pnpm --filter @bukuwa/worker load                       # in-process PGlite
 *   LOAD_BUSINESSES=200 LOAD_CONCURRENCY=32 pnpm --filter @bukuwa/worker load
 *   DATABASE_URL=postgres://... LOAD_TEST_ALLOW_DB=1 pnpm --filter @bukuwa/worker load
 *
 * PGlite is one connection, so it measures the code path, not Postgres under
 * contention. For real numbers point DATABASE_URL at a migrated SCRATCH
 * database (never production: the script writes test businesses).
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "@bukuwa/db";
import { businesses, hashPii, piiKeysFromBase64, rows, usageEvents, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { trialBalance } from "@bukuwa/ledger";
import { aiConfigFromEnv, pricingFromEnv, recordUsage, type StructuredModel } from "@bukuwa/ai";
import type { OutboundMessage, WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { offlineModel } from "./offline-model.js";

const N = Number(process.env.LOAD_BUSINESSES ?? 50);
const TX_PER_BUSINESS = Number(process.env.LOAD_TX_PER_BUSINESS ?? 10);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 16);
const MODEL_MS = Number(process.env.LOAD_MODEL_LATENCY_MS ?? 800);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: Db;
let close = async () => {};
if (process.env.DATABASE_URL) {
  if (process.env.LOAD_TEST_ALLOW_DB !== "1") {
    console.error("Refusing to write test businesses to DATABASE_URL without LOAD_TEST_ALLOW_DB=1 (use a scratch database).");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCY + 2 });
  db = drizzle(pool, { schema }) as unknown as Db;
  close = () => pool.end();
} else {
  ({ db } = await createTestDb());
}

// Real latency and token counts, keyword answers. Usage is what a Haiku router + extractor call reports.
const model: StructuredModel = {
  async generate(req) {
    await sleep(MODEL_MS * (0.5 + Math.random()));
    const r = await offlineModel.generate(req);
    recordUsage("claude-haiku-5-5", { inputTokens: 1800, outputTokens: 150, cacheReadTokens: 1200, cacheWriteTokens: 0 });
    return r;
  },
};

let sent = 0;
const lastSent = new Map<string, OutboundMessage>();
const sender: WaSender = {
  async send(to, msg) {
    lastSent.set(to.replace(/\D/g, ""), msg);
    await sleep(80 + Math.random() * 120); // Cloud API round trip
    return `wamid.load.out.${++sent}`;
  },
};

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const deps: InboundDeps = {
  db,
  sender,
  keys,
  ai: { model, config: aiConfigFromEnv({}) },
  config: { privacyPolicyUrl: "https://bukuwa.test/privasi", consentVersion: "load", trialDays: 14, timezone: "Asia/Jakarta" },
  metering: { pricing: pricingFromEnv({}), monthlyAlertIdr: 3000n },
  limits: { dailyInbound: 300 },
  log: (e) => {
    if (e.level === "error") console.error(JSON.stringify(e));
  },
};

const run = randomBytes(3).toString("hex");
const PHONE_PREFIX = String(10 + (randomBytes(1)[0]! % 90)); // a fresh number range per run
let seq = 0;
type Kind = "onboarding" | "text" | "button";
const timings: Record<Kind, number[]> = { onboarding: [], text: [], button: [] };
let failures = 0;

async function say(from: string, kind: Kind, input: { text?: string; replyId?: string }) {
  const id = `wamid.load.${run}.${++seq}`;
  const payload = input.replyId
    ? { id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: input.replyId, title: "x" } } }
    : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  const t0 = performance.now();
  try {
    await processInbound(deps, id);
    timings[kind].push(performance.now() - t0);
  } catch (err) {
    failures++;
    console.error(`${kind} from ${from} failed: ${(err as Error).message}`);
  }
}

const ITEMS = ["jual nasi box", "beli beras", "jual es teh", "bayar listrik", "jual kue", "beli gas"];

/** One owner's conversation; messages from one phone are sequential, like the per-phone queue in production. */
async function owner(i: number) {
  const phone = `62813${PHONE_PREFIX}${String(i).padStart(6, "0")}`;
  for (const m of [{ text: "halo" }, { replyId: "consent_yes" }, { text: `Usaha Load ${i}` }, { replyId: "type_fnb" }, { text: "500rb" }, { replyId: "confirm_ok" }]) {
    await say(phone, "onboarding", m);
  }
  for (let t = 0; t < TX_PER_BUSINESS; t++) {
    await say(phone, "text", { text: `${ITEMS[(i + t) % ITEMS.length]} ${10 + ((i * 7 + t * 13) % 90)}rb cash` });
    // Tap the confirm button on the card the owner was just sent.
    const card = lastSent.get(phone);
    const ok = card?.kind === "buttons" ? card.buttons.find((b) => b.id.startsWith("cap:ok:")) : undefined;
    if (!ok) {
      failures++;
      console.error(`no confirm card for ${phone}: ${JSON.stringify(card).slice(0, 200)}`);
      continue;
    }
    await say(phone, "button", { replyId: ok.id });
  }
  return phone;
}

async function pool<T>(n: number, size: number, job: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, n) }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await job(i);
      }
    }),
  );
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN;
};
const fmt = (ms: number) => (ms / 1000).toFixed(2) + " s";

console.log(`load: ${N} businesses × ${TX_PER_BUSINESS} transactions, concurrency ${CONCURRENCY}, model ~${MODEL_MS} ms, db ${process.env.DATABASE_URL ? "postgres" : "pglite"}`);
const started = performance.now();
const phones = await pool(N, CONCURRENCY, owner);
const wall = performance.now() - started;

// Correctness after the storm: every business exists, balances, has the expected journals, and was metered.
const hashes = phones.map((p) => hashPii(keys, `+${p}`));
const ids = (await db.select({ id: businesses.id }).from(businesses).where(inArray(businesses.ownerPhoneHash, hashes))).map((b) => b.id);
let unbalanced = 0;
let journalsShort = 0;
for (const id of ids) {
  await withBusiness(db, id, async (tx) => {
    if (!(await trialBalance(tx, id)).balanced) unbalanced++;
    const [j] = rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from journals where business_id = ${id}`));
    if (j!.n !== TX_PER_BUSINESS + 1) journalsShort++; // + opening balance
  });
}
const metered = await Promise.all(
  ids.map((id) => withBusiness(db, id, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(usageEvents).where(eq(usageEvents.businessId, id)))[0]!.n)),
);
const textMsgs = timings.text.length;
const all = [...timings.onboarding, ...timings.text, ...timings.button];

console.log("");
console.log(`messages processed  ${all.length} in ${fmt(wall)}  (${((all.length / wall) * 1000).toFixed(1)} msg/s)`);
for (const k of ["text", "button", "onboarding"] as const) {
  console.log(`${k.padEnd(11)} p50 ${fmt(pct(timings[k], 50))}  p95 ${fmt(pct(timings[k], 95))}  p99 ${fmt(pct(timings[k], 99))}  (n=${timings[k].length})`);
}
console.log(`businesses          ${ids.length}/${N}`);
console.log(`unbalanced books    ${unbalanced}`);
console.log(`wrong journal count ${journalsShort}`);
console.log(`usage rows          ${metered.reduce((a, b) => a + b, 0)} (text messages ${textMsgs}; expect ≥ 1 per text)`);
console.log(`failures            ${failures}`);

const textP95 = pct(timings.text, 95);
const ok = failures === 0 && unbalanced === 0 && journalsShort === 0 && ids.length === N && metered.every((n) => n >= TX_PER_BUSINESS) && textP95 < 4000;
console.log(ok ? "\nPASS (text p95 under the 4 s target)" : "\nFAIL");
await close();
process.exit(ok ? 0 : 1);
