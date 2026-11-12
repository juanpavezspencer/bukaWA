export type EntrySource = "text" | "photo" | "voice" | "manual" | "system";

/** One side of a journal line. Amounts are integer rupiah as bigint; set exactly one of debit/credit. */
export interface DraftLine {
  accountCode: string;
  debit?: bigint;
  credit?: bigint;
  contactId?: string | null;
  memo?: string | null;
}

export interface JournalDraft {
  businessId: string;
  /** Calendar date in the business's timezone, YYYY-MM-DD. */
  date: string;
  description: string;
  source: EntrySource;
  lines: DraftLine[];
  /** e.g. the capture id; repeated posts with the same key return the first journal. */
  idempotencyKey?: string;
  createdBy?: string;
}

export interface PostedLine {
  lineNo: number;
  accountId: string;
  debit: bigint;
  credit: bigint;
  contactId: string | null;
  memo: string | null;
}

export interface PostedJournal {
  id: string;
  businessId: string;
  date: string;
  description: string;
  source: EntrySource;
  status: "posted";
  reversesJournalId: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  lines: PostedLine[];
  /** True when an idempotency key matched an existing journal and nothing new was written. */
  alreadyPosted: boolean;
}

export interface TrialBalanceInputRow {
  accountId: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  debit: bigint;
  credit: bigint;
}

export interface TrialBalanceRow extends TrialBalanceInputRow {
  /** debit - credit: positive = debit balance, negative = credit balance. */
  balance: bigint;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: bigint;
  totalCredit: bigint;
  balanced: boolean;
}
