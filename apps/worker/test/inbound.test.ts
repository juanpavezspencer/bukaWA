import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  auditLog,
  businesses,
  decryptPii,
  hashPii,
  messages,
  onboardingSessions,
  piiKeysFromBase64,
  rows,
  users,
  waInbound,
  withBusiness,
  type Db,
} from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { trialBalance } from "@bukuwa/ledger";
import { messageText, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const NOW = new Date("2026-11-12T17:30:00Z"); // 00:30 WIB on 13 Nov: UTC and Jakarta dates differ

class FakeSender implements WaSender {
  sent: Array<{ to: string; msg: OutboundMessage }> = [];
  fail = false;
  async send(to: string, msg: OutboundMessage) {
    if (this.fail) throw new Error("graph api down");
    this.sent.push({ to, msg });
    return `wamid.out.${this.sent.length}`;
  }
  lastBody() {
    return messageText(this.sent.at(-1)!.msg);
  }
}

let db: Db;
let sender: FakeSender;
let deps: InboundDeps;
let seq = 0;

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  deps = {
    db,
    sender,
    keys,
    ai: { model: new ScriptedModel(), config: aiConfig },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "2026-11-v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => NOW,
    log: () => {},
  };
});

/** Simulate the webhook storing a message, then the worker processing it. */
async function say(input: { text?: string; replyId?: string; title?: string }, from = RINA): Promise<string> {
  const id = `wamid.in.${++seq}`;
  const payload = input.replyId
    ? { id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: input.replyId, title: input.title ?? input.replyId } } }
    : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
  return id;
}

async function onboardRina(cash = "1,5jt") {
  await say({ text: "halo" });
  await say({ replyId: "consent_yes", title: "Setuju" });
  await say({ text: "Catering Bu Rina" });
  await say({ replyId: "type_fnb", title: "Makanan & minuman" });
  await say({ text: cash });
  await say({ replyId: "confirm_ok", title: "OK, benar" });
}

async function rinaBusinessId(): Promise<string> {
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
  return b!.id;
}

describe("WhatsApp onboarding (F1)", () => {
  it("creates a live business with consent, encrypted phone, chart of accounts and opening cash", async () => {
    await onboardRina();

    const bizId = await rinaBusinessId();
    const result = await withBusiness(db, bizId, async (tx) => ({
      biz: (await tx.select().from(businesses))[0]!,
      owner: (await tx.select().from(users))[0]!,
      accounts: await tx.select().from(accounts),
      tb: await trialBalance(tx, bizId),
      audit: await tx.select().from(auditLog),
    }));

    expect(result.biz).toMatchObject({ name: "Catering Bu Rina", type: "fnb", plan: "trial", timezone: "Asia/Jakarta" });
    expect(result.biz.trialEndsAt!.toISOString()).toBe("2026-11-26T17:30:00.000Z");
    expect(result.owner.role).toBe("owner");
    expect(result.owner.consentVersion).toBe("2026-11-v1");
    expect(result.owner.consentAt!.toISOString()).toBe(NOW.toISOString());
    expect(decryptPii(keys, result.owner.phoneEnc)).toBe(`+${RINA}`);
    expect(result.accounts).toHaveLength(19);

    expect(result.tb.balanced).toBe(true);
    expect(Object.fromEntries(result.tb.rows.map((r) => [r.code, r.balance]))).toEqual({
      "1100": 1_500_000n,
      "3100": -1_500_000n,
    });
    expect(result.audit.map((a) => a.action).sort()).toEqual(["business.create", "consent.given", "journal.post"]);

    expect(sender.sent.every((s) => s.to === `+${RINA}`)).toBe(true);
    expect(sender.lastBody()).toContain("Catering Bu Rina sudah aktif");
    expect(sender.lastBody()).toContain("Rp 1.500.000");
    expect(await db.select().from(onboardingSessions)).toEqual([]);
  });

  it("dates the opening journal in Jakarta time", async () => {
    await onboardRina();
    const bizId = await rinaBusinessId();
    const r = await withBusiness(db, bizId, (tx) => tx.execute(sql`select date::text as d from journals`));
    expect(rows<{ d: string }>(r)[0]!.d).toBe("2026-11-13");
  });

  it("posts no journal when opening cash is 0", async () => {
    await onboardRina("0");
    const bizId = await rinaBusinessId();
    const tb = await withBusiness(db, bizId, (tx) => trialBalance(tx, bizId));
    expect(tb.rows).toEqual([]);
    expect(sender.lastBody()).not.toContain("Saldo kas awal");
  });

  it("stores nothing in tenant tables before the owner confirms", async () => {
    await say({ text: "halo" });
    await say({ replyId: "consent_yes" });
    await say({ text: "Catering Bu Rina" });
    expect(rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from businesses`))[0]!.n).toBe(0);
    const [session] = await db.select().from(onboardingSessions);
    expect(session).toMatchObject({ step: "awaiting_type", data: { name: "Catering Bu Rina" } });
    expect(session!.phoneHash).not.toContain(RINA);
  });

  it("forgets the session when consent is declined", async () => {
    await say({ text: "halo" });
    await say({ replyId: "consent_no", title: "Tidak" });
    expect(await db.select().from(onboardingSessions)).toEqual([]);
    expect(rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from users`))[0]!.n).toBe(0);
    await say({ text: "halo lagi" });
    expect(sender.sent.at(-1)!.msg.kind).toBe("buttons");
  });

  it("processes each inbound message at most once", async () => {
    const id = await say({ text: "halo" });
    const before = sender.sent.length;
    await processInbound(deps, id);
    expect(sender.sent.length).toBe(before);
    const [session] = await db.select().from(onboardingSessions);
    expect(session!.step).toBe("awaiting_consent");
  });

  it("keeps two owners onboarding at the same time apart", async () => {
    const DIMAS = "6289876543210";
    await say({ text: "halo" });
    await say({ text: "halo" }, DIMAS);
    await say({ replyId: "consent_yes" });
    await say({ replyId: "consent_yes" }, DIMAS);
    await say({ text: "Catering Bu Rina" });
    await say({ text: "Dimas Fashion" }, DIMAS);
    await say({ replyId: "type_fnb" });
    await say({ replyId: "type_fashion" }, DIMAS);
    await say({ text: "1jt" });
    await say({ text: "2jt" }, DIMAS);
    await say({ replyId: "confirm_ok" });
    await say({ replyId: "confirm_ok" }, DIMAS);
    const names = rows<{ name: string }>(await db.execute(sql`select name from businesses order by name`)).map((r) => r.name);
    expect(names).toEqual(["Catering Bu Rina", "Dimas Fashion"]);
  });

  it("recognises an onboarded owner and logs the conversation to messages", async () => {
    await onboardRina();
    (deps.ai.model as ScriptedModel).set("makasih ya", { intent: "chitchat" });
    const id = await say({ text: "makasih ya" });
    expect(sender.lastBody()).toMatch(/Kirim transaksi kapan aja/);
    expect(await db.select().from(onboardingSessions)).toEqual([]);
    const bizId = await rinaBusinessId();
    const logged = await withBusiness(db, bizId, (tx) => tx.select().from(messages).where(eq(messages.waMessageId, id)));
    expect(logged).toMatchObject([{ direction: "inbound", body: "makasih ya" }]);
  });

  it("never calls the model during onboarding", async () => {
    await onboardRina();
    expect((deps.ai.model as ScriptedModel).calls).toEqual([]);
  });

  it("still marks the message processed when the reply fails to send", async () => {
    sender.fail = true;
    const id = await say({ text: "halo" });
    const [row] = await db.select().from(waInbound).where(eq(waInbound.waMessageId, id));
    expect(row!.processedAt).not.toBeNull();
  });
});
