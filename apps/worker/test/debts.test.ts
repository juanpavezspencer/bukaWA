import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, contacts, hashPii, piiKeysFromBase64, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { openBalances, trialBalance } from "@bukuwa/ledger";
import type { OutboundMessage, WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { aiConfig, ScriptedModel, type Script } from "./fake-model.js";

/* F8: receivables and payables captured from chat, settled later. */

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const NOW = new Date("2026-11-12T03:00:00Z"); // 10:00 WIB, Thursday 12 Nov

class FakeSender implements WaSender {
  sent: OutboundMessage[] = [];
  async send(_to: string, msg: OutboundMessage) {
    this.sent.push(msg);
    return undefined;
  }
  /** Bot replies to an owner's message are never templates. */
  last(): Exclude<OutboundMessage, { kind: "template" }> {
    const m = this.sent.at(-1)!;
    if (m.kind === "template") throw new Error("unexpected template reply");
    return m;
  }
  button(title: string): string {
    const m = this.last();
    const opts = m.kind === "buttons" ? m.buttons : m.kind === "list" ? m.rows : [];
    const hit = opts.find((o) => o.title === title);
    if (!hit) throw new Error(`no "${title}" option in: ${m.body}`);
    return hit.id;
  }
  body() {
    return this.last().body;
  }
}

let db: Db;
let sender: FakeSender;
let model: ScriptedModel;
let deps: InboundDeps;
let bizId: string;
let seq = 0;

async function say(input: { text?: string; replyId?: string }) {
  const id = `wamid.debt.${++seq}`;
  const payload = input.replyId
    ? { id, from: RINA, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
    : { id, from: RINA, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: RINA, type: payload.type, payload });
  await processInbound(deps, id);
}

/** Script a one-entry transaction message, then send it. */
async function txn(text: string, entry: NonNullable<Script["entries"]>[number]) {
  model.set(text, { intent: "transaction", entries: [entry] });
  await say({ text });
}

async function balances() {
  return withBusiness(db, bizId, async (tx) => {
    const tb = await trialBalance(tx, bizId);
    const by = Object.fromEntries(tb.rows.map((r) => [r.code, r.balance]));
    const open = await openBalances(tx, bizId);
    return { by, open: open.map((b) => [b.name, b.kind, b.balanceIdr]), balanced: tb.balanced };
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
  for (const s of [{ text: "halo" }, { replyId: "consent_yes" }, { text: "Catering Bu Rina" }, { replyId: "type_fnb" }, { text: "0" }, { replyId: "confirm_ok" }]) {
    await say(s);
  }
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
  bizId = b!.id;
  sender.sent = [];
});

async function sariOwes350() {
  await txn("Bu Sari utang 350rb", { kind: "receivable", description: "Piutang Bu Sari", amount_text: "350rb", counterparty: "Bu Sari", suggested_category: "Penjualan" });
}

describe("receivables", () => {
  it("records a credit sale without asking how it was paid, then a payment in full", async () => {
    await sariOwes350();
    expect(sender.body()).toContain("Piutang Rp 350.000: Bu Sari belum bayar, 12 Nov");
    expect(sender.body()).toContain("Kategori: Penjualan");
    await say({ replyId: sender.button("OK") });
    expect(sender.body()).toContain("Sisa piutang Bu Sari: Rp 350.000.");
    expect(sender.body()).toContain("Hari ini: pemasukan Rp 350.000");
    expect(await balances()).toMatchObject({ by: { "1200": 350_000n, "4100": -350_000n }, open: [["Bu Sari", "receivable", 350_000n]], balanced: true });

    // "udah lunas" without an amount: the open balance is used.
    await txn("bu sari udah lunas", { kind: "settlement", description: "Pelunasan Bu Sari", counterparty: "bu sari" });
    await say({ replyId: sender.button("Cash") });
    expect(sender.body()).toContain("Pelunasan piutang Rp 350.000 dari Bu Sari (cash), 12 Nov");
    expect(sender.body()).toContain("Nominal diambil dari sisa piutang Bu Sari.");
    expect(sender.body()).toContain("Piutang Bu Sari jadi lunas ✅");
    await say({ replyId: sender.button("OK") });
    expect(sender.body()).toContain("Piutang Bu Sari lunas ✅");
    const b = await balances();
    expect(b.by["1200"] ?? 0n).toBe(0n);
    expect(b.by["1100"]).toBe(350_000n);
    expect(b.open).toEqual([]);
    // One contact, matched despite "bu sari" vs "Bu Sari".
    const all = await withBusiness(db, bizId, (tx) => tx.select().from(contacts));
    expect(all.map((c) => [c.name, c.kind])).toEqual([["Bu Sari", "customer"]]);
  });

  it("asks who owes when no name was given", async () => {
    await txn("ada yang ngutang 50rb", { kind: "receivable", description: "Piutang", amount_text: "50rb" });
    expect(sender.body()).toContain("Siapa yang belum bayar Rp 50.000?");
    await say({ text: "Pak Budi" });
    expect(sender.body()).toContain("Piutang Rp 50.000: Pak Budi belum bayar");
    await say({ replyId: sender.button("OK") });
    expect((await balances()).open).toEqual([["Pak Budi", "receivable", 50_000n]]);
  });

  it("offers to record an incoming transfer as the payment of an open debt (Flow A step 5)", async () => {
    await sariOwes350();
    await say({ replyId: sender.button("OK") });
    await txn("terima transfer 350rb dari SARI W", { kind: "sale", description: "Transfer masuk", amount_text: "350rb", counterparty: "SARI W", payment_text: "transfer" });
    expect(sender.body()).toContain("Bu Sari masih punya utang Rp 350.000 sejak 12 Nov. Ini pelunasan utang Bu Sari?");
    await say({ replyId: sender.button("Ya, pelunasan") });
    expect(sender.body()).toContain("Piutang Bu Sari lunas ✅");
    const b = await balances();
    // Income counted once, when the credit sale was made.
    expect(b.by).toMatchObject({ "4100": -350_000n, "1110": 350_000n });
    expect(b.open).toEqual([]);
  });

  it("records it as a new sale when the owner says it isn't a payment", async () => {
    await sariOwes350();
    await say({ replyId: sender.button("OK") });
    await txn("terima transfer 350rb dari SARI W", { kind: "sale", description: "Transfer masuk", amount_text: "350rb", counterparty: "SARI W", payment_text: "transfer" });
    await say({ replyId: sender.button("Bukan, jualan baru") });
    const b = await balances();
    expect(b.by["4100"]).toBe(-700_000n);
    expect(b.open).toEqual([["Bu Sari", "receivable", 350_000n]]);
  });
});

describe("payables", () => {
  it("records a purchase on credit and a partial payment", async () => {
    await txn("bon beras ke Toko Jaya 800rb", { kind: "payable", description: "Beras", amount_text: "800rb", counterparty: "Toko Jaya", suggested_category: "HPP / Bahan baku" });
    expect(sender.body()).toContain("Utang Rp 800.000 ke Toko Jaya, belum dibayar, 12 Nov");
    expect(sender.body()).toContain("Kategori: HPP / Bahan baku");
    await say({ replyId: sender.button("OK") });

    await txn("bayar utang toko jaya 300rb tf", { kind: "settlement", description: "Cicil utang", amount_text: "300rb", counterparty: "toko jaya", payment_text: "tf" });
    expect(sender.body()).toContain("Bayar utang Rp 300.000 ke Toko Jaya (transfer), 12 Nov");
    expect(sender.body()).toContain("Sisa utang ke Toko Jaya jadi Rp 500.000.");
    await say({ replyId: sender.button("OK") });
    expect(sender.body()).toContain("Sisa utang ke Toko Jaya: Rp 500.000.");
    expect(await balances()).toMatchObject({ by: { "2100": -500_000n, "5100": 800_000n, "1110": -300_000n }, open: [["Toko Jaya", "payable", 500_000n]] });
  });

  it("asks which way a payment went when the contact has no open debt", async () => {
    await txn("pak joko bayar 100rb cash", { kind: "settlement", description: "Pak Joko bayar", amount_text: "100rb", counterparty: "pak joko", payment_text: "cash" });
    expect(sender.body()).toContain("Pembayaran Rp 100.000 dengan pak joko: siapa yang bayar?");
    await say({ replyId: sender.button("Dia bayar ke aku") });
    expect(sender.body()).toContain("⚠️ Belum ada catatan piutang pak joko yang belum lunas.");
    await say({ replyId: sender.button("OK") });
    // Paid before any debt was recorded: shows as an overpayment, still reconciled.
    expect((await balances()).open).toEqual([["Pak Joko", "receivable", -100_000n]]);
  });
});
