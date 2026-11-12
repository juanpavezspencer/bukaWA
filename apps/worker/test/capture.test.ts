import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  businesses,
  captures,
  categoryRules,
  hashPii,
  journals,
  piiKeysFromBase64,
  rows,
  waInbound,
  withBusiness,
  type Db,
} from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { ModelRefusalError } from "@bukuwa/ai";
import { trialBalance } from "@bukuwa/ledger";
import type { OutboundMessage, WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const NOW = new Date("2026-11-12T03:00:00Z"); // 10:00 WIB, Thursday 12 Nov

class FakeSender implements WaSender {
  sent: OutboundMessage[] = [];
  async send(_to: string, msg: OutboundMessage) {
    this.sent.push(msg);
    return undefined;
  }
  last() {
    return this.sent.at(-1)!;
  }
  /** Reply id of the button or list row with this title in the last message. */
  button(title: string): string {
    const m = this.last();
    const opts = m.kind === "buttons" ? m.buttons : m.kind === "list" ? m.rows : [];
    const hit = opts.find((o) => o.title === title);
    if (!hit) throw new Error(`no "${title}" option in: ${m.body}`);
    return hit.id;
  }
}

let db: Db;
let sender: FakeSender;
let model: ScriptedModel;
let deps: InboundDeps;
let bizId: string;
let seq = 0;

async function say(input: { text?: string; replyId?: string; type?: string }): Promise<string> {
  const id = `wamid.cap.${++seq}`;
  const payload =
    input.type === "image" ? { id, from: RINA, type: "image", image: { id: "media1" } }
    : input.replyId ? { id, from: RINA, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
    : { id, from: RINA, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: RINA, type: payload.type, payload });
  await processInbound(deps, id);
  return id;
}

async function ledger() {
  return withBusiness(db, bizId, async (tx) => {
    const tb = await trialBalance(tx, bizId);
    const all = await tx.select().from(journals);
    return { tb, byCode: Object.fromEntries(tb.rows.map((r) => [r.code, r.balance])), journals: all };
  });
}

async function latestCapture() {
  return withBusiness(db, bizId, async (tx) => {
    const r = await tx.select().from(captures).orderBy(sql`created_at desc`).limit(1);
    return r[0]!;
  });
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  model = new ScriptedModel();
  deps = {
    db,
    sender,
    keys,
    ai: { model, config: aiConfig },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => NOW,
    log: () => {},
  };
  // Onboard with zero opening cash so the ledger starts empty.
  await say({ text: "halo" });
  await say({ replyId: "consent_yes" });
  await say({ text: "Catering Bu Rina" });
  await say({ replyId: "type_fnb" });
  await say({ text: "0" });
  await say({ replyId: "confirm_ok" });
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
  bizId = b!.id;
  sender.sent = [];
});

const NASI = "jual nasi box 25 x 18rb transfer BCA";
function scriptNasi() {
  model.set(NASI, {
    intent: "transaction",
    entries: [
      {
        kind: "sale",
        description: "Jual nasi box",
        items: [{ name: "nasi box", qty_text: "25", unit: null, unit_price_text: "18rb", line_total_text: null }],
        payment_text: "transfer BCA",
        suggested_category: "Penjualan",
      },
    ],
  });
}

describe("text capture (F2) with confirm-before-post (F5)", () => {
  it("shows a confirm card and posts nothing until OK", async () => {
    scriptNasi();
    await say({ text: NASI });

    const card = sender.last();
    expect(card.kind).toBe("buttons");
    expect(card.body).toContain("Pemasukan Rp 450.000 (transfer BCA), 12 Nov");
    expect(card.body).toContain("• nasi box 25 x Rp 18.000 = Rp 450.000");
    expect(card.body).toContain("Kategori: Penjualan");
    expect(card.kind === "buttons" && card.buttons.map((b) => b.title)).toEqual(["OK", "Ubah", "Batal"]);
    expect((await ledger()).journals).toHaveLength(0);
    expect(await latestCapture()).toMatchObject({ status: "awaiting_confirmation", source: "text", rawText: NASI });
    expect((await latestCapture()).modelVersion).toBe("claude-haiku-5-5/extractor-v1");

    await say({ replyId: sender.button("OK") });
    const l = await ledger();
    expect(l.tb.balanced).toBe(true);
    expect(l.byCode).toEqual({ "1110": 450_000n, "4100": -450_000n });
    expect(sender.last().body).toContain("tercatat");
    expect(sender.last().body).toContain("pemasukan Rp 450.000");
    const cap = await latestCapture();
    expect(cap.status).toBe("confirmed");
    expect(cap.journalId).toBe(l.journals[0]!.id);
  });

  it("posts once even if OK is tapped twice", async () => {
    scriptNasi();
    await say({ text: NASI });
    const ok = sender.button("OK");
    await say({ replyId: ok });
    await say({ replyId: ok });
    expect((await ledger()).journals).toHaveLength(1);
    expect(sender.last().body).toMatch(/sudah diproses/);
  });

  it("Batal and Ubah cancel without posting", async () => {
    scriptNasi();
    await say({ text: NASI });
    await say({ replyId: sender.button("Batal") });
    expect(sender.last().body).toMatch(/dibatalkan/);
    expect((await latestCapture()).status).toBe("cancelled");

    await say({ text: NASI });
    await say({ replyId: sender.button("Ubah") });
    expect(sender.last().body).toMatch(/kirim lagi versi yang benar/);
    expect((await ledger()).journals).toHaveLength(0);
  });

  it("records a multi-item expense from one message (Flow B)", async () => {
    const msg = "tadi belanja ayam 5 kilo 175 ribu, minyak 2 liter 38 ribu, cash";
    model.set(msg, {
      intent: "transaction",
      entries: [
        {
          kind: "expense",
          description: "Belanja bahan",
          items: [
            { name: "ayam", qty_text: "5", unit: "kilo", unit_price_text: null, line_total_text: "175 ribu" },
            { name: "minyak", qty_text: "2", unit: "liter", unit_price_text: null, line_total_text: "38 ribu" },
          ],
          date_text: "tadi",
          payment_text: "cash",
          suggested_category: "HPP / Bahan baku",
        },
      ],
    });
    await say({ text: msg });
    const card = sender.last().body;
    expect(card).toContain("Pengeluaran Rp 213.000 (cash), 12 Nov");
    expect(card).toContain("• ayam 5 kilo Rp 175.000");
    expect(card).toContain("• minyak 2 liter Rp 38.000");
    expect(card).toContain("Kategori: HPP / Bahan baku");
    await say({ replyId: sender.button("OK") });
    expect((await ledger()).byCode).toEqual({ "1100": -213_000n, "5100": 213_000n });
  });

  it("asks for the payment method instead of guessing", async () => {
    model.set("jual kue 50rb", { intent: "transaction", entries: [{ kind: "sale", description: "Jual kue", amount_text: "50rb" }] });
    await say({ text: "jual kue 50rb" });
    expect(sender.last().kind).toBe("list");
    expect(sender.last().body).toMatch(/Dibayar pakai apa/);
    expect((await latestCapture()).status).toBe("extracted");

    await say({ replyId: sender.button("Cash") });
    expect(sender.last().body).toContain("Pemasukan Rp 50.000 (cash)");
    await say({ replyId: sender.button("OK") });
    expect((await ledger()).byCode["1100"]).toBe(50_000n);
  });

  it("accepts a typed payment answer without calling the model again", async () => {
    model.set("jual kue 50rb", { intent: "transaction", entries: [{ kind: "sale", description: "Jual kue", amount_text: "50rb" }] });
    await say({ text: "jual kue 50rb" });
    const calls = model.calls.length;
    await say({ text: "gopay" });
    expect(model.calls.length).toBe(calls);
    expect(sender.last().body).toContain("Pemasukan Rp 50.000 (GoPay)");
  });

  it("asks for a missing amount and uses the typed answer", async () => {
    model.set("jual kue cash", { intent: "transaction", entries: [{ kind: "sale", description: "Jual kue" }] });
    await say({ text: "jual kue cash" });
    expect(sender.last().body).toMatch(/Nominalnya berapa/);
    const calls = model.calls.length;
    await say({ text: "goceng" });
    expect(model.calls.length).toBe(calls);
    expect(sender.last().body).toContain("Pemasukan Rp 5.000 (cash)");
  });

  it("learns the category from a confirmed entry (F6)", async () => {
    model.set("belanja ayam 175rb cash", {
      intent: "transaction",
      entries: [{ kind: "expense", description: "Belanja ayam", amount_text: "175rb", items: [{ name: "ayam", qty_text: null, unit: null, unit_price_text: null, line_total_text: "175rb" }], suggested_category: "HPP / Bahan baku" }],
    });
    await say({ text: "belanja ayam 175rb cash" });
    await say({ replyId: sender.button("OK") });
    const rules = await withBusiness(db, bizId, (tx) => tx.select().from(categoryRules));
    expect(rules.map((r) => r.pattern)).toEqual(["ayam"]);

    // Next time the model guesses wrong, the learned rule wins.
    model.set("ayam 2kg 80rb cash", {
      intent: "transaction",
      entries: [{ kind: "expense", description: "Ayam", amount_text: "80rb", items: [{ name: "ayam", qty_text: "2", unit: "kg", unit_price_text: null, line_total_text: "80rb" }], suggested_category: "Lain-lain" }],
    });
    await say({ text: "ayam 2kg 80rb cash" });
    expect(sender.last().body).toContain("Kategori: HPP / Bahan baku");
    await say({ replyId: sender.button("OK") });
    const after = await withBusiness(db, bizId, (tx) => tx.select().from(categoryRules));
    expect(after[0]!.hits).toBe(2);
  });

  it("answers non-transaction intents without creating a capture", async () => {
    model.set("untung minggu ini berapa?", { intent: "question" });
    await say({ text: "untung minggu ini berapa?" });
    expect(sender.last().body).toMatch(/lagi disiapin/);
    const n = await withBusiness(db, bizId, async (tx) => (await tx.select().from(captures)).length);
    expect(n).toBe(0);
  });

  it("does not post kinds handled in later milestones", async () => {
    model.set("Bu Sari utang 350rb", { intent: "transaction", entries: [{ kind: "receivable", description: "Piutang Bu Sari", amount_text: "350rb", counterparty: "Bu Sari" }] });
    await say({ text: "Bu Sari utang 350rb" });
    expect(sender.last().body).toMatch(/Utang-piutang/);
    expect((await latestCapture()).status).toBe("failed");
    expect((await ledger()).journals).toHaveLength(0);
  });

  it("replies politely to a model refusal and does not retry", async () => {
    model.failWith = new ModelRefusalError("cyber");
    const id = await say({ text: "something odd" });
    expect(sender.last().body).toMatch(/belum ngerti/);
    const [row] = await db.select().from(waInbound).where(eq(waInbound.waMessageId, id));
    expect(row!.processedAt).not.toBeNull();
  });

  it("leaves the message unprocessed on API errors so the job retries", async () => {
    model.failWith = new Error("overloaded");
    const id = `wamid.cap.err`;
    await db.insert(waInbound).values({ waMessageId: id, fromPhone: RINA, type: "text", payload: { id, from: RINA, type: "text", text: { body: "jual 10rb" } } });
    await expect(processInbound(deps, id)).rejects.toThrow("overloaded");
    const [row] = await db.select().from(waInbound).where(eq(waInbound.waMessageId, id));
    expect(row!.processedAt).toBeNull();
  });

  it("tells the owner photos and voice notes are coming", async () => {
    await say({ type: "image" });
    expect(sender.last().body).toMatch(/Foto nota/);
    expect(model.calls).toHaveLength(0);
  });

  it("never sends a NIK to the model", async () => {
    const msg = "bayar pajak 500rb cash nik 3174012345678901";
    model.set("bayar pajak 500rb cash nik [ID]", { intent: "chitchat" });
    await say({ text: msg });
    expect(model.calls.every((c) => !c.user.includes("3174012345678901"))).toBe(true);
  });

  it("keeps each business's captures and rules apart", async () => {
    scriptNasi();
    await say({ text: NASI });
    const r = await db.execute(sql`select count(*)::int as n from captures`);
    expect(rows<{ n: number }>(r)[0]!.n).toBe(1);
    const other = await withBusiness(db, "00000000-0000-4000-8000-000000000099", (tx) => tx.select().from(captures));
    expect(other).toEqual([]);
  });
});
