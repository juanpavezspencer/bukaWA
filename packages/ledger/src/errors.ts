export type LedgerErrorCode =
  | "UNBALANCED"
  | "TOO_FEW_LINES"
  | "INVALID_LINE"
  | "INVALID_AMOUNT"
  | "INVALID_DATE"
  | "INVALID_DESCRIPTION"
  | "UNKNOWN_ACCOUNT"
  | "BUSINESS_MISMATCH"
  | "NOT_FOUND"
  | "ALREADY_REVERSED"
  | "CANNOT_REVERSE_REVERSAL";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}
