import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, hashPii, piiKeysFromBase64, usageEvents, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { pricingFromEnv } from "@bukuwa/ai";
import { messageText, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { localStart } from "../src/usage.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const NOW = new Date("2026-11-12T05:00:00Z"); // 12:00 WIB

class FakeSender implements WaSender {
  sent: OutboundMessage[] = [];
  async send(_to: string, msg: OutboundMessage) {
    this.sent.push(msg);
    return `wamid.out.${this.sent.length}`;
  }
}

let db: Db;
let sender: FakeSender;
let model: ScriptedModel;
let deps: InboundDeps;
let logs: Array<Record<string, unknown>>;
let seq = 0;

async function say(input: { text?: string; replyId?: string }): Promise<void> {
  const id = `wamid.in.${++seq}`;
  const payload = input.replyId
    ? { id, from: RINA, type: "interactive", interactive: { type: "button_reply", button_reply: { id: input.replyId, title: input.replyId } } }
    : { id, from: RINA, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: RINA, type: payload.type, payload });
  await processInbound(deps, id);
}

async function onboard(): Promise<string> {
  for (const m of [{ text: "halo" }, { replyId: "consent_yes" }, { text: "Catering Bu Rina" }, { replyId: "type_fnb" }, { text: "0" }, { replyId: "confirm_ok" }]) await say(m);
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
  return b!.id;
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  model = new ScriptedModel({ halo2: { intent: "chitchat" }, "jual 10rb cash": { intent: "transaction", entries: [{ kind: "sale", amount_text: "10rb", payment_text: "cash" }] } });
  logs = [];
  deps = {
    db,
    sender,
    keys,
    ai: { model, config: aiConfig },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "2026-11-v1", trialDays: 14, timezone: "Asia/Jakarta" },
    metering: { pricing: pricingFromEnv({ IDR_PER_USD: "16000" }), monthlyAlertIdr: 1n },
    limits: { dailyInbound: 1000 },
    now: () => NOW,
    log: (e) => logs.push(e),
  };
});

describe("cost metering", () => {
  it("records each model call against the business, priced in micro-rupiah", async () => {
    const biz = await onboard();
    await say({ text: "jual 10rb cash" }); // router + extractor
    const events = await withBusiness(db, biz, (tx) => tx.select().from(usageEvents));
    expect(events).toHaveLength(2);
    // Haiku: 1000*100 + 100*500 = 150,000; x16000 / 1000 = 2,400,000 micro-IDR = Rp 2,4 per call.
    expect(events.map((e) => e.costMicroIdr)).toEqual([2_400_000n, 2_400_000n]);
    expect(events[0]).toMatchObject({ model: "claude-haiku-5-5", kind: "llm", inputTokens: 1000, outputTokens: 100, waMessageId: `wamid.in.${seq}` });
  });

  it("records nothing for messages that need no model (onboarding, buttons)", async () => {
    const biz = await onboard();
    expect(await withBusiness(db, biz, (tx) => tx.select().from(usageEvents))).toHaveLength(0);
  });

  it("warns once when the month's cost crosses the alert line", async () => {
    await onboard();
    await say({ text: "halo2" }); // Rp 2,4: crosses Rp 1
    await say({ text: "halo2" });
    expect(logs.filter((e) => e.event === "cost.over_budget")).toHaveLength(1);
  });
});

describe("daily message cap", () => {
  it("answers once at the cap, then stays quiet and makes no model calls until the next day", async () => {
    await onboard(); // only the final confirm is logged to the business
    deps.limits = { dailyInbound: 2 };
    await say({ text: "halo2" }); // 2nd today: normal
    const before = model.calls.length;
    sender.sent = [];
    await say({ text: "halo2" }); // 3rd: at cap
    expect(sender.sent.map(messageText)).toEqual([expect.stringMatching(/istirahat dulu sampai besok/)]);
    await say({ text: "halo2" });
    expect(sender.sent).toHaveLength(1);
    expect(model.calls.length).toBe(before);

    deps.now = () => new Date(NOW.getTime() + 86_400_000);
    await say({ text: "halo2" });
    expect(model.calls.length).toBe(before + 1);
  });

  it("still accepts button taps over the cap", async () => {
    await onboard();
    deps.limits = { dailyInbound: 1 };
    await say({ replyId: "cap:ok:00000000-0000-0000-0000-000000000000" });
    expect(logs.some((e) => e.event === "inbound.daily_cap")).toBe(false);
  });
});

describe("localStart", () => {
  it("finds the start of the local day and month in Jakarta", () => {
    expect(localStart(new Date("2026-11-12T17:30:00Z"), "Asia/Jakarta", "day").toISOString()).toBe("2026-11-12T17:00:00.000Z");
    expect(localStart(new Date("2026-11-12T17:30:00Z"), "Asia/Jakarta", "month").toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });
});
