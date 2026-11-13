import { TaxError } from "./errors.js";
import { assertMonth, paymentDueDate, type Month } from "./month.js";
import type { TaxProfile } from "./profile.js";

/*
 * Turnover-based final tax estimate for one month (F10, spec 8.1). Integer
 * rupiah only. The exempt allowance counts cumulative turnover from January:
 * the month that crosses it pays on the part above it, later months on all.
 * An estimate, not tax advice.
 */

export interface MonthlyTaxInput {
  profile: TaxProfile;
  month: Month;
  /** Gross turnover booked in the month (net of returns and discounts). */
  turnoverIdr: bigint;
  /** Turnover from January 1 up to the end of the previous month. */
  ytdBeforeIdr: bigint;
}

export interface MonthlyTaxEstimate {
  month: Month;
  regime: string;
  profileId: string;
  rateBps: number;
  turnoverIdr: bigint;
  ytdBeforeIdr: bigint;
  /** Including this month. */
  ytdTurnoverIdr: bigint;
  exemptThresholdIdr: bigint;
  /** How much of this month's turnover fell under the allowance. */
  exemptUsedThisMonthIdr: bigint;
  /** Allowance left for the rest of the year after this month. */
  exemptRemainingIdr: bigint;
  taxableTurnoverIdr: bigint;
  /** Rounded down to whole rupiah. */
  taxIdr: bigint;
  /** YYYY-MM-DD the payment is due (weekends moved to Monday). */
  dueDate: string;
  /** Year-to-date turnover is above the regime's cap: the owner should check eligibility. */
  overTurnoverCap: boolean;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function estimateMonthlyTax(input: MonthlyTaxInput): MonthlyTaxEstimate {
  const { profile, month, turnoverIdr, ytdBeforeIdr } = input;
  assertMonth(month);
  if (ytdBeforeIdr < 0n) throw new TaxError("INVALID_INPUT", "year-to-date turnover cannot be negative");
  if (!Number.isInteger(profile.rateBps) || profile.rateBps < 0 || profile.rateBps > 10_000) {
    throw new TaxError("INVALID_INPUT", `rate must be 0..10000 bps: ${profile.rateBps}`);
  }

  const threshold = profile.annualExemptThresholdIdr;
  const positive = max(turnoverIdr, 0n);
  const allowanceBefore = max(threshold - ytdBeforeIdr, 0n);
  const exemptUsed = min(positive, allowanceBefore);
  const taxable = positive - exemptUsed;
  const ytd = ytdBeforeIdr + turnoverIdr;

  return {
    month,
    regime: profile.regime,
    profileId: profile.id,
    rateBps: profile.rateBps,
    turnoverIdr,
    ytdBeforeIdr,
    ytdTurnoverIdr: ytd,
    exemptThresholdIdr: threshold,
    exemptUsedThisMonthIdr: exemptUsed,
    exemptRemainingIdr: max(threshold - ytd, 0n),
    taxableTurnoverIdr: taxable,
    taxIdr: (taxable * BigInt(profile.rateBps)) / 10_000n,
    dueDate: paymentDueDate(month, profile.paymentDueDay),
    overTurnoverCap: profile.annualTurnoverCapIdr !== null && ytd > profile.annualTurnoverCapIdr,
  };
}
