import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, hashPii, journals, piiKeysFromBase64, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { buildJournalDraft, daySummary, findOrCreateContact, postJournal, trialBalance, type PostableEntry } from "@bukuwa/ledger";
import type { OutboundMessage, WaSender } from "@bukuwa/wa";
import { percentChange } from "../src/agent/tools.js";
import { ASK_FALLBACK } from "../src/agent/ask.js";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";
import { call, ScriptedChat, say } from "./fake-chat.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const NOW = new Date("2026-11-12T03:00:00Z"); // Thursday 12 Nov, 10:00 WIB

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
  button(title: string) {
    const m = this.last();
    const hit = (m.kind === "buttons" ? m.buttons : []).find((b) => b.title === title);
    if (!hit) throw new Error(`no "${title}" in: ${m.body}`);
    return hit.id;
  }
}

let db: Db;
let sender: FakeSender;
let model: ScriptedModel;
let chat: ScriptedChat;
let deps: InboundDeps;
let bizId: string;
let seq = 0;
const ids: Record<string, string> = {};

async function send(input: { text?: string; replyId?: string }) {
  const id = `wamid.ask.${++seq}`;
  const payload = input.replyId
    ? { id, from: RINA, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
    : { id, from: RINA, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: RINA, type: payload.type, payload });
  await processInbound(deps, id);
}

const entry = (e: Partial<PostableEntry> & Pick<PostableEntry, "kind" | "amountIdr" | "date" | "description">): PostableEntry => ({
  source: "text",
  paymentMethod: "cash",
  ...e,
});

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  model = new ScriptedModel();
  chat = new ScriptedChat();
  deps = {
    db,
    sender,
    keys,
    ai: { model, chat, config: aiConfig },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => NOW,
    log: () => {},
  };
  for (const s of [{ text: "halo" }, { replyId: "consent_yes" }, { text: "Catering Bu Rina" }, { replyId: "type_fnb" }, { text: "0" }, { replyId: "confirm_ok" }]) {
    await send(s);
  }
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
  bizId = b!.id;
  await withBusiness(db, bizId, async (tx) => {
    const post = async (k: string, e: PostableEntry) => (ids[k] = (await postJournal(tx, buildJournalDraft(bizId, e))).id);
    await post("lastWeek", entry({ kind: "sale", amountIdr: 500_000n, date: "2026-11-04", description: "Jual nasi box" }));
    await post("sale", entry({ kind: "sale", amountIdr: 800_000n, date: "2026-11-10", description: "Jual nasi box", paymentMethod: "bank:BCA", counterparty: "Bu Sari" }));
    await post("listrik", entry({ kind: "expense", amountIdr: 200_000n, date: "2026-11-11", description: "Bayar listrik", accountCode: "6300" }));
    await post("ayam", entry({ kind: "expense", amountIdr: 450_000n, date: "2026-11-12", description: "Belanja ayam", accountCode: "5100" }));
  });
  sender.sent = [];
});

const week = { preset: "this_week", from: null, to: null };

describe("ask your books (F7)", () => {
  it("answers from tool results, with derived numbers computed in code", async () => {
    model.set("untung minggu ini berapa? dibanding minggu lalu?", { intent: "question" });
    chat.steps = [
      call("get_profit_and_loss", { period: week, compare_to: { preset: "last_week", from: null, to: null } }),
      say((r) => `Untung minggu ini *${r.current.profit}*, minggu lalu ${r.compared_to.profit} (${r.change.profit_percent}).`),
    ];
    await send({ text: "untung minggu ini berapa? dibanding minggu lalu?" });
    expect(sender.last().body).toBe("Untung minggu ini *Rp 150.000*, minggu lalu Rp 500.000 (-70%).");
    // The model saw today's date and the business, and only read-only tools ran.
    expect(JSON.stringify(chat.requests[0]!.messages[0])).toContain("Today is 2026-11-12");
    expect(chat.requests[0]!.tools.map((t) => t.name)).toEqual([
      "get_profit_and_loss",
      "get_cash_position",
      "list_transactions",
      "get_open_items",
      "draft_reminder",
      "propose_correction",
    ]);
  });

  it("lists transactions with a computed count and total", async () => {
    model.set("pengeluaran minggu ini apa aja?", { intent: "question" });
    chat.steps = [
      call("list_transactions", { period: week, text: null, category: null, type: "expense", include_cancelled: null, limit: null }),
      say((r) => `Ada ${r.count} pengeluaran, total ${r.total}: ${r.transactions.map((t: any) => `${t.description} ${t.amount}`).join(", ")}`),
    ];
    await send({ text: "pengeluaran minggu ini apa aja?" });
    expect(sender.last().body).toBe("Ada 2 pengeluaran, total Rp 650.000: Belanja ayam Rp 450.000, Bayar listrik Rp 200.000");
  });

  it("reports cash, bank and e-wallet balances", async () => {
    model.set("saldo berapa sekarang", { intent: "question" });
    chat.steps = [call("get_cash_position", {}), say((r) => `Total uangmu ${r.total}.`)];
    await send({ text: "saldo berapa sekarang" });
    expect(sender.last().body).toBe("Total uangmu Rp 650.000.");
  });

  it("never sends a number that no tool returned", async () => {
    model.set("rata-rata penjualan per hari?", { intent: "question" });
    chat.steps = [
      call("get_profit_and_loss", { period: week, compare_to: null }),
      say("Rata-rata Rp 266.667 per hari."),
      say("Kira-kira Rp 266.667 sehari."),
    ];
    await send({ text: "rata-rata penjualan per hari?" });
    expect(sender.last().body).toBe(ASK_FALLBACK);
  });
});

describe("receivables and payables (F8)", () => {
  beforeEach(async () => {
    await withBusiness(db, bizId, async (tx) => {
      const sari = await findOrCreateContact(tx, bizId, "Bu Sari", "customer");
      const budi = await findOrCreateContact(tx, bizId, "Pak Budi", "customer");
      const jaya = await findOrCreateContact(tx, bizId, "Toko Jaya", "supplier");
      const post = (e: PostableEntry) => postJournal(tx, buildJournalDraft(bizId, e));
      await post(entry({ kind: "receivable", amountIdr: 300_000n, date: "2026-11-03", description: "Nasi box arisan", paymentMethod: null, contactId: sari }));
      await post(entry({ kind: "receivable", amountIdr: 200_000n, date: "2026-11-09", description: "Kue lapis", paymentMethod: null, contactId: sari }));
      await post(entry({ kind: "settlement", settles: "receivable", amountIdr: 100_000n, date: "2026-11-10", description: "Cicilan", contactId: sari }));
      await post(entry({ kind: "receivable", amountIdr: 150_000n, date: "2026-11-11", description: "Tumpeng", paymentMethod: null, contactId: budi }));
      await post(entry({ kind: "payable", amountIdr: 800_000n, date: "2026-11-05", description: "Beras", paymentMethod: null, accountCode: "5100", contactId: jaya }));
    });
  });

  it("answers who hasn't paid from open balances computed in code", async () => {
    model.set("siapa aja yang belum bayar?", { intent: "question" });
    chat.steps = [
      call("get_open_items", { kind: "receivable", contact: null }),
      say((r) => `Total piutang *${r.total}*: ${r.contacts.map((c: any) => `${c.name} ${c.balance} (sejak ${c.since})`).join(", ")}.`),
    ];
    await send({ text: "siapa aja yang belum bayar?" });
    expect(sender.last().body).toBe("Total piutang *Rp 550.000*: Bu Sari Rp 400.000 (sejak 2026-11-03), Pak Budi Rp 150.000 (sejak 2026-11-11).");
  });

  it("finds one contact's open items by name, loosely", async () => {
    model.set("utang ke toko jaya berapa", { intent: "question" });
    chat.steps = [
      call("get_open_items", { kind: null, contact: "toko jaya" }),
      say((r) => `Utang ke ${r.contacts[0].name} ${r.contacts[0].balance}.`),
    ];
    await send({ text: "utang ke toko jaya berapa" });
    expect(sender.last().body).toBe("Utang ke Toko Jaya Rp 800.000.");
  });

  it("drafts a reminder the owner can forward, with the amount from the ledger", async () => {
    model.set("buatin pesan tagihan buat bu sari", { intent: "question" });
    chat.steps = [call("draft_reminder", { contact: "bu sari" })];
    await send({ text: "buatin pesan tagihan buat bu sari" });
    const [intro, draft] = sender.sent.slice(-2);
    expect(intro!.kind === "text" && intro!.body).toContain("tinggal diteruskan ke Bu Sari");
    expect(draft!.kind === "text" && draft!.body).toBe(
      "Halo Bu Sari, semoga sehat selalu 🙏\n" +
        "Mau mengingatkan, masih ada tagihan dari Catering Bu Rina sebesar *Rp 400.000*:\n" +
        "• 3 Nov, Nasi box arisan: Rp 200.000 (sisa)\n" +
        "• 9 Nov, Kue lapis: Rp 200.000\n" +
        "Kalau sudah transfer, kabari ya. Terima kasih banyak!",
    );
    // Only one model call: the draft comes from code, not the model.
    expect(chat.requests).toHaveLength(1);
  });

  it("won't draft a reminder for someone who owes nothing", async () => {
    model.set("tagih pak joko", { intent: "question" });
    chat.steps = [call("draft_reminder", { contact: "pak joko" }), say((r) => `Pak Joko nggak punya tagihan. (${r.error})`)];
    await send({ text: "tagih pak joko" });
    expect(sender.last().kind === "text" && sender.last().body).toContain("nggak punya tagihan");
  });
});

describe("corrections (Flow D)", () => {
  async function ledger() {
    return withBusiness(db, bizId, async (tx) => ({
      journals: await tx.select().from(journals),
      tb: await trialBalance(tx, bizId),
      today: await daySummary(tx, bizId, "2026-11-12"),
    }));
  }

  it("proposes a reversal plus corrected entry and posts both only after OK", async () => {
    const msg = "yang tadi salah, harusnya 45rb bukan 450rb";
    model.set(msg, { intent: "correction" });
    chat.steps = [
      call("list_transactions", { period: { preset: "today", from: null, to: null }, text: null, category: null, type: null, include_cancelled: false, limit: 5 }),
      (req) => {
        const ref = JSON.parse((req.messages.at(-1)!.content as any)[0].content).transactions[0].ref;
        return call("propose_correction", { ref, action: "change", new_amount_text: "45rb", new_date_text: null, new_payment_text: null, new_category: null })(req);
      },
    ];
    await send({ text: msg });

    const card = sender.last();
    expect(card.body).toContain("Pengeluaran Rp 450.000 · Belanja ayam · 12 Nov (Kas)");
    expect(card.body).toContain("nominal jadi *Rp 45.000*");
    expect((await ledger()).journals).toHaveLength(4); // nothing posted yet

    await send({ replyId: sender.button("OK") });
    expect(sender.last().body).toMatch(/sudah dikoreksi ✅/);
    const after = await ledger();
    expect(after.journals).toHaveLength(6); // + reversal + corrected copy
    expect(after.journals.find((j) => j.reversesJournalId === ids.ayam)).toBeDefined();
    expect(after.tb.balanced).toBe(true);
    expect(after.today.expenseIdr).toBe(45_000n);

    // A second tap changes nothing.
    await send({ replyId: card.kind === "buttons" ? card.buttons[0]!.id : "" });
    expect((await ledger()).journals).toHaveLength(6);
  });

  it("rejects a new amount the owner never wrote, so the model has to ask", async () => {
    const msg = "yang ayam tadi salah nominal";
    model.set(msg, { intent: "correction" });
    chat.steps = [
      call("propose_correction", { ref: ids.ayam, action: "change", new_amount_text: "45rb", new_date_text: null, new_payment_text: null, new_category: null }),
      say("Nominal yang benar berapa, kak?"),
    ];
    await send({ text: msg });
    expect(JSON.stringify(chat.requests[1]!.messages.at(-1))).toContain("copied exactly from the owner");
    expect(sender.last().body).toBe("Nominal yang benar berapa, kak?");
  });

  it("cancels an entry with a reversal, and Batal leaves the books unchanged", async () => {
    const msg = "hapus yang listrik";
    model.set(msg, { intent: "correction" });
    const propose = call("propose_correction", { ref: ids.listrik, action: "cancel", new_amount_text: null, new_date_text: null, new_payment_text: null, new_category: null });

    chat.steps = [propose];
    await send({ text: msg });
    expect(sender.last().body).toContain("Batalkan transaksi ini?\nPengeluaran Rp 200.000 · Bayar listrik · 11 Nov (Kas)");
    await send({ replyId: sender.button("Batal") });
    expect(sender.last().body).toMatch(/tetap seperti semula/);
    expect((await ledger()).journals).toHaveLength(4);

    chat.steps = [propose];
    await send({ text: msg });
    await send({ replyId: sender.button("OK") });
    expect(sender.last().body).toMatch(/sudah dibatalkan ✅/);
    const after = await ledger();
    expect(after.journals.filter((j) => j.reversesJournalId === ids.listrik)).toHaveLength(1);
    expect(after.tb.rows.find((r) => r.code === "6300")?.balance ?? 0n).toBe(0n);
  });

  it("refuses to correct an entry that is already cancelled", async () => {
    const msg = "hapus yang listrik";
    model.set(msg, { intent: "correction" });
    const propose = call("propose_correction", { ref: ids.listrik, action: "cancel", new_amount_text: null, new_date_text: null, new_payment_text: null, new_category: null });
    chat.steps = [propose];
    await send({ text: msg });
    const first = sender.button("OK");
    chat.steps = [propose];
    await send({ text: msg });
    const second = sender.button("OK");
    await send({ replyId: first });
    await send({ replyId: second });
    expect(sender.last().body).toMatch(/sudah dibatalkan sebelumnya/);
    expect((await ledger()).journals).toHaveLength(5);
  });
});

describe("percentChange", () => {
  it.each([
    [150n, 500n, "-70%"],
    [1125n, 1000n, "+12,5%"],
    [1000n, 1000n, "0%"],
    [-100n, 200n, "-150%"],
    [100n, -200n, "+150%"],
  ])("%s vs %s -> %s", (a, b, want) => {
    expect(percentChange(a, b)).toBe(want);
  });
  it("is null against zero", () => {
    expect(percentChange(5n, 0n)).toBeNull();
  });
});
