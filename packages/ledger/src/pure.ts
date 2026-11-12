import { LedgerError } from "./errors.js";
import type { JournalDraft, PostedLine, TrialBalance, TrialBalanceInputRow } from "./types.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function amount(v: unknown, field: string, lineNo: number): bigint {
  if (v === undefined) return 0n;
  if (typeof v !== "bigint") {
    throw new LedgerError("INVALID_AMOUNT", `line ${lineNo}: ${field} must be integer rupiah (bigint), got ${typeof v}`);
  }
  if (v < 0n) throw new LedgerError("INVALID_AMOUNT", `line ${lineNo}: ${field} must not be negative`);
  return v;
}

/** Throws LedgerError unless the draft is a well-formed, balanced journal. */
export function validateJournalDraft(draft: JournalDraft): void {
  if (!isValidDate(draft.date)) throw new LedgerError("INVALID_DATE", `invalid date: ${draft.date}`);
  if (!draft.description?.trim()) throw new LedgerError("INVALID_DESCRIPTION", "description is required");
  if (!Array.isArray(draft.lines) || draft.lines.length < 2) {
    throw new LedgerError("TOO_FEW_LINES", "a journal needs at least 2 lines");
  }

  let totalDebit = 0n;
  let totalCredit = 0n;
  draft.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.accountCode) throw new LedgerError("INVALID_LINE", `line ${n}: accountCode is required`);
    const debit = amount(line.debit, "debit", n);
    const credit = amount(line.credit, "credit", n);
    if ((debit > 0n) === (credit > 0n)) {
      throw new LedgerError("INVALID_LINE", `line ${n}: exactly one of debit/credit must be positive`);
    }
    totalDebit += debit;
    totalCredit += credit;
  });

  if (totalDebit !== totalCredit) {
    throw new LedgerError("UNBALANCED", `debits ${totalDebit} != credits ${totalCredit}`);
  }
}

/** Mirror lines of a posted journal: every debit becomes a credit and vice versa. */
export function buildReversalLines(lines: readonly PostedLine[]): PostedLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

export function summarizeTrialBalance(rows: readonly TrialBalanceInputRow[]): TrialBalance {
  let totalDebit = 0n;
  let totalCredit = 0n;
  const out = rows.map((r) => {
    totalDebit += r.debit;
    totalCredit += r.credit;
    return { ...r, balance: r.debit - r.credit };
  });
  return { rows: out, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}
