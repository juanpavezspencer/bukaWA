import { TaxError } from "./errors.js";
import { monthRange, type Month } from "./month.js";

/**
 * One version of a tax regime's rules, as stored in the tax_profiles table
 * (spec 8: rules are data, so a regulation change is a data update).
 */
export interface TaxProfile {
  id: string;
  /** Stable regime key, e.g. "umkm_final_individual". Versions of a regime share it. */
  regime: string;
  name: string;
  /** Rate on gross turnover in basis points: 50 = 0.5%. */
  rateBps: number;
  /** Yearly turnover (from January) that is not taxed; 0 for none. */
  annualExemptThresholdIdr: bigint;
  /** Yearly turnover above which the regime no longer applies; null for no cap. */
  annualTurnoverCapIdr: bigint | null;
  /** Day of the following month the tax is due. */
  paymentDueDay: number;
  /** Inclusive YYYY-MM-DD; validTo null = still in force. */
  validFrom: string;
  validTo: string | null;
}

/** The version of `regime` in force on the first day of `month`. */
export function profileForMonth(profiles: readonly TaxProfile[], regime: string, month: Month): TaxProfile {
  const day = monthRange(month).from;
  const hits = profiles.filter((p) => p.regime === regime && p.validFrom <= day && (p.validTo === null || day <= p.validTo));
  if (hits.length > 1) {
    throw new TaxError("PROFILE_OVERLAP", `tax profiles overlap for ${regime} on ${day}: ${hits.map((p) => p.id).join(", ")}`);
  }
  const [hit] = hits;
  if (!hit) throw new TaxError("NO_PROFILE", `no ${regime} tax profile in force on ${day}`);
  return hit;
}
