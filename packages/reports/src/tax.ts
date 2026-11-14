import { eq } from "drizzle-orm";
import { businesses, taxProfiles, type Tx } from "@bukuwa/db";
import { profitAndLoss } from "@bukuwa/ledger";
import { estimateMonthlyTax, monthOf, monthRange, profileForMonth, TaxError, ytdBeforeRange, type MonthlyTaxEstimate, type TaxProfile } from "@bukuwa/tax";

/*
 * F10 tax estimate from the books. Turnover is the month's net income from
 * the ledger (accrual: credit sales count when made); the arithmetic is in
 * @bukuwa/tax. Caller holds the business scope.
 */

export interface TaxSettings {
  /** Regime used when the business has no tax profile of its own (config, not code). */
  defaultRegime: string;
}

export interface TaxEstimateResult extends MonthlyTaxEstimate {
  profileName: string;
  /** Dates actually counted: a month still running stops at today. */
  period: { from: string; to: string };
  /** The month isn't over yet: the figure will still grow. */
  partial: boolean;
}

export async function loadTaxProfiles(tx: Tx): Promise<TaxProfile[]> {
  const rows = await tx.select().from(taxProfiles);
  return rows.map((r) => ({
    id: r.id,
    regime: r.regime,
    name: r.name,
    rateBps: r.rateBps,
    annualExemptThresholdIdr: r.annualExemptThresholdIdr,
    annualTurnoverCapIdr: r.annualTurnoverCapIdr,
    paymentDueDay: r.paymentDueDay,
    validFrom: r.validFrom,
    validTo: r.validTo,
  }));
}

/** The business's regime (from its tax_profile_id), or the default one. */
export async function businessRegime(tx: Tx, businessId: string, settings: TaxSettings, profiles: TaxProfile[]): Promise<string> {
  const [b] = await tx.select({ profileId: businesses.taxProfileId }).from(businesses).where(eq(businesses.id, businessId));
  if (!b) throw new TaxError("INVALID_INPUT", "business not found in scope");
  if (!b.profileId) return settings.defaultRegime;
  const own = profiles.find((p) => p.id === b.profileId);
  if (!own) throw new TaxError("NO_PROFILE", `business tax profile ${b.profileId} is missing`);
  return own.regime;
}

export async function taxEstimateFor(
  tx: Tx,
  businessId: string,
  args: { month: string; today: string } & TaxSettings,
): Promise<TaxEstimateResult> {
  const current = monthOf(args.today);
  if (args.month > current) throw new TaxError("INVALID_MONTH", `${args.month} hasn't started yet`);
  const profiles = await loadTaxProfiles(tx);
  const regime = await businessRegime(tx, businessId, args, profiles);
  const profile = profileForMonth(profiles, regime, args.month);

  const full = monthRange(args.month);
  const partial = args.month === current && args.today < full.to;
  const period = { from: full.from, to: partial ? args.today : full.to };
  const turnover = (await profitAndLoss(tx, businessId, period)).incomeIdr;
  const before = ytdBeforeRange(args.month);
  const ytdBefore = before ? (await profitAndLoss(tx, businessId, before)).incomeIdr : 0n;

  // Returns can make a year-to-date total negative; the allowance can't go above the threshold.
  const est = estimateMonthlyTax({ profile, month: args.month, turnoverIdr: turnover, ytdBeforeIdr: ytdBefore < 0n ? 0n : ytdBefore });
  return { ...est, profileName: profile.name, period, partial };
}
