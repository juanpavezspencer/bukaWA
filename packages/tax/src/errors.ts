export type TaxErrorCode = "INVALID_MONTH" | "INVALID_INPUT" | "NO_PROFILE" | "PROFILE_OVERLAP";

export class TaxError extends Error {
  constructor(
    public readonly code: TaxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaxError";
  }
}
