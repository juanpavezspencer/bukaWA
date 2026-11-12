import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { accounts, journalLines, journals, rows, type Tx } from "@bukuwa/db";
import { LedgerError } from "./errors.js";
import { assertScope } from "./scope.js";
import { CASH_ACCOUNT_CODES, PAYABLE_ACCOUNT, RECEIVABLE_ACCOUNT, type EntryKind } from "./posting.js";

/*
 * Read-only reports for "ask your books" (F7). Every number an answer quotes
 * comes from these functions. Reversals carry the original's date, so they net
 * out of every period automatically.
 */

export interface DateRange {
  /** Inclusive YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface AccountAmount {
  code: string;
  name: string;
  amountIdr: bigint;
}

export interface ProfitAndLoss extends DateRange {
  incomeIdr: bigint;
  expenseIdr: bigint;
  profitIdr: bigint;
  /** Largest first; accounts that net to zero are left out. */
  income: AccountAmount[];
  expenses: AccountAmount[];
  /** Entries with income or expense lines, not counting reversed ones. */
  transactionCount: number;
}

export async function profitAndLoss(tx: Tx, businessId: string, range: DateRange): Promise<ProfitAndLoss> {
  await assertScope(tx, businessId);
  if (range.from > range.to) throw new LedgerError("INVALID_DATE", `range starts after it ends: ${range.from} > ${range.to}`);
  const inRange = and(eq(journals.businessId, businessId), gte(journals.date, range.from), lte(journals.date, range.to));

  const byAccount = await tx
    .select({
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      net: sql<string>`(coalesce(sum(${journalLines.credit}), 0) - coalesce(sum(${journalLines.debit}), 0))::text`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(inRange, inArray(accounts.type, ["income", "expense"])))
    .groupBy(accounts.code, accounts.name, accounts.type);

  const pick = (type: "income" | "expense") =>
    byAccount
      .filter((a) => a.type === type)
      .map((a) => ({ code: a.code, name: a.name, amountIdr: type === "income" ? BigInt(a.net) : -BigInt(a.net) }))
      .filter((a) => a.amountIdr !== 0n)
      .sort((x, y) => (y.amountIdr > x.amountIdr ? 1 : y.amountIdr < x.amountIdr ? -1 : x.code.localeCompare(y.code)));
  const income = pick("income");
  const expenses = pick("expense");
  const incomeIdr = income.reduce((s, a) => s + a.amountIdr, 0n);
  const expenseIdr = expenses.reduce((s, a) => s + a.amountIdr, 0n);

  const reversal = sql.raw(REVERSED);
  const [count] = await tx
    .select({ n: sql<number>`count(distinct ${journals.id})::int` })
    .from(journals)
    .innerJoin(journalLines, eq(journalLines.journalId, journals.id))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(inRange, isNull(journals.reversesJournalId), sql`not ${reversal}`, inArray(accounts.type, ["income", "expense"])));

  return { ...range, incomeIdr, expenseIdr, profitIdr: incomeIdr - expenseIdr, income, expenses, transactionCount: count?.n ?? 0 };
}

export interface CashPosition {
  asOf: string;
  accounts: Array<{ code: string; name: string; balanceIdr: bigint }>;
  totalIdr: bigint;
}

/** Balances of the money accounts (Kas, Bank, E-wallet) at the end of `asOf`. */
export async function cashPosition(tx: Tx, businessId: string, asOf: string): Promise<CashPosition> {
  await assertScope(tx, businessId);
  const balances = await tx
    .select({
      code: accounts.code,
      name: accounts.name,
      balance: sql<string>`coalesce(sum(case when ${journals.date} <= ${asOf} then ${journalLines.debit} - ${journalLines.credit} end), 0)::text`,
    })
    .from(accounts)
    .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
    .leftJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(eq(accounts.businessId, businessId), inArray(accounts.code, [...CASH_ACCOUNT_CODES])))
    .groupBy(accounts.code, accounts.name)
    .orderBy(accounts.code);
  const list = balances.map((b) => ({ code: b.code, name: b.name, balanceIdr: BigInt(b.balance) }));
  return { asOf, accounts: list, totalIdr: list.reduce((s, a) => s + a.balanceIdr, 0n) };
}

interface LineInfo {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  debit: bigint;
  credit: bigint;
  memo: string | null;
  contactId: string | null;
}

export interface JournalSummary {
  id: string;
  date: string;
  description: string;
  source: string;
  /** Inferred from the lines; "other" when it isn't one of the simple shapes. */
  kind: EntryKind | "other";
  /** Total of the debits (= total of the credits). */
  amountIdr: bigint;
  /** Income/expense/equity side, e.g. "Penjualan"; for splits, the largest. */
  category: string | null;
  categoryCode: string | null;
  /** Money side, e.g. "Bank". */
  paymentAccount: string | null;
  paymentCode: string | null;
  counterparty: string | null;
  /** True if a reversing journal cancels this one. */
  reversed: boolean;
  /** Two lines: one category, one payment account. Only these can be corrected by amount. */
  simple: boolean;
  createdAt: Date;
  lines: Array<{ code: string; debit: bigint; credit: bigint; memo: string | null; contactId: string | null }>;
}

const CASH = new Set<string>(CASH_ACCOUNT_CODES);

// Fully qualified on purpose: drizzle drops the table name from columns in
// single-table queries, which would bind "id" to the subquery's own row.
const REVERSED = `exists (select 1 from journals r where r.reverses_journal_id = "journals"."id")`;

/** Classify a journal's lines into the entry shapes the posting engine produces. */
export function describeLines(lines: LineInfo[]): Pick<JournalSummary, "kind" | "amountIdr" | "category" | "categoryCode" | "paymentAccount" | "paymentCode" | "simple"> {
  const amountIdr = lines.reduce((s, l) => s + l.debit, 0n);
  const pay = lines.filter((l) => CASH.has(l.code));
  const other = lines.filter((l) => !CASH.has(l.code)).sort((a, b) => Number(b.debit + b.credit - (a.debit + a.credit)));
  const payLine = pay[0];
  const cat = other[0];
  let kind: JournalSummary["kind"] = "other";
  let category = cat;
  if (payLine && cat && pay.length === 1) {
    const moneyIn = payLine.debit > 0n;
    if (cat.type === "income" && moneyIn) kind = "sale";
    else if ((cat.type === "expense" || cat.code === "1300") && !moneyIn) kind = "expense";
    else if (cat.code === "3100" && moneyIn) kind = "owner_capital";
    else if (cat.code === "3200" && !moneyIn) kind = "owner_drawing";
    else if (other.length === 1 && cat.code === RECEIVABLE_ACCOUNT && moneyIn) kind = "settlement";
    else if (other.length === 1 && cat.code === PAYABLE_ACCOUNT && !moneyIn) kind = "settlement";
  } else if (!pay.length && lines.length === 2) {
    // On credit: the debt account takes the place of the payment account.
    const debt = lines.find((l) => l.code === RECEIVABLE_ACCOUNT || l.code === PAYABLE_ACCOUNT);
    const rest = lines.find((l) => l !== debt);
    if (debt && rest) {
      if (debt.code === RECEIVABLE_ACCOUNT && debt.debit > 0n && rest.type === "income") kind = "receivable";
      else if (debt.code === PAYABLE_ACCOUNT && debt.credit > 0n && (rest.type === "expense" || rest.code === "1300")) kind = "payable";
      if (kind !== "other") category = rest;
    }
  }
  return {
    kind,
    amountIdr,
    category: category?.name ?? null,
    categoryCode: category?.code ?? null,
    paymentAccount: payLine?.name ?? null,
    paymentCode: payLine?.code ?? null,
    simple: lines.length === 2 && (pay.length === 1 || kind === "receivable" || kind === "payable"),
  };
}

export interface TransactionFilters extends Partial<DateRange> {
  /** Case-insensitive match on description or line memo (counterparty). */
  text?: string;
  /** Only entries with a line on this account. */
  accountCode?: string;
  minIdr?: bigint;
  maxIdr?: bigint;
  /** Only entries of this kind (sale, expense, ...). */
  kind?: EntryKind | "other";
  /** Default true. */
  includeReversed?: boolean;
  /** Default 20, at most 100. */
  limit?: number;
}

/** How many recent entries a filtered search looks through (MVP volumes are small). */
const SCAN_LIMIT = 1000;

async function summaries(tx: Tx, where: ReturnType<typeof and>, limit: number): Promise<JournalSummary[]> {
  const reversedBy = sql<boolean>`${sql.raw(REVERSED)}`;
  const heads = await tx
    .select({
      id: journals.id,
      date: journals.date,
      description: journals.description,
      source: journals.source,
      createdAt: journals.createdAt,
      reversed: reversedBy,
    })
    .from(journals)
    .where(and(where, isNull(journals.reversesJournalId)))
    .orderBy(desc(journals.date), desc(journals.createdAt))
    .limit(limit);
  if (!heads.length) return [];
  const lines = await tx
    .select({
      journalId: journalLines.journalId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: journalLines.debit,
      credit: journalLines.credit,
      memo: journalLines.memo,
      contactId: journalLines.contactId,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(inArray(journalLines.journalId, heads.map((h) => h.id)))
    .orderBy(journalLines.lineNo);
  const byJournal = new Map<string, LineInfo[]>();
  for (const l of lines) byJournal.set(l.journalId, [...(byJournal.get(l.journalId) ?? []), l]);
  return heads.map((h) => {
    const ls = byJournal.get(h.id) ?? [];
    return {
      ...h,
      reversed: Boolean(h.reversed),
      ...describeLines(ls),
      counterparty: ls.find((l) => l.memo)?.memo ?? null,
      lines: ls.map((l) => ({ code: l.code, debit: l.debit, credit: l.credit, memo: l.memo, contactId: l.contactId })),
    };
  });
}

/** Every match (up to SCAN_LIMIT recent entries), newest first, before the page limit. */
async function matchTransactions(tx: Tx, businessId: string, f: TransactionFilters, cap: number): Promise<JournalSummary[]> {
  await assertScope(tx, businessId);
  const text = f.text?.trim();
  const where = and(
    eq(journals.businessId, businessId),
    f.from ? gte(journals.date, f.from) : undefined,
    f.to ? lte(journals.date, f.to) : undefined,
    text
      ? or(
          ilike(journals.description, `%${text}%`),
          sql`exists (select 1 from journal_lines m where m.journal_id = "journals"."id" and m.memo ilike ${`%${text}%`})`,
        )
      : undefined,
  );
  const needsScan =
    f.accountCode !== undefined || f.kind !== undefined || f.minIdr !== undefined || f.maxIdr !== undefined || f.includeReversed === false;
  const found = await summaries(tx, where, needsScan ? SCAN_LIMIT : cap);
  return found
    .filter((t) => f.includeReversed !== false || !t.reversed)
    .filter((t) => f.kind === undefined || t.kind === f.kind)
    .filter((t) => f.minIdr === undefined || t.amountIdr >= f.minIdr)
    .filter((t) => f.maxIdr === undefined || t.amountIdr <= f.maxIdr)
    .filter((t) => f.accountCode === undefined || t.categoryCode === f.accountCode || t.paymentCode === f.accountCode);
}

const pageLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 20, 1), 100);

/** Search posted entries (reversing journals themselves are never listed). Newest first. */
export async function listTransactions(tx: Tx, businessId: string, f: TransactionFilters): Promise<JournalSummary[]> {
  const limit = pageLimit(f.limit);
  return (await matchTransactions(tx, businessId, f, limit)).slice(0, limit);
}

export interface FoundTransactions {
  /** The first `limit` matches, newest first. */
  transactions: JournalSummary[];
  /** All matches, cancelled ones included if asked for. */
  matched: number;
  /** Active (not cancelled) matches and their total: computed over every match, not just the page. */
  count: number;
  totalIdr: bigint;
}

/** listTransactions plus a count and total over all matches (for "berapa total ..." questions). */
export async function findTransactions(tx: Tx, businessId: string, f: TransactionFilters): Promise<FoundTransactions> {
  const all = await matchTransactions(tx, businessId, f, SCAN_LIMIT);
  const active = all.filter((t) => !t.reversed);
  return {
    transactions: all.slice(0, pageLimit(f.limit)),
    matched: all.length,
    count: active.length,
    totalIdr: active.reduce((s, t) => s + t.amountIdr, 0n),
  };
}

/** One entry by id, or undefined if it isn't this business's (RLS) or doesn't exist. */
export async function getJournalSummary(tx: Tx, businessId: string, journalId: string): Promise<JournalSummary | undefined> {
  await assertScope(tx, businessId);
  if (!/^[0-9a-f-]{36}$/i.test(journalId)) return undefined;
  const [j] = await summaries(tx, and(eq(journals.businessId, businessId), eq(journals.id, journalId)), 1);
  return j;
}

export interface TopSale {
  description: string;
  amountIdr: bigint;
  count: number;
}

/** Best sellers by income, grouped by entry description ("Jual nasi box"); cash and credit sales alike. */
export async function topSales(tx: Tx, businessId: string, range: DateRange, limit = 3): Promise<TopSale[]> {
  await assertScope(tx, businessId);
  if (range.from > range.to) throw new LedgerError("INVALID_DATE", "from is after to");
  const r = await tx.execute(sql`
    select min(j.description) as description, sum(l.credit - l.debit)::text as amount, count(distinct j.id)::int as n
    from journal_lines l
    join journals j on j.id = l.journal_id
    join accounts a on a.id = l.account_id
    where l.business_id = ${businessId} and a.type = 'income'
      and j.date between ${range.from} and ${range.to}
      and j.reverses_journal_id is null
      and not exists (select 1 from journals r where r.reverses_journal_id = j.id)
    group by lower(trim(j.description))
    having sum(l.credit - l.debit) > 0
    order by sum(l.credit - l.debit) desc, min(j.description)
    limit ${limit}`);
  return rows<{ description: string; amount: string; n: number }>(r).map((x) => ({
    description: x.description,
    amountIdr: BigInt(x.amount),
    count: x.n,
  }));
}
