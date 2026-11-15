import { describe, expect, it } from "vitest";
import { median, pilotBusiness, summarizeCohorts, type PilotBusinessRow } from "../src/pilot.js";

const NOW = new Date("2026-11-13T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function row(p: Partial<PilotBusinessRow>): PilotBusinessRow {
  return {
    id: "b",
    name: "Biz",
    cohort: "bandung-fnb",
    createdAt: daysAgo(60),
    weeklyTx: [],
    tx7d: 0,
    confirmedClean: 0,
    confirmedReversed: 0,
    cancelled: 0,
    llmMicroIdr: 0n,
    waIdr: 0n,
    ...p,
  };
}

describe("pilotBusiness", () => {
  it("judges week-8 retention only once week 8 is over", () => {
    expect(pilotBusiness(row({ createdAt: daysAgo(55) }), NOW).retained).toBeNull(); // 7 full weeks
    expect(pilotBusiness(row({ createdAt: daysAgo(56), weeklyTx: [9, 9, 9, 9, 9, 9, 9, 3] }), NOW).retained).toBe(true);
    expect(pilotBusiness(row({ createdAt: daysAgo(70), weeklyTx: [9, 9, 9, 9, 9, 9, 9, 2, 9] }), NOW).retained).toBe(false);
  });

  it("counts auto-confirm as confirmed and never reversed, over everything closed", () => {
    expect(pilotBusiness(row({ confirmedClean: 7, confirmedReversed: 1, cancelled: 2 }), NOW).autoConfirmPct).toBe(70);
    expect(pilotBusiness(row({}), NOW).autoConfirmPct).toBeNull();
  });

  it("adds model and WhatsApp cost in rupiah", () => {
    expect(pilotBusiness(row({ llmMicroIdr: 2_400_000n * 500n, waIdr: 700n }), NOW).costIdr).toBe(1900n);
  });
});

describe("summarizeCohorts", () => {
  it("rolls businesses up by cohort, with a total", () => {
    const { cohorts, total } = summarizeCohorts(
      [
        row({ id: "1", cohort: "bandung-fnb", tx7d: 20, createdAt: daysAgo(60), weeklyTx: [0, 0, 0, 0, 0, 0, 0, 5], confirmedClean: 8, cancelled: 2, waIdr: 3000n }),
        row({ id: "2", cohort: "bandung-fnb", tx7d: 10, createdAt: daysAgo(60), weeklyTx: [], waIdr: 1000n }),
        row({ id: "3", cohort: "bandung-fnb", tx7d: 0, createdAt: daysAgo(10) }),
        row({ id: "4", cohort: null, tx7d: 4 }),
      ],
      NOW,
    );
    expect(cohorts.map((c) => c.cohort)).toEqual(["(tanpa kode)", "bandung-fnb"]);
    expect(cohorts[1]).toMatchObject({
      businesses: 3,
      active: 2,
      retentionEligible: 2,
      retained: 1,
      retentionPct: 50,
      txPerActivePerWeek: 15,
      autoConfirmPct: 80,
      costIdr: 4000n,
      costPerActiveIdr: 2000n,
    });
    expect(total.businesses).toBe(4);
    expect(total.active).toBe(3);
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});
