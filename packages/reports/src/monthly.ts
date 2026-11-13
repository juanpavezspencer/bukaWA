import { sql } from "drizzle-orm";
import { accounts, businesses, rows, type Tx } from "@bukuwa/db";
import { cashPosition, entriesInRange, openBalances, profitAndLoss, type CashPosition, type ContactBalance, type JournalSummary, type ProfitAndLoss } from "@bukuwa/ledger";
import { taxEstimateFor, type TaxEstimateResult, type TaxSettings } from "./tax.js";

/*
 * Everything a monthly report shows, computed from the ledger (F10). Renderers
 * only format these numbers; the invariants (sales list = income in the P&L,
 * tax turnover = income) are tested.
 */

export const TAX_EXPENSE_ACCOUNT = "6700";

export interface Evidence {
  captureId: string;
  /** How the owner sent it. */
  source: "text" | "photo" | "voice";
  /** Signed link to the stored original (photos, PDFs, voice notes); null for typed messages. */
  url: string | null;
}

export interface ReportLine {
  journalId: string;
  date: string;
  description: string;
  counterparty: string | null;
  category: string | null;
  /** "Kas", "Bank", ... or "Belum dibayar" for credit entries. */
  paidWith: string | null;
  /** The income (or expense) part of the entry. */
  amountIdr: bigint;
  evidence: Evidence | null;
}

export interface MonthlyReport {
  businessName: string;
  month: string;
  period: { from: string; to: string };
  partial: boolean;
  generatedAt: Date;
  pl: ProfitAndLoss;
  cash: CashPosition;
  tax: TaxEstimateResult;
  sales: ReportLine[];
  expenses: ReportLine[];
  /** Tax payments recorded in the month (usually last month's tax). */
  taxPayments: ReportLine[];
  receivables: ContactBalance[];
  payables: ContactBalance[];
}

type EvidenceUrl = (captureId: string) => string;

async function evidenceFor(tx: Tx, journalIds: string[], url: EvidenceUrl): Promise<Map<string, Evidence>> {
  const out = new Map<string, Evidence>();
  if (!journalIds.length) return out;
  // Posted captures key their journals "capture:<capture id>:<entry index>".
  const r = await tx.execute(sql`
    select j.id as journal_id, c.id as capture_id, c.source, c.media_url
    from journals j
    join captures c on j.idempotency_key like 'capture:' || c.id::text || ':%'
    where j.id in (${sql.join(journalIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const x of rows<{ journal_id: string; capture_id: string; source: Evidence["source"]; media_url: string | null }>(r)) {
    out.set(x.journal_id, { captureId: x.capture_id, source: x.source, url: x.media_url ? url(x.capture_id) : null });
  }
  return out;
}

export async function buildMonthlyReport(
  tx: Tx,
  businessId: string,
  args: { month: string; today: string; now: Date; evidenceUrl: EvidenceUrl } & TaxSettings,
): Promise<MonthlyReport> {
  const tax = await taxEstimateFor(tx, businessId, args);
  const { period } = tax;
  const [b] = await tx.select({ name: businesses.name }).from(businesses);
  const pl = await profitAndLoss(tx, businessId, period);
  const cash = await cashPosition(tx, businessId, period.to);
  const types = new Map((await tx.select({ code: accounts.code, type: accounts.type }).from(accounts)).map((a) => [a.code, a.type]));
  const entries = (await entriesInRange(tx, businessId, period)).filter((e) => !e.reversed);
  const evidence = await evidenceFor(tx, entries.map((e) => e.id), args.evidenceUrl);

  const part = (e: JournalSummary, type: "income" | "expense") =>
    e.lines.filter((l) => types.get(l.code) === type).reduce((s, l) => s + (type === "income" ? l.credit - l.debit : l.debit - l.credit), 0n);
  const line = (e: JournalSummary, amountIdr: bigint): ReportLine => ({
    journalId: e.id,
    date: e.date,
    description: e.description,
    counterparty: e.counterparty,
    category: e.category,
    paidWith: e.paymentAccount ?? (e.kind === "receivable" || e.kind === "payable" ? "Belum dibayar" : null),
    amountIdr,
    evidence: evidence.get(e.id) ?? null,
  });
  const sales = entries.map((e) => line(e, part(e, "income"))).filter((l) => l.amountIdr !== 0n);
  const expenses = entries.map((e) => line(e, part(e, "expense"))).filter((l) => l.amountIdr !== 0n);
  const taxPayments = expenses.filter((l) => entries.find((e) => e.id === l.journalId)?.lines.some((x) => x.code === TAX_EXPENSE_ACCOUNT && x.debit > 0n));

  const open = (await openBalances(tx, businessId, { asOf: period.to })).filter((c) => c.balanceIdr > 0n);
  return {
    businessName: b?.name ?? "",
    month: args.month,
    period,
    partial: tax.partial,
    generatedAt: args.now,
    pl,
    cash,
    tax,
    sales,
    expenses,
    taxPayments,
    receivables: open.filter((c) => c.kind === "receivable"),
    payables: open.filter((c) => c.kind === "payable"),
  };
}
