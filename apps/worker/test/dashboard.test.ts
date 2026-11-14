import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  businesses,
  exchangeAdminLoginToken,
  exchangeLoginToken,
  hashPii,
  messages,
  onboardingSessions,
  piiKeysFromBase64,
  waInbound,
  withBusiness,
  type Db,
} from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import type { OutboundMessage, WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

/* Milestone 7: magic-link login sent via WhatsApp. */

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const STAFF = "6281999000111";
const STRANGER = "6281888000222";
const NOW = new Date("2026-11-13T03:00:00Z");

let db: Db;
let sent: Array<{ to: string; msg: OutboundMessage }>;
let deps: InboundDeps;
let seq = 0;

const sender: WaSender = {
  async send(to, msg) {
    sent.push({ to, msg });
    return undefined;
  },
};

async function say(from: string, input: { text?: string; replyId?: string }) {
  const id = `wamid.dash.${++seq}`;
  const payload = input.replyId
    ? { id, from, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
    : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
}
const lastBody = () => {
  const m = sent.at(-1)!.msg;
  return m.kind === "template" ? "" : m.body;
};
const tokenIn = (body: string, path: string) => new RegExp(`https://app\\.bukuwa\\.test${path}#t=([\\w-]+)`).exec(body)?.[1];

beforeEach(async () => {
  ({ db } = await createTestDb());
  sent = [];
  deps = {
    db,
    sender,
    keys,
    ai: { model: new ScriptedModel(), config: aiConfig },
    dashboard: { webBaseUrl: "https://app.bukuwa.test/", loginTtlMinutes: 15, adminLoginTtlMinutes: 10, adminPhoneHashes: new Set([hashPii(keys, `+${STAFF}`)]) },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => NOW,
    log: () => {},
  };
  for (const s of [{ text: "halo" }, { replyId: "consent_yes" }, { text: "Catering Bu Rina" }, { replyId: "type_fnb" }, { text: "0" }, { replyId: "confirm_ok" }]) await say(RINA, s);
});

describe("dashboard login from WhatsApp", () => {
  it.each(["dashboard", "Minta link dashboard dong", "login", "masuk"])("%j sends a one-time link that opens a session", async (text) => {
    await say(RINA, { text });
    const token = tokenIn(lastBody(), "/masuk");
    expect(token).toBeDefined();
    expect(lastBody()).toContain("Berlaku 15 menit");
    const s = await exchangeLoginToken(db, token!, new Date(NOW.getTime() + 60_000), 7 * 86_400_000);
    const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
    expect(s?.businessId).toBe(b!.id);
  });

  it("keeps the token out of the messages log", async () => {
    await say(RINA, { text: "dashboard" });
    const token = tokenIn(lastBody(), "/masuk")!;
    const [b] = await db.select().from(businesses);
    const logged = await withBusiness(db, b!.id, (tx) => tx.select({ body: messages.body }).from(messages).where(eq(messages.direction, "outbound")));
    expect(logged.map((m) => m.body).join("\n")).not.toContain(token);
    expect(logged.at(-1)!.body).toContain("#t=[redacted]");
  });

  it("says 'coming soon' when the dashboard isn't configured", async () => {
    deps.dashboard = undefined;
    await say(RINA, { text: "dashboard" });
    expect(lastBody()).toContain("segera hadir");
  });
});

describe("admin login", () => {
  it("sends an admin link to an allowlisted number without onboarding it", async () => {
    await say(STAFF, { text: "admin" });
    const token = tokenIn(lastBody(), "/admin/masuk");
    expect(token).toBeDefined();
    expect(await exchangeAdminLoginToken(db, token!, NOW, 3_600_000)).toMatchObject({ phoneHash: hashPii(keys, `+${STAFF}`) });
    expect(await db.select().from(onboardingSessions)).toEqual([]);
  });

  it("treats 'admin' from anyone else as a normal message", async () => {
    await say(STRANGER, { text: "admin" });
    expect(lastBody()).not.toContain("/admin/masuk");
    expect(await db.select().from(onboardingSessions)).toHaveLength(1);
  });
});
