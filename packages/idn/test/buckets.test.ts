import { describe, expect, it } from "vitest";
import { periodBuckets } from "../src/index.js";

describe("periodBuckets", () => {
  it("splits a range into days", () => {
    expect(periodBuckets("2026-11-10", "2026-11-12", "day")).toEqual([
      { from: "2026-11-10", to: "2026-11-10" },
      { from: "2026-11-11", to: "2026-11-11" },
      { from: "2026-11-12", to: "2026-11-12" },
    ]);
  });
  it("uses Monday-start weeks, clipped to the range", () => {
    expect(periodBuckets("2026-11-04", "2026-11-17", "week")).toEqual([
      { from: "2026-11-04", to: "2026-11-08" },
      { from: "2026-11-09", to: "2026-11-15" },
      { from: "2026-11-16", to: "2026-11-17" },
    ]);
  });
  it("uses calendar months, across a year end", () => {
    expect(periodBuckets("2026-11-15", "2027-01-10", "month")).toEqual([
      { from: "2026-11-15", to: "2026-11-30" },
      { from: "2026-12-01", to: "2026-12-31" },
      { from: "2027-01-01", to: "2027-01-10" },
    ]);
  });
  it("refuses inverted ranges and too many buckets", () => {
    expect(() => periodBuckets("2026-11-12", "2026-11-10", "day")).toThrow();
    expect(() => periodBuckets("2025-01-01", "2026-12-31", "day")).toThrow(/too many/);
  });
});
