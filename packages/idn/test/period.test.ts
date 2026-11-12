import { describe, expect, it } from "vitest";
import { PERIOD_PRESETS, resolvePeriod } from "../src/index.js";

const TODAY = "2026-11-12"; // Thursday

describe("resolvePeriod", () => {
  it.each([
    ["today", "2026-11-12", "2026-11-12"],
    ["yesterday", "2026-11-11", "2026-11-11"],
    ["this_week", "2026-11-09", "2026-11-12"], // weeks start Monday, up to today
    ["last_week", "2026-11-02", "2026-11-08"],
    ["this_month", "2026-11-01", "2026-11-12"],
    ["last_month", "2026-10-01", "2026-10-31"],
    ["this_year", "2026-01-01", "2026-11-12"],
    ["last_7_days", "2026-11-06", "2026-11-12"],
    ["last_30_days", "2026-10-14", "2026-11-12"],
  ] as const)("%s -> %s..%s", (preset, from, to) => {
    expect(resolvePeriod(preset, TODAY)).toEqual({ from, to });
  });

  it("handles month and year boundaries", () => {
    expect(resolvePeriod("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolvePeriod("last_month", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolvePeriod("this_week", "2026-11-09")).toEqual({ from: "2026-11-09", to: "2026-11-09" }); // Monday
    expect(resolvePeriod("this_week", "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-15" }); // Sunday
  });

  it("lists every preset", () => {
    expect(PERIOD_PRESETS).toHaveLength(9);
  });
});
