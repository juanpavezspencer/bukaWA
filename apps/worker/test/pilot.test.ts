import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, hashPii, onboardingSessions, piiKeysFromBase64, pilotInvites, waInbound, withAdmin, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { messageText, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { onboardingStep } from "../src/onboarding.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const NOW = new Date("2026-11-12T05:00:00Z");

class FakeSender implements WaSender {
  sent: OutboundMessage[] = [];
  async send(_to: string, msg: OutboundMessage) {
    this.sent.push(msg);
    return "wamid.out";
  }
  last() {
    return messageText(this.sent.at(-1)!);
  }
}

let db: Db;
let sender: FakeSender;
let deps: InboundDeps;
let seq = 0;

async function say(from: string, input: { text?: string; replyId?: string }) {
  const id = `wamid.in.${++seq}`;
  const payload = input.replyId
    ? { id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: input.replyId, title: input.replyId } } }
    : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
}

async function finishOnboarding(from: string) {
  for (const m of [{ replyId: "consent_yes" }, { text: "Warung Pilot" }, { replyId: "type_retail" }, { text: "0" }, { replyId: "confirm_ok" }]) await say(from, m);
}

const businessOf = async (phone: string) =>
  (await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${phone}`))))[0];

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  deps = {
    db,
    sender,
    keys,
    ai: { model: new ScriptedModel(), config: aiConfig },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "2026-11-v1", trialDays: 14, timezone: "Asia/Jakarta" },
    pilot: { inviteRequired: true },
    now: () => NOW,
    log: () => {},
  };
  await withAdmin(db, (tx) => tx.insert(pilotInvites).values({ code: "BUKU42", cohort: "bandung-fnb", maxUses: 1, createdBy: "admin" }));
});

describe("pilot invite codes", () => {
  it("asks for a code first, then onboards with the cohort and counts the use", async () => {
    await say("6281200000001", { text: "halo" });
    expect(sender.last()).toMatch(/kode undangan/);
    await say("6281200000001", { text: "kode buku42" });
    expect(sender.last()).toMatch(/izin kamu/);
    await finishOnboarding("6281200000001");

    expect(await businessOf("6281200000001")).toMatchObject({ cohort: "bandung-fnb", inviteCode: "BUKU42" });
    const [inv] = await withAdmin(db, (tx) => tx.select().from(pilotInvites));
    expect(inv!.uses).toBe(1);
  });

  it("accepts the code in the very first message (wa.me link with prefilled text)", async () => {
    await say("6281200000002", { text: "Halo, mau daftar. KODE BUKU42" });
    expect(sender.last()).toMatch(/izin kamu/);
  });

  it("refuses a wrong code, then locks after five tries", async () => {
    await say("6281200000003", { text: "halo" });
    for (let i = 0; i < 4; i++) await say("6281200000003", { text: "SALAH1" });
    expect(sender.last()).toMatch(/sisa 1 kali/);
    await say("6281200000003", { text: "SALAH1" });
    expect(sender.last()).toMatch(/Hubungi tim/);
    const n = sender.sent.length;
    await say("6281200000003", { text: "BUKU42" }); // even the right code is ignored while locked
    expect(sender.sent.length).toBe(n);

    deps.now = () => new Date(NOW.getTime() + 2 * 86_400_000);
    await say("6281200000003", { text: "BUKU42" });
    expect(sender.last()).toMatch(/izin kamu/);
  });

  it("gives the last seat to whoever finishes first", async () => {
    await say("6281200000004", { text: "KODE BUKU42" });
    await say("6281200000005", { text: "KODE BUKU42" });
    await finishOnboarding("6281200000004");
    await finishOnboarding("6281200000005");
    expect(await businessOf("6281200000004")).toBeDefined();
    expect(await businessOf("6281200000005")).toBeUndefined();
    expect(sender.last()).toMatch(/kuota kode undangannya baru aja habis/);
    const [s] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.phoneHash, hashPii(keys, "+6281200000005")));
    expect(s!.step).toBe("awaiting_invite");
  });

  it("skips the code when the pilot gate is off", () => {
    const r = onboardingStep({ step: "new" }, { text: "halo" }, { privacyPolicyUrl: "https://x", invite: { required: false, found: null } });
    expect(r.state.step).toBe("awaiting_consent");
  });
});
