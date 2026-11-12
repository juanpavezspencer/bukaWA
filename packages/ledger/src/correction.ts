import { DEFAULT_CHART_OF_ACCOUNTS } from "@bukuwa/db";
import { LedgerError } from "./errors.js";
import { CASH_ACCOUNT_CODES } from "./posting.js";
import type { JournalDraft } from "./types.js";

/*
 * Flow D: a correction is a reversal of the original plus this corrected
 * journal, both posted only after the owner confirms. The original is never
 * edited. Pure: builds the corrected draft from the original's lines.
 */

export interface CorrectableJournal {
  id: string;
  date: string;
  description: string;
  kind: string;
  reversed: boolean;
  lines: Array<{ code: string; debit: bigint; credit: bigint; memo: string | null }>;
}

export interface Correction {
  amountIdr?: bigint;
  date?: string;
  /** New money account (1100 Kas, 1110 Bank, 1120 E-wallet). */
  paymentCode?: string;
  /** New category account; must fit the entry's kind. */
  categoryCode?: string;
}

const TYPE_BY_CODE = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.code, a.type]));
const CASH = new Set<string>(CASH_ACCOUNT_CODES);

function fitsKind(kind: string, code: string): boolean {
  const type = TYPE_BY_CODE.get(code);
  if (kind === "sale") return type === "income";
  if (kind === "expense") return type === "expense" || code === "1300";
  return false;
}

export function correctedDraft(businessId: string, original: CorrectableJournal, c: Correction): JournalDraft {
  if (original.reversed) throw new LedgerError("ALREADY_REVERSED", "this entry was already cancelled");
  if (c.amountIdr === undefined && !c.date && !c.paymentCode && !c.categoryCode) {
    throw new LedgerError("NOT_CORRECTABLE", "nothing to change");
  }
  if (c.amountIdr !== undefined && (typeof c.amountIdr !== "bigint" || c.amountIdr <= 0n)) {
    throw new LedgerError("INVALID_AMOUNT", "amount must be a positive integer rupiah");
  }
  const payLines = original.lines.filter((l) => CASH.has(l.code));
  const catLines = original.lines.filter((l) => !CASH.has(l.code));
  if (c.amountIdr !== undefined && (original.lines.length !== 2 || payLines.length !== 1)) {
    throw new LedgerError("NOT_CORRECTABLE", "amount can only be changed on a simple two-line entry; cancel it and record it again");
  }
  if (c.paymentCode !== undefined) {
    if (!CASH.has(c.paymentCode)) throw new LedgerError("INVALID_CATEGORY", `${c.paymentCode} is not a money account`);
    if (payLines.length !== 1) throw new LedgerError("NOT_CORRECTABLE", "entry has no single payment line");
  }
  if (c.categoryCode !== undefined) {
    if (original.kind !== "sale" && original.kind !== "expense") {
      throw new LedgerError("NOT_CORRECTABLE", `category of a ${original.kind} entry can't be changed`);
    }
    if (!fitsKind(original.kind, c.categoryCode)) {
      throw new LedgerError("INVALID_CATEGORY", `account ${c.categoryCode} is not a valid ${original.kind} category`);
    }
    if (catLines.length !== 1) throw new LedgerError("NOT_CORRECTABLE", "split entry; cancel it and record it again");
  }

  return {
    businessId,
    date: c.date ?? original.date,
    description: original.description,
    source: "manual",
    lines: original.lines.map((l) => {
      const accountCode = CASH.has(l.code) ? (c.paymentCode ?? l.code) : (c.categoryCode ?? l.code);
      const amt = (side: bigint) => (c.amountIdr !== undefined ? c.amountIdr : side);
      return l.debit > 0n ? { accountCode, debit: amt(l.debit), memo: l.memo } : { accountCode, credit: amt(l.credit), memo: l.memo };
    }),
  };
}
