import { beforeAll, describe, expect, it } from "vitest";
import { withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import {
  buildJournalDraft,
  cashPosition,
  getJournalSummary,
  LedgerError,
  findOrCreateContact,
  findTransactions,
  listTransactions,
  entriesInRange,
  postJournal,
  profitAndLoss,
  reverseJournal,
  topSales,
  type PostableEntry,
} from "../src/index.js";

let db: Db;
let biz: string;
let other: string;
const ids: Record<string, string> = {};

const entry = (e: Partial<PostableEntry> & Pick<PostableEntry, "kind" | "amountIdr" | "date">): PostableEntry => ({
  description: "transaksi",
  source: "text",
  paymentMethod: "cash",
  ...e,
});

beforeAll(async () => {
  ({ db } = await createTestDb());
  biz = await createTestBusiness(db, "Catering Rina");
  other = await createTestBusiness(db, "Toko Dimas");
  await withBusiness(db, biz, async (tx) => {
    const post = async (key: string, e: PostableEntry) => (ids[key] = (await postJournal(tx, buildJournalDraft(biz, e))).id);
    await post("capital", entry({ kind: "owner_capital", amountIdr: 1_000_000n, date: "2026-11-01", description: "Modal awal" }));
    await post("saleOct", entry({ kind: "sale", amountIdr: 300_000n, date: "2026-10-30", description: "Jual nasi box" }));
    await post("sale1", entry({ kind: "sale", amountIdr: 450_000n, date: "2026-11-10", description: "Jual nasi box", paymentMethod: "bank:BCA", counterparty: "Bu Sari" }));
    await post("sale2", entry({ kind: "sale", amountIdr: 200_000n, date: "2026-11-12", description: "Jual kue lapis", paymentMethod: "qris" }));
    await post("ayam", entry({ kind: "expense", amountIdr: 175_000n, date: "2026-11-11", description: "Belanja ayam", accountCode: "5100" }));
    await post("listrik", entry({ kind: "expense", amountIdr: 350_000n, date: "2026-11-09", description: "Bayar listrik", accountCode: "6300", paymentMethod: "bank:BCA" }));
    await post("wrong", entry({ kind: "expense", amountIdr: 900_000n, date: "2026-11-12", description: "Salah input", accountCode: "6900" }));
    await reverseJournal(tx, { businessId: biz, journalId: ids.wrong! });
    await post("drawing", entry({ kind: "owner_drawing", amountIdr: 100_000n, date: "2026-11-12", description: "Prive", paymentMethod: "ewallet:GoPay" }));
  });
  // Noise in another business that must never show up.
  await withBusiness(db, other, (tx) => postJournal(tx, buildJournalDraft(other, entry({ kind: "sale", amountIdr: 9_999_000n, date: "2026-11-10" }))));
});

describe("profitAndLoss", () => {
  it("sums income and expenses in a date range, net of reversals, ignoring equity", async () => {
    const pl = await withBusiness(db, biz, (tx) => profitAndLoss(tx, biz, { from: "2026-11-01", to: "2026-11-30" }));
    expect(pl).toMatchObject({ incomeIdr: 650_000n, expenseIdr: 525_000n, profitIdr: 125_000n, transactionCount: 4 });
    expect(pl.expenses).toEqual([
      { code: "6300", name: "Listrik & air", amountIdr: 350_000n },
      { code: "5100", name: "HPP / Bahan baku", amountIdr: 175_000n },
    ]);
    expect(pl.income).toEqual([{ code: "4100", name: "Penjualan", amountIdr: 650_000n }]);
  });

  it("respects the range bounds (inclusive)", async () => {
    const pl = await withBusiness(db, biz, (tx) => profitAndLoss(tx, biz, { from: "2026-11-10", to: "2026-11-11" }));
    expect(pl).toMatchObject({ incomeIdr: 450_000n, expenseIdr: 175_000n, profitIdr: 275_000n });
  });

  it("reports zero for an empty range", async () => {
    const pl = await withBusiness(db, biz, (tx) => profitAndLoss(tx, biz, { from: "2026-12-01", to: "2026-12-31" }));
    expect(pl).toMatchObject({ incomeIdr: 0n, expenseIdr: 0n, profitIdr: 0n, transactionCount: 0, income: [], expenses: [] });
  });

  it("refuses an inverted range", async () => {
    await expect(withBusiness(db, biz, (tx) => profitAndLoss(tx, biz, { from: "2026-11-30", to: "2026-11-01" }))).rejects.toBeInstanceOf(LedgerError);
  });
});

describe("cashPosition", () => {
  it("returns cash, bank and e-wallet balances as of a date", async () => {
    const cp = await withBusiness(db, biz, (tx) => cashPosition(tx, biz, "2026-11-12"));
    // cash: +1.000.000 +300.000 -175.000 = 1.125.000; bank: +450.000 -350.000 +200.000 (qris) = 300.000; e-wallet: -100.000
    expect(cp.accounts).toEqual([
      { code: "1100", name: "Kas", balanceIdr: 1_125_000n },
      { code: "1110", name: "Bank", balanceIdr: 300_000n },
      { code: "1120", name: "E-wallet", balanceIdr: -100_000n },
    ]);
    expect(cp.totalIdr).toBe(1_325_000n);
  });

  it("excludes later postings", async () => {
    const cp = await withBusiness(db, biz, (tx) => cashPosition(tx, biz, "2026-10-31"));
    expect(cp.totalIdr).toBe(300_000n);
  });
});

describe("topSales", () => {
  it("groups income by description, largest first, ignoring cancelled entries", async () => {
    const top = await withBusiness(db, biz, (tx) => topSales(tx, biz, { from: "2026-10-01", to: "2026-11-30" }, 5));
    expect(top).toEqual([
      { description: "Jual nasi box", amountIdr: 750_000n, count: 2 },
      { description: "Jual kue lapis", amountIdr: 200_000n, count: 1 },
    ]);
    expect(await withBusiness(db, biz, (tx) => topSales(tx, biz, { from: "2026-11-11", to: "2026-11-30" }, 1))).toEqual([
      { description: "Jual kue lapis", amountIdr: 200_000n, count: 1 },
    ]);
  });
});

describe("credit entries", () => {
  it("classifies receivables, payables and settlements and keeps them out of cash", async () => {
    const other2 = await createTestBusiness(db, "Warung Kredit");
    await withBusiness(db, other2, async (tx) => {
      const sari = await findOrCreateContact(tx, other2, "Bu Sari", "customer");
      const jaya = await findOrCreateContact(tx, other2, "Toko Jaya", "supplier");
      const post = (e: PostableEntry) => postJournal(tx, buildJournalDraft(other2, e));
      await post(entry({ kind: "receivable", amountIdr: 350_000n, date: "2026-11-09", description: "Nasi box", paymentMethod: null, contactId: sari, counterparty: "Bu Sari" }));
      await post(entry({ kind: "payable", amountIdr: 500_000n, date: "2026-11-10", description: "Beras", paymentMethod: null, accountCode: "5100", contactId: jaya }));
      await post(entry({ kind: "settlement", settles: "receivable", amountIdr: 350_000n, date: "2026-11-11", description: "Lunas", contactId: sari }));
      await post(entry({ kind: "settlement", settles: "payable", amountIdr: 200_000n, date: "2026-11-12", description: "Cicil", paymentMethod: "bank:BCA", contactId: jaya }));
      const list = await listTransactions(tx, other2, {});
      expect(list.map((t) => [t.description, t.kind, t.category, t.paymentAccount])).toEqual([
        ["Cicil", "settlement", "Utang usaha", "Bank"],
        ["Lunas", "settlement", "Piutang usaha", "Kas"],
        ["Beras", "payable", "HPP / Bahan baku", null],
        ["Nasi box", "receivable", "Penjualan", null],
      ]);
      expect(list[3]!.lines[0]!.contactId).toBe(sari);
      expect(list[3]!.simple).toBe(true);
      // Accrual: credit sales count as income when made, not when paid.
      const pl = await profitAndLoss(tx, other2, { from: "2026-11-01", to: "2026-11-30" });
      expect([pl.incomeIdr, pl.expenseIdr]).toEqual([350_000n, 500_000n]);
      const cash = await cashPosition(tx, other2, "2026-11-30");
      expect(cash.totalIdr).toBe(150_000n);
    });
  });
});

describe("findTransactions", () => {
  it("filters by kind and totals every active match, not just the shown page", async () => {
    const r = await withBusiness(db, biz, (tx) => findTransactions(tx, biz, { kind: "sale", limit: 1 }));
    expect(r.transactions.map((t) => t.description)).toEqual(["Jual kue lapis"]);
    expect(r.count).toBe(3);
    expect(r.totalIdr).toBe(950_000n);
    expect(r.matched).toBe(3);
  });

  it("leaves cancelled entries out of count and total but can still show them", async () => {
    const r = await withBusiness(db, biz, (tx) => findTransactions(tx, biz, { from: "2026-11-12", to: "2026-11-12", kind: "expense" }));
    expect(r.transactions.map((t) => [t.description, t.reversed])).toEqual([["Salah input", true]]);
    expect([r.count, r.totalIdr]).toEqual([0, 0n]);
  });
});

describe("listTransactions", () => {
  it("lists entries newest first with amount, category and payment account, flagging reversed ones", async () => {
    const list = await withBusiness(db, biz, (tx) => listTransactions(tx, biz, { from: "2026-11-11", to: "2026-11-12" }));
    expect(list.map((t) => [t.description, t.amountIdr, t.category, t.paymentAccount, t.reversed])).toEqual([
      ["Prive", 100_000n, "Prive", "E-wallet", false],
      ["Salah input", 900_000n, "Lain-lain", "Kas", true],
      ["Jual kue lapis", 200_000n, "Penjualan", "Bank", false],
      ["Belanja ayam", 175_000n, "HPP / Bahan baku", "Kas", false],
    ]);
    expect(list[0]!.kind).toBe("owner_drawing");
    expect(list.find((t) => t.description === "Jual kue lapis")!.kind).toBe("sale");
  });

  it("filters by text, category code, amount and excludes reversed entries when asked", async () => {
    const q = (f: Parameters<typeof listTransactions>[2]) => withBusiness(db, biz, (tx) => listTransactions(tx, biz, f));
    expect((await q({ text: "nasi" })).map((t) => t.date)).toEqual(["2026-11-10", "2026-10-30"]);
    expect((await q({ accountCode: "6300" })).map((t) => t.description)).toEqual(["Bayar listrik"]);
    expect((await q({ minIdr: 400_000n })).map((t) => t.description)).toEqual(["Salah input", "Jual nasi box", "Modal awal"]);
    expect((await q({ minIdr: 400_000n, includeReversed: false })).map((t) => t.description)).toEqual(["Jual nasi box", "Modal awal"]);
    expect(await q({ limit: 2 })).toHaveLength(2);
    expect((await q({ text: "nasi" }))[0]!.counterparty).toBe("Bu Sari");
  });

  it("never returns another business's entries", async () => {
    const list = await withBusiness(db, biz, (tx) => listTransactions(tx, biz, {}));
    expect(list.some((t) => t.amountIdr === 9_999_000n)).toBe(false);
  });
});

describe("getJournalSummary", () => {
  it("describes a journal by kind with its category and payment accounts", async () => {
    const j = await withBusiness(db, biz, (tx) => getJournalSummary(tx, biz, ids.listrik!));
    expect(j).toMatchObject({ kind: "expense", amountIdr: 350_000n, categoryCode: "6300", paymentCode: "1110", reversed: false, simple: true });
  });

  it("returns undefined for another business's journal", async () => {
    const otherId = await withBusiness(db, other, async (tx) => (await listTransactions(tx, other, {}))[0]!.id);
    expect(await withBusiness(db, biz, (tx) => getJournalSummary(tx, biz, otherId))).toBeUndefined();
  });
});

describe("entriesInRange", () => {
  it("lists every entry of a period oldest first, flagging reversed ones and hiding reversing journals", async () => {
    const all = await withBusiness(db, biz, (tx) => entriesInRange(tx, biz, { from: "2026-11-01", to: "2026-11-30" }));
    expect(all.map((t) => [t.date, t.description, t.reversed])).toEqual([
      ["2026-11-01", "Modal awal", false],
      ["2026-11-09", "Bayar listrik", false],
      ["2026-11-10", "Jual nasi box", false],
      ["2026-11-11", "Belanja ayam", false],
      ["2026-11-12", "Jual kue lapis", false],
      ["2026-11-12", "Prive", false],
      ["2026-11-12", "Salah input", true],
    ]);
  });

  it("refuses more entries than the cap instead of silently cutting the list", async () => {
    await expect(withBusiness(db, biz, (tx) => entriesInRange(tx, biz, { from: "2026-11-01", to: "2026-11-30" }, 3))).rejects.toThrow(LedgerError);
  });

  it("never returns another business's entries", async () => {
    const all = await withBusiness(db, other, (tx) => entriesInRange(tx, other, { from: "2026-11-01", to: "2026-11-30" }));
    expect(all.map((t) => t.amountIdr)).toEqual([9_999_000n]);
  });
});
