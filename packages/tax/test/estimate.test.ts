import { describe, expect, it } from "vitest";
import {
  estimateMonthlyTax,
  formatRate,
  monthOf,
  monthRange,
  paymentDueDate,
  previousMonth,
  profileForMonth,
  TaxError,
  ytdBeforeRange,
  type TaxProfile,
} from "../src/index.js";

// Test fixture shaped like the seeded default profile; the real values live in
// the tax_profiles table, never in code.
const UMKM: TaxProfile = {
  id: "p-umkm",
  regime: "umkm_final_individual",
  name: "PPh final UMKM (orang pribadi)",
  rateBps: 50,
  annualExemptThresholdIdr: 500_000_000n,
  annualTurnoverCapIdr: 4_800_000_000n,
  paymentDueDay: 15,
  validFrom: "2018-07-01",
  validTo: null,
};

const est = (turnoverIdr: bigint, ytdBeforeIdr: bigint, month = "2026-10", profile = UMKM) =>
  estimateMonthlyTax({ profile, month, turnoverIdr, ytdBeforeIdr });

describe("estimateMonthlyTax", () => {
  it("is zero while cumulative turnover stays under the exempt threshold", () => {
    const e = est(40_000_000n, 300_000_000n);
    expect(e).toMatchObject({
      turnoverIdr: 40_000_000n,
      ytdTurnoverIdr: 340_000_000n,
      exemptUsedThisMonthIdr: 40_000_000n,
      exemptRemainingIdr: 160_000_000n,
      taxableTurnoverIdr: 0n,
      taxIdr: 0n,
      overTurnoverCap: false,
    });
  });

  it("taxes only the part of the month above the threshold, in the month it is crossed", () => {
    // 480M before; 50M this month -> 20M exempt, 30M taxable at 0.5%.
    const e = est(50_000_000n, 480_000_000n);
    expect(e.exemptUsedThisMonthIdr).toBe(20_000_000n);
    expect(e.taxableTurnoverIdr).toBe(30_000_000n);
    expect(e.taxIdr).toBe(150_000n);
    expect(e.exemptRemainingIdr).toBe(0n);
  });

  it("taxes the whole month once the threshold is used up", () => {
    const e = est(80_000_000n, 600_000_000n);
    expect(e.exemptUsedThisMonthIdr).toBe(0n);
    expect(e.taxableTurnoverIdr).toBe(80_000_000n);
    expect(e.taxIdr).toBe(400_000n);
  });

  it("hits the threshold exactly: nothing taxable yet", () => {
    const e = est(20_000_000n, 480_000_000n);
    expect(e.taxableTurnoverIdr).toBe(0n);
    expect(e.exemptRemainingIdr).toBe(0n);
  });

  it("rounds tax down to whole rupiah with integer arithmetic", () => {
    // 1.234.567 * 0.5% = 6.172,835 -> 6.172
    const e = est(1_234_567n, 600_000_000n);
    expect(e.taxIdr).toBe(6_172n);
  });

  it("applies no exemption when the profile has none (e.g. a company regime)", () => {
    const badan = { ...UMKM, id: "p-badan", regime: "umkm_final_corporate", annualExemptThresholdIdr: 0n };
    const e = est(10_000_000n, 0n, "2026-01", badan);
    expect(e.taxIdr).toBe(50_000n);
    expect(e.exemptRemainingIdr).toBe(0n);
  });

  it("treats a negative month (more returns than sales) as zero taxable turnover", () => {
    const e = est(-2_000_000n, 600_000_000n);
    expect(e.taxableTurnoverIdr).toBe(0n);
    expect(e.taxIdr).toBe(0n);
    expect(e.exemptUsedThisMonthIdr).toBe(0n);
    expect(e.ytdTurnoverIdr).toBe(598_000_000n);
  });

  it("gives allowance back when returns lower the year-to-date total", () => {
    expect(est(-10_000_000n, 300_000_000n).exemptRemainingIdr).toBe(210_000_000n);
  });

  it("flags turnover above the regime's annual cap", () => {
    expect(est(100_000_000n, 4_750_000_000n).overTurnoverCap).toBe(true);
    expect(est(50_000_000n, 4_750_000_000n).overTurnoverCap).toBe(false);
    expect(est(1n, 0n, "2026-10", { ...UMKM, annualTurnoverCapIdr: null }).overTurnoverCap).toBe(false);
  });

  it("carries the rate, the due date and the inputs through", () => {
    const e = est(10_000_000n, 0n, "2026-10");
    expect(e).toMatchObject({ month: "2026-10", regime: UMKM.regime, rateBps: 50, ytdBeforeIdr: 0n, dueDate: "2026-11-16" });
  });

  it("rejects a malformed month or a negative year-to-date", () => {
    expect(() => est(1n, 0n, "2026-13")).toThrow(TaxError);
    expect(() => est(1n, 0n, "Oktober")).toThrow(TaxError);
    expect(() => est(1n, -1n)).toThrow(TaxError);
  });
});

describe("paymentDueDate", () => {
  it("is the due day of the following month", () => {
    expect(paymentDueDate("2026-09", 15)).toBe("2026-10-15"); // Thursday
  });
  it("moves a weekend due date to the next Monday", () => {
    expect(paymentDueDate("2026-10", 15)).toBe("2026-11-16"); // 15 Nov 2026 is a Sunday
    expect(paymentDueDate("2026-07", 15)).toBe("2026-08-17"); // Saturday -> Monday
  });
  it("rolls December into January of the next year", () => {
    expect(paymentDueDate("2026-12", 15)).toBe("2027-01-15");
  });
});

describe("month helpers", () => {
  it("gives the calendar range of a month, leap years included", () => {
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });
  it("gives January 1 up to the end of the previous month, or null in January", () => {
    expect(ytdBeforeRange("2026-10")).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(ytdBeforeRange("2026-01")).toBeNull();
  });
  it("steps back a month across the year boundary", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-11")).toBe("2026-10");
  });
  it("takes the month of a date", () => {
    expect(monthOf("2026-11-13")).toBe("2026-11");
  });
  it("formats basis points as an Indonesian percentage", () => {
    expect(formatRate(50)).toBe("0,5%");
    expect(formatRate(100)).toBe("1%");
    expect(formatRate(1125)).toBe("11,25%");
  });
});

describe("profileForMonth", () => {
  const old: TaxProfile = { ...UMKM, id: "p-old", rateBps: 100, validFrom: "2013-07-01", validTo: "2018-06-30" };
  const all = [old, UMKM];

  it("picks the profile of the regime that is valid for the month", () => {
    expect(profileForMonth(all, "umkm_final_individual", "2026-10").id).toBe("p-umkm");
    expect(profileForMonth(all, "umkm_final_individual", "2017-03").id).toBe("p-old");
  });
  it("uses the profile in force at the start of the month", () => {
    expect(profileForMonth(all, "umkm_final_individual", "2018-06").id).toBe("p-old");
    expect(profileForMonth(all, "umkm_final_individual", "2018-07").id).toBe("p-umkm");
  });
  it("throws when no profile covers the month or the regime is unknown", () => {
    expect(() => profileForMonth(all, "umkm_final_individual", "2010-01")).toThrow(TaxError);
    expect(() => profileForMonth(all, "pph_badan", "2026-10")).toThrow(TaxError);
  });
  it("throws when two profiles overlap, rather than guessing", () => {
    expect(() => profileForMonth([UMKM, { ...UMKM, id: "dup" }], "umkm_final_individual", "2026-10")).toThrow(/overlap/);
  });
});
