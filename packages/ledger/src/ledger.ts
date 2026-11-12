import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { accounts, auditLog, journalLines, journals, rows, type Tx } from "@bukuwa/db";
import { LedgerError } from "./errors.js";
import { buildReversalLines, summarizeTrialBalance, validateJournalDraft } from "./pure.js";
import type { EntrySource, JournalDraft, PostedJournal, PostedLine, TrialBalance } from "./types.js";

/*
 * All functions take a transaction opened with withBusiness(db, businessId, ...).
 * RLS restricts every query to that business; the explicit businessId argument
 * is checked against the scope so a mismatch fails loudly instead of silently
 * returning nothing.
 */

async function assertScope(tx: Tx, businessId: string): Promise<void> {
  const r = await tx.execute(sql`select app_current_business_id()::text as id`);
  const current = rows<{ id: string | null }>(r)[0]?.id;
  if (current !== businessId) {
    throw new LedgerError("BUSINESS_MISMATCH", "journal business does not match the transaction's business scope");
  }
}

async function loadJournal(tx: Tx, where: ReturnType<typeof eq>): Promise<PostedJournal | undefined> {
  const [j] = await tx.select().from(journals).where(where);
  if (!j) return undefined;
  const lines = await tx
    .select({
      lineNo: journalLines.lineNo,
      accountId: journalLines.accountId,
      debit: journalLines.debit,
      credit: journalLines.credit,
      contactId: journalLines.contactId,
      memo: journalLines.memo,
    })
    .from(journalLines)
    .where(eq(journalLines.journalId, j.id))
    .orderBy(asc(journalLines.lineNo));
  return {
    id: j.id,
    businessId: j.businessId,
    date: j.date,
    description: j.description,
    source: j.source,
    status: j.status,
    reversesJournalId: j.reversesJournalId,
    idempotencyKey: j.idempotencyKey,
    createdAt: j.createdAt,
    lines,
    alreadyPosted: true,
  };
}

interface InsertHeader {
  businessId: string;
  date: string;
  description: string;
  source: EntrySource;
  reversesJournalId?: string;
  idempotencyKey?: string;
  createdBy?: string;
}

async function insertJournal(
  tx: Tx,
  header: InsertHeader,
  lines: PostedLine[],
  auditAction: string,
): Promise<PostedJournal | undefined> {
  const [j] = await tx
    .insert(journals)
    .values({
      businessId: header.businessId,
      date: header.date,
      description: header.description.trim(),
      source: header.source,
      reversesJournalId: header.reversesJournalId ?? null,
      idempotencyKey: header.idempotencyKey ?? null,
      createdBy: header.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!j) return undefined; // unique conflict (idempotency key or reversal); caller resolves

  await tx.insert(journalLines).values(
    lines.map((l) => ({
      businessId: header.businessId,
      journalId: j.id,
      lineNo: l.lineNo,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      contactId: l.contactId,
      memo: l.memo,
    })),
  );
  await tx.insert(auditLog).values({
    businessId: header.businessId,
    actor: header.createdBy ?? "system",
    action: auditAction,
    entity: "journal",
    entityId: j.id,
    after: {
      date: j.date,
      description: j.description,
      reversesJournalId: j.reversesJournalId,
      lines: lines.map((l) => ({ ...l, debit: l.debit.toString(), credit: l.credit.toString() })),
    },
  });

  return {
    id: j.id,
    businessId: j.businessId,
    date: j.date,
    description: j.description,
    source: j.source,
    status: j.status,
    reversesJournalId: j.reversesJournalId,
    idempotencyKey: j.idempotencyKey,
    createdAt: j.createdAt,
    lines,
    alreadyPosted: false,
  };
}

/**
 * Validate and post a balanced journal. Only call this for an owner-confirmed
 * draft (or an auto-confirm rule the owner enabled). Balance is also enforced by
 * a deferred DB constraint at commit.
 */
export async function postJournal(tx: Tx, draft: JournalDraft): Promise<PostedJournal> {
  validateJournalDraft(draft);
  await assertScope(tx, draft.businessId);

  if (draft.idempotencyKey) {
    const existing = await loadJournal(
      tx,
      and(eq(journals.businessId, draft.businessId), eq(journals.idempotencyKey, draft.idempotencyKey))!,
    );
    if (existing) return existing;
  }

  const codes = [...new Set(draft.lines.map((l) => l.accountCode))];
  const found = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.businessId, draft.businessId), inArray(accounts.code, codes)));
  const idByCode = new Map(found.map((a) => [a.code, a.id]));
  const missing = codes.filter((c) => !idByCode.has(c));
  if (missing.length) throw new LedgerError("UNKNOWN_ACCOUNT", `unknown account code(s): ${missing.join(", ")}`);

  const lines: PostedLine[] = draft.lines.map((l, i) => ({
    lineNo: i + 1,
    accountId: idByCode.get(l.accountCode)!,
    debit: l.debit ?? 0n,
    credit: l.credit ?? 0n,
    contactId: l.contactId ?? null,
    memo: l.memo ?? null,
  }));

  const posted = await insertJournal(tx, draft, lines, "journal.post");
  if (posted) return posted;

  // Lost a race on the idempotency key: return the winner.
  if (draft.idempotencyKey) {
    const existing = await loadJournal(
      tx,
      and(eq(journals.businessId, draft.businessId), eq(journals.idempotencyKey, draft.idempotencyKey))!,
    );
    if (existing) return existing;
  }
  throw new Error("journal insert conflicted without a matching idempotency key");
}

export interface ReverseOptions {
  businessId: string;
  journalId: string;
  /** Defaults to the original journal's date so the correction nets out in the same period. */
  date?: string;
  description?: string;
  createdBy?: string;
  idempotencyKey?: string;
}

/** Post a mirror-image journal that cancels `journalId`. The original is never modified. */
export async function reverseJournal(tx: Tx, opts: ReverseOptions): Promise<PostedJournal> {
  await assertScope(tx, opts.businessId);

  const original = await loadJournal(tx, eq(journals.id, opts.journalId));
  if (!original) throw new LedgerError("NOT_FOUND", `journal ${opts.journalId} not found`);
  if (original.reversesJournalId) {
    throw new LedgerError("CANNOT_REVERSE_REVERSAL", "post a new corrected entry instead of reversing a reversal");
  }
  const [already] = await tx
    .select({ id: journals.id })
    .from(journals)
    .where(eq(journals.reversesJournalId, original.id));
  if (already) throw new LedgerError("ALREADY_REVERSED", `journal ${original.id} was already reversed by ${already.id}`);

  const header: InsertHeader = {
    businessId: opts.businessId,
    date: opts.date ?? original.date,
    description: opts.description?.trim() || `Pembatalan: ${original.description}`,
    source: "system",
    reversesJournalId: original.id,
    idempotencyKey: opts.idempotencyKey,
    createdBy: opts.createdBy,
  };
  const lines = buildReversalLines(original.lines);
  // Same invariants as a fresh posting (date format, balance).
  validateJournalDraft({
    ...header,
    lines: lines.map((l) => ({ accountCode: l.accountId, debit: l.debit || undefined, credit: l.credit || undefined })),
  });

  const posted = await insertJournal(tx, header, lines, "journal.reverse");
  if (!posted) throw new LedgerError("ALREADY_REVERSED", `journal ${original.id} was already reversed`);
  return posted;
}

export interface TrialBalanceOptions {
  /** Inclusive YYYY-MM-DD cut-off; defaults to all postings. */
  asOf?: string;
}

/** Sum of debits and credits per account for the business in scope. */
export async function trialBalance(tx: Tx, businessId: string, opts: TrialBalanceOptions = {}): Promise<TrialBalance> {
  await assertScope(tx, businessId);
  const balances = await tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journals.businessId, businessId), opts.asOf ? lte(journals.date, opts.asOf) : undefined))
    .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
    .orderBy(asc(accounts.code));

  return summarizeTrialBalance(
    balances.map((r) => ({ ...r, debit: BigInt(r.debit), credit: BigInt(r.credit) })),
  );
}
