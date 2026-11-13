import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { accounts, contacts, journalLines, journals, type Tx } from "@bukuwa/db";
import { PAYABLE_ACCOUNT, RECEIVABLE_ACCOUNT } from "./posting.js";
import { assertScope } from "./scope.js";

/*
 * Receivables and payables (F8), derived from the ledger itself: a contact's
 * open balance is the sum of its lines on Piutang usaha (1200) or Utang usaha
 * (2100), so it always reconciles with those accounts. Payments are matched
 * to the oldest debts first (FIFO) to show which items are still open.
 */

export type OpenItemKind = "receivable" | "payable";

export interface OpenItem {
  journalId: string;
  date: string;
  description: string;
  /** The debt as recorded. */
  amountIdr: bigint;
  /** What is still unpaid after FIFO matching. */
  openIdr: bigint;
}

export interface ContactBalance {
  contactId: string;
  name: string;
  kind: OpenItemKind;
  /** Positive: still owed. Negative: paid more than owed. */
  balanceIdr: bigint;
  openItems: OpenItem[];
  oldestOpenDate: string | null;
  lastPaymentDate: string | null;
}

export interface OpenBalanceFilters {
  kind?: OpenItemKind;
  contactId?: string;
  /** Inclusive YYYY-MM-DD; default: everything posted. */
  asOf?: string;
}

const ACCOUNT_KIND: Record<string, OpenItemKind> = { [RECEIVABLE_ACCOUNT]: "receivable", [PAYABLE_ACCOUNT]: "payable" };

/** Contacts with a non-zero open balance, largest first. */
export async function openBalances(tx: Tx, businessId: string, f: OpenBalanceFilters = {}): Promise<ContactBalance[]> {
  await assertScope(tx, businessId);
  const codes = f.kind ? [f.kind === "receivable" ? RECEIVABLE_ACCOUNT : PAYABLE_ACCOUNT] : [RECEIVABLE_ACCOUNT, PAYABLE_ACCOUNT];
  const lines = await tx
    .select({
      journalId: journals.id,
      date: journals.date,
      description: journals.description,
      // Reversed journals and their reversals cancel out; leave both out of the matching.
      cancelled: sql<boolean>`(${journals.reversesJournalId} is not null or exists (select 1 from journals r where r.reverses_journal_id = ${journals.id}))`,
      code: accounts.code,
      contactId: journalLines.contactId,
      name: contacts.name,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .innerJoin(contacts, eq(contacts.id, journalLines.contactId))
    .where(
      and(
        eq(journalLines.businessId, businessId),
        inArray(accounts.code, codes),
        isNotNull(journalLines.contactId),
        f.contactId ? eq(journalLines.contactId, f.contactId) : undefined,
        f.asOf ? lte(journals.date, f.asOf) : undefined,
      ),
    )
    .orderBy(asc(journals.date), asc(journals.createdAt), asc(journalLines.lineNo));

  const groups = new Map<string, typeof lines>();
  for (const l of lines) {
    const k = `${l.contactId}|${l.code}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }

  const out: ContactBalance[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const kind = ACCOUNT_KIND[first.code]!;
    // Receivable: debits raise the debt. Payable: credits do.
    const up = (l: (typeof lines)[number]) => (kind === "receivable" ? l.debit : l.credit);
    const down = (l: (typeof lines)[number]) => (kind === "receivable" ? l.credit : l.debit);
    const balanceIdr = group.reduce((s, l) => s + up(l) - down(l), 0n);
    if (balanceIdr === 0n) continue;

    const live = group.filter((l) => !l.cancelled);
    let paid = live.reduce((s, l) => s + down(l), 0n);
    const openItems: OpenItem[] = [];
    for (const l of live) {
      const amt = up(l);
      if (amt === 0n) continue;
      const applied = paid >= amt ? amt : paid;
      paid -= applied;
      if (amt - applied > 0n) {
        openItems.push({ journalId: l.journalId, date: l.date, description: l.description, amountIdr: amt, openIdr: amt - applied });
      }
    }
    const payments = live.filter((l) => down(l) > 0n);
    out.push({
      contactId: first.contactId!,
      name: first.name,
      kind,
      balanceIdr,
      openItems,
      oldestOpenDate: openItems[0]?.date ?? null,
      lastPaymentDate: payments.at(-1)?.date ?? null,
    });
  }
  return out.sort((a, b) => (b.balanceIdr > a.balanceIdr ? 1 : b.balanceIdr < a.balanceIdr ? -1 : a.name.localeCompare(b.name)));
}
