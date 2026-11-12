import { DEFAULT_CHART_OF_ACCOUNTS } from "@bukuwa/db";
import { LedgerError } from "./errors.js";
import type { EntrySource, JournalDraft } from "./types.js";

/*
 * Posting engine: a confirmed, normalized entry -> balanced journal draft.
 * Pure and deterministic; amounts were computed by code upstream, never by a model.
 */

export type EntryKind =
  | "sale"
  | "expense"
  | "transfer_in"
  | "transfer_out"
  | "receivable"
  | "payable"
  | "settlement"
  | "owner_drawing"
  | "owner_capital";

export interface PostableEntry {
  kind: EntryKind;
  amountIdr: bigint;
  date: string;
  description: string;
  source: EntrySource;
  /** "cash" | "bank:<Name>" | "ewallet:<Name>" | "qris"; null if unknown. */
  paymentMethod: string | null;
  /** Category account code; defaults per kind if omitted. */
  accountCode?: string;
  /**
   * Sale/expense only: split the category side across accounts (one receipt,
   * items in different categories). Must add up to amountIdr exactly.
   */
  splits?: Array<{ accountCode: string; amountIdr: bigint }>;
  counterparty?: string | null;
  /** The contact the entry is with; required for receivable, payable and settlement. */
  contactId?: string | null;
  /** Settlement only: which debt is being paid. */
  settles?: "receivable" | "payable";
  idempotencyKey?: string;
  createdBy?: string;
}

const CASH = "1100";
const BANK = "1110";
const EWALLET = "1120";
/** The money accounts a payment method can move. */
export const CASH_ACCOUNT_CODES = [CASH, BANK, EWALLET] as const;
const INVENTORY = "1300";
export const RECEIVABLE_ACCOUNT = "1200";
export const PAYABLE_ACCOUNT = "2100";
const OWNER_EQUITY = "3100";
const OWNER_DRAWINGS = "3200";
const DEFAULT_INCOME = "4100";
const DEFAULT_EXPENSE = "6900";

const TYPE_BY_CODE = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.code, a.type]));

/** Which asset account a payment method moves. QRIS settles to the merchant's bank account. */
export function paymentAccountCode(paymentMethod: string | null | undefined): string | null {
  if (!paymentMethod) return null;
  if (paymentMethod === "cash") return CASH;
  if (paymentMethod === "qris" || paymentMethod.startsWith("bank:")) return BANK;
  if (paymentMethod.startsWith("ewallet:")) return EWALLET;
  return null;
}

function category(kind: "sale" | "expense", code: string | undefined): string {
  const chosen = code ?? (kind === "sale" ? DEFAULT_INCOME : DEFAULT_EXPENSE);
  const type = TYPE_BY_CODE.get(chosen);
  const ok = kind === "sale" ? type === "income" : type === "expense" || chosen === INVENTORY;
  if (!ok) throw new LedgerError("INVALID_CATEGORY", `account ${chosen} is not a valid ${kind} category`);
  return chosen;
}

export function buildJournalDraft(businessId: string, e: PostableEntry): JournalDraft {
  if (typeof e.amountIdr !== "bigint" || e.amountIdr <= 0n) {
    throw new LedgerError("INVALID_AMOUNT", "amount must be a positive integer rupiah");
  }
  const memo = e.counterparty?.trim() || null;
  const contact = e.contactId ? { contactId: e.contactId } : {};
  const header = {
    businessId,
    date: e.date,
    description: e.description,
    source: e.source,
    idempotencyKey: e.idempotencyKey,
    createdBy: e.createdBy,
  };
  const pair = (debitCode: string, creditCode: string): JournalDraft => ({
    ...header,
    lines: [
      { accountCode: debitCode, debit: e.amountIdr, memo, ...contact },
      { accountCode: creditCode, credit: e.amountIdr, memo, ...contact },
    ],
  });

  if (e.kind === "transfer_in" || e.kind === "transfer_out") {
    throw new LedgerError("UNSUPPORTED_KIND", `${e.kind} entries are not supported yet`);
  }
  if (e.kind === "receivable" || e.kind === "payable" || e.kind === "settlement") {
    // Open balances are kept per contact, so a debt without one can't be tracked.
    if (!e.contactId) throw new LedgerError("MISSING_CONTACT", `${e.kind} needs a contact`);
  }
  if (e.kind === "receivable") return pair(RECEIVABLE_ACCOUNT, category("sale", e.accountCode));
  if (e.kind === "payable") return pair(category("expense", e.accountCode), PAYABLE_ACCOUNT);
  if (e.kind === "settlement" && !e.settles) {
    throw new LedgerError("MISSING_SETTLEMENT_SIDE", "say whether a receivable or a payable is being paid");
  }
  const pay = paymentAccountCode(e.paymentMethod);
  if (!pay) throw new LedgerError("MISSING_PAYMENT_METHOD", "payment method is unknown");

  if (e.splits?.length && (e.kind === "sale" || e.kind === "expense")) {
    const byAccount = new Map<string, bigint>();
    let sum = 0n;
    for (const sp of e.splits) {
      if (typeof sp.amountIdr !== "bigint" || sp.amountIdr <= 0n) {
        throw new LedgerError("INVALID_AMOUNT", "split amounts must be positive integer rupiah");
      }
      const acct = category(e.kind, sp.accountCode);
      byAccount.set(acct, (byAccount.get(acct) ?? 0n) + sp.amountIdr);
      sum += sp.amountIdr;
    }
    if (sum !== e.amountIdr) {
      throw new LedgerError("SPLIT_MISMATCH", `splits add up to ${sum}, entry amount is ${e.amountIdr}`);
    }
    const categoryLines = [...byAccount].map(([accountCode, amt]) =>
      e.kind === "sale" ? { accountCode, credit: amt, memo, ...contact } : { accountCode, debit: amt, memo, ...contact },
    );
    const payLine =
      e.kind === "sale" ? { accountCode: pay, debit: e.amountIdr, memo, ...contact } : { accountCode: pay, credit: e.amountIdr, memo, ...contact };
    return { ...header, lines: e.kind === "sale" ? [payLine, ...categoryLines] : [...categoryLines, payLine] };
  }

  switch (e.kind) {
    case "sale":
      return pair(pay, category("sale", e.accountCode));
    case "expense":
      return pair(category("expense", e.accountCode), pay);
    case "owner_capital":
      return pair(pay, OWNER_EQUITY);
    case "settlement":
      return e.settles === "receivable" ? pair(pay, RECEIVABLE_ACCOUNT) : pair(PAYABLE_ACCOUNT, pay);
    default:
      return pair(OWNER_DRAWINGS, pay);
  }
}
