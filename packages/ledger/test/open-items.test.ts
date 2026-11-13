import { beforeAll, describe, expect, it } from "vitest";
import { withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import {
  buildJournalDraft,
  findContact,
  findOrCreateContact,
  openBalances,
  postJournal,
  reverseJournal,
  trialBalance,
  type PostableEntry,
} from "../src/index.js";

let db: Db;
let biz: string;
let other: string;
const c: Record<string, string> = {};
const j: Record<string, string> = {};

const entry = (e: Partial<PostableEntry> & Pick<PostableEntry, "kind" | "amountIdr" | "date">): PostableEntry => ({
  description: "transaksi",
  source: "text",
  paymentMethod: null,
  ...e,
});

beforeAll(async () => {
  ({ db } = await createTestDb());
  biz = await createTestBusiness(db, "Catering Rina");
  other = await createTestBusiness(db, "Toko Dimas");
  await withBusiness(db, biz, async (tx) => {
    c.sari = await findOrCreateContact(tx, biz, "bu sari", "customer");
    c.budi = await findOrCreateContact(tx, biz, "Pak Budi", "customer");
    c.jaya = await findOrCreateContact(tx, biz, "Toko Jaya", "supplier");
    const post = async (k: string, e: PostableEntry) => (j[k] = (await postJournal(tx, buildJournalDraft(biz, e))).id);
    await post("sari1", entry({ kind: "receivable", amountIdr: 300_000n, date: "2026-11-01", description: "Nasi box 15", contactId: c.sari }));
    await post("sari2", entry({ kind: "receivable", amountIdr: 200_000n, date: "2026-11-05", description: "Kue lapis", contactId: c.sari }));
    await post("sariPay", entry({ kind: "settlement", settles: "receivable", amountIdr: 350_000n, date: "2026-11-08", paymentMethod: "cash", contactId: c.sari }));
    await post("budi1", entry({ kind: "receivable", amountIdr: 150_000n, date: "2026-11-10", description: "Tumpeng", contactId: c.budi }));
    await post("budiPay", entry({ kind: "settlement", settles: "receivable", amountIdr: 150_000n, date: "2026-11-11", paymentMethod: "qris", contactId: c.budi }));
    await post("jaya1", entry({ kind: "payable", amountIdr: 800_000n, date: "2026-11-03", description: "Beras 2 karung", accountCode: "5100", contactId: c.jaya }));
    await post("wrong", entry({ kind: "receivable", amountIdr: 999_000n, date: "2026-11-09", description: "salah", contactId: c.budi }));
    await reverseJournal(tx, { businessId: biz, journalId: j.wrong! });
  });
  await withBusiness(db, other, async (tx) => {
    const x = await findOrCreateContact(tx, other, "Bu Sari", "customer");
    await postJournal(tx, buildJournalDraft(other, entry({ kind: "receivable", amountIdr: 7_000_000n, date: "2026-11-01", contactId: x })));
  });
});

const q = (f: Parameters<typeof openBalances>[2] = {}) => withBusiness(db, biz, (tx) => openBalances(tx, biz, f));

describe("contacts", () => {
  it("finds an existing contact by name regardless of honorific and case", async () => {
    await withBusiness(db, biz, async (tx) => {
      expect(await findOrCreateContact(tx, biz, "Ibu Sari", "customer")).toBe(c.sari);
      expect((await findContact(tx, biz, "SARI"))?.id).toBe(c.sari);
      expect((await findContact(tx, biz, "sari"))?.name).toBe("Bu Sari");
      expect(await findContact(tx, biz, "Bu Ani")).toBeUndefined();
    });
  });
});

describe("openBalances", () => {
  it("nets debts and payments per contact, oldest debt paid first", async () => {
    const r = await q({ kind: "receivable" });
    expect(r.map((b) => [b.name, b.balanceIdr])).toEqual([["Bu Sari", 150_000n]]);
    const sari = r[0]!;
    // 350k paid: the 300k from 1 Nov is closed, 50k of the 200k from 5 Nov.
    expect(sari.openItems).toEqual([{ journalId: j.sari2, date: "2026-11-05", description: "Kue lapis", amountIdr: 200_000n, openIdr: 150_000n }]);
    expect(sari.oldestOpenDate).toBe("2026-11-05");
    expect(sari.lastPaymentDate).toBe("2026-11-08");
  });

  it("lists payables separately, and settled contacts not at all", async () => {
    expect((await q({ kind: "payable" })).map((b) => [b.name, b.balanceIdr, b.openItems.length])).toEqual([["Toko Jaya", 800_000n, 1]]);
    expect((await q()).map((b) => b.name).sort()).toEqual(["Bu Sari", "Toko Jaya"]);
    expect(await q({ contactId: c.budi })).toEqual([]);
  });

  it("respects an as-of date", async () => {
    const r = await q({ kind: "receivable", asOf: "2026-11-06" });
    expect(r.map((b) => [b.name, b.balanceIdr])).toEqual([["Bu Sari", 500_000n]]);
  });

  it("always reconciles with the Piutang and Utang account balances", async () => {
    const tb = await withBusiness(db, biz, (tx) => trialBalance(tx, biz));
    const acct = (code: string) => tb.rows.find((r) => r.code === code)?.balance ?? 0n;
    const sum = (xs: Awaited<ReturnType<typeof q>>) => xs.reduce((s, b) => s + b.balanceIdr, 0n);
    expect(sum(await q({ kind: "receivable" }))).toBe(acct("1200"));
    expect(sum(await q({ kind: "payable" }))).toBe(-acct("2100"));
  });

  it("never shows another business's contacts", async () => {
    expect((await q()).some((b) => b.balanceIdr === 7_000_000n)).toBe(false);
  });
});
