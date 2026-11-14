import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { auditLog, businesses, captures, reports, taxProfiles, withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import { buildJournalDraft, findOrCreateContact, postJournal, profitAndLoss, reverseJournal, type PostableEntry } from "@bukuwa/ledger";
import { buildMonthlyReport, generateMonthlyReport, taxEstimateFor } from "../src/index.js";

let db: Db;
let biz: string;
let other: string;
let photoCapture: string;
const DEFAULT = { defaultRegime: "umkm_final_individual" };
const TODAY = "2026-11-13";
const NOW = new Date("2026-11-13T05:00:00Z");
const evidenceUrl = (id: string) => `https://bukuwa.test/e/${id}`;

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
    const post = (e: PostableEntry) => postJournal(tx, buildJournalDraft(biz, e));
    // January to September: Rp 480M of sales (Rp 20M short of the Rp 500M allowance).
    for (let m = 1; m <= 9; m++) {
      await post(entry({ kind: "sale", amountIdr: m === 9 ? 80_000_000n : 50_000_000n, date: `2026-0${m}-15`, description: "Penjualan bulanan", paymentMethod: "bank:BCA" }));
    }
    // October: Rp 50M of sales -> Rp 20M exempt, Rp 30M taxable.
    const [cap] = await tx
      .insert(captures)
      .values({ businessId: biz, source: "photo", mediaUrl: "mem://biz/wamid.1.jpg", status: "confirmed" })
      .returning({ id: captures.id });
    photoCapture = cap!.id;
    await post(entry({ kind: "sale", amountIdr: 30_000_000n, date: "2026-10-05", description: "Catering nikahan", paymentMethod: "bank:BCA", source: "photo", idempotencyKey: `capture:${photoCapture}:0` }));
    const sari = await findOrCreateContact(tx, biz, "Bu Sari", "customer");
    await post(entry({ kind: "receivable", amountIdr: 20_000_000n, date: "2026-10-20", description: "Nasi box kantor", paymentMethod: null, contactId: sari, counterparty: "Bu Sari" }));
    const wrong = await post(entry({ kind: "sale", amountIdr: 9_000_000n, date: "2026-10-21", description: "Salah input" }));
    await reverseJournal(tx, { businessId: biz, journalId: wrong.id });
    await post(entry({ kind: "expense", amountIdr: 12_000_000n, date: "2026-10-06", description: "Belanja bahan", accountCode: "5100" }));
    await post(entry({ kind: "expense", amountIdr: 400_000n, date: "2026-10-14", description: "Bayar PPh final September", accountCode: "6700", paymentMethod: "bank:BCA" }));
    // November so far.
    await post(entry({ kind: "sale", amountIdr: 10_000_000n, date: "2026-11-10", description: "Catering arisan" }));
  });
  await withBusiness(db, other, (tx) =>
    postJournal(tx, buildJournalDraft(other, entry({ kind: "sale", amountIdr: 777_000_000n, date: "2026-10-10", description: "Bukan punya Rina" }))),
  );
});

describe("taxEstimateFor", () => {
  it("matches the ledger: October turnover, the allowance crossed mid-month, 0.5% on the rest", async () => {
    const t = await withBusiness(db, biz, (tx) => taxEstimateFor(tx, biz, { month: "2026-10", today: TODAY, ...DEFAULT }));
    const pl = await withBusiness(db, biz, (tx) => profitAndLoss(tx, biz, { from: "2026-10-01", to: "2026-10-31" }));
    expect(t.turnoverIdr).toBe(pl.incomeIdr);
    expect(t).toMatchObject({
      turnoverIdr: 50_000_000n,
      ytdBeforeIdr: 480_000_000n,
      ytdTurnoverIdr: 530_000_000n,
      exemptUsedThisMonthIdr: 20_000_000n,
      taxableTurnoverIdr: 30_000_000n,
      taxIdr: 150_000n,
      dueDate: "2026-11-16",
      partial: false,
      period: { from: "2026-10-01", to: "2026-10-31" },
      profileName: "PPh Final UMKM 0,5% (PP 55/2022)",
    });
  });

  it("counts a running month up to today and marks it partial", async () => {
    const t = await withBusiness(db, biz, (tx) => taxEstimateFor(tx, biz, { month: "2026-11", today: TODAY, ...DEFAULT }));
    expect(t).toMatchObject({ partial: true, period: { from: "2026-11-01", to: TODAY }, turnoverIdr: 10_000_000n, taxIdr: 50_000n });
  });

  it("uses the seeded pre-2022 rules (no allowance) for older months", async () => {
    const t = await withBusiness(db, biz, (tx) => taxEstimateFor(tx, biz, { month: "2021-05", today: TODAY, ...DEFAULT }));
    expect(t.exemptThresholdIdr).toBe(0n);
    expect(t.profileName).toMatch(/PP 23\/2018/);
  });

  it("refuses a month that hasn't started", async () => {
    await expect(withBusiness(db, biz, (tx) => taxEstimateFor(tx, biz, { month: "2026-12", today: TODAY, ...DEFAULT }))).rejects.toThrow(/hasn't started/);
  });

  it("follows the business's own regime when it has one", async () => {
    // Profiles are changed by migrations; the test connection plays that role.
    const [corp] = await db
      .insert(taxProfiles)
      .values({ regime: "test_corporate", name: "Test badan", rateBps: 50, annualExemptThresholdIdr: 0n, paymentDueDay: 15, validFrom: "2020-01-01" })
      .returning();
    const b2 = await createTestBusiness(db, "PT Test");
    await db.update(businesses).set({ taxProfileId: corp!.id }).where(eq(businesses.id, b2));
    await withBusiness(db, b2, (tx) => postJournal(tx, buildJournalDraft(b2, entry({ kind: "sale", amountIdr: 10_000_000n, date: "2026-10-01" }))));
    const t = await withBusiness(db, b2, (tx) => taxEstimateFor(tx, b2, { month: "2026-10", today: TODAY, ...DEFAULT }));
    expect(t).toMatchObject({ regime: "test_corporate", taxIdr: 50_000n });
  });

  it("never counts another business's sales", async () => {
    const t = await withBusiness(db, other, (tx) => taxEstimateFor(tx, other, { month: "2026-10", today: TODAY, ...DEFAULT }));
    expect(t.turnoverIdr).toBe(777_000_000n);
    expect(t.ytdBeforeIdr).toBe(0n);
  });
});

describe("buildMonthlyReport", () => {
  it("lists every sale and expense so the lists add up to the P&L and the tax turnover", async () => {
    const r = await withBusiness(db, biz, (tx) => buildMonthlyReport(tx, biz, { month: "2026-10", today: TODAY, now: NOW, evidenceUrl, ...DEFAULT }));
    const total = (ls: { amountIdr: bigint }[]) => ls.reduce((s, l) => s + l.amountIdr, 0n);
    expect(total(r.sales)).toBe(r.pl.incomeIdr);
    expect(total(r.sales)).toBe(r.tax.turnoverIdr);
    expect(total(r.expenses)).toBe(r.pl.expenseIdr);
    expect(r.sales.map((s) => s.description)).toEqual(["Catering nikahan", "Nasi box kantor"]);
    expect(r.sales[1]).toMatchObject({ paidWith: "Belum dibayar", counterparty: "Bu Sari" });
  });

  it("links the stored photo as evidence for the sale it was captured from", async () => {
    const r = await withBusiness(db, biz, (tx) => buildMonthlyReport(tx, biz, { month: "2026-10", today: TODAY, now: NOW, evidenceUrl, ...DEFAULT }));
    expect(r.sales[0]!.evidence).toEqual({ captureId: photoCapture, source: "photo", url: evidenceUrl(photoCapture) });
    expect(r.sales[1]!.evidence).toBeNull();
  });

  it("shows tax payments and the receivables still open at month end", async () => {
    const r = await withBusiness(db, biz, (tx) => buildMonthlyReport(tx, biz, { month: "2026-10", today: TODAY, now: NOW, evidenceUrl, ...DEFAULT }));
    expect(r.taxPayments.map((p) => [p.description, p.amountIdr])).toEqual([["Bayar PPh final September", 400_000n]]);
    expect(r.receivables.map((c) => [c.name, c.balanceIdr])).toEqual([["Bu Sari", 20_000_000n]]);
    expect(r.payables).toEqual([]);
    expect(r.cash.asOf).toBe("2026-10-31");
  });
});

describe("generateMonthlyReport", () => {
  it("stores a PDF and audits the export", async () => {
    const g = await withBusiness(db, biz, (tx) =>
      generateMonthlyReport(tx, biz, { month: "2026-10", format: "pdf", today: TODAY, now: NOW, actor: "owner", evidenceUrl, ...DEFAULT }),
    );
    expect(g.fileName).toBe("laporan-catering-rina-2026-10.pdf");
    const [row] = await withBusiness(db, biz, (tx) => tx.select().from(reports).where(eq(reports.id, g.reportId)));
    expect(Buffer.from(row!.content).subarray(0, 5).toString()).toBe("%PDF-");
    expect(row!.mimeType).toBe("application/pdf");
    const audits = await withBusiness(db, biz, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, g.reportId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "report.export", after: { format: "pdf", month: "2026-10", taxIdr: "150000" } });
  });

  it("writes an Excel file whose numbers are the ledger's", async () => {
    const g = await withBusiness(db, biz, (tx) =>
      generateMonthlyReport(tx, biz, { month: "2026-10", format: "xlsx", today: TODAY, now: NOW, actor: "owner", evidenceUrl, ...DEFAULT }),
    );
    const [row] = await withBusiness(db, biz, (tx) => tx.select().from(reports).where(eq(reports.id, g.reportId)));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(row!.content as unknown as ArrayBuffer);
    const summary = new Map<string, unknown>();
    wb.getWorksheet("Ringkasan")!.eachRow((r) => summary.set(String(r.getCell(1).value), r.getCell(2).value));
    expect(summary.get("Pemasukan")).toBe(50_000_000);
    expect(summary.get("Omzet kena pajak")).toBe(30_000_000);
    expect(summary.get("Perkiraan pajak (0,5%)")).toBe(150_000);
    const sales = wb.getWorksheet("Penjualan")!;
    expect(sales.getRow(sales.rowCount).getCell(6).value).toBe(50_000_000);
    expect(sales.getRow(2).getCell(7).value).toMatchObject({ hyperlink: evidenceUrl(photoCapture) });
  });
});
