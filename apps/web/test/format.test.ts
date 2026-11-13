import { describe, expect, it } from "vitest";
import { parseRupiahInput, presetRange, recentMonths, rp, rpShort } from "../lib/format.js";

describe("rp", () => {
  it("formats integer rupiah with dots", () => {
    expect(rp("1500000")).toBe("Rp 1.500.000");
    expect(rp("-25000")).toBe("-Rp 25.000");
    expect(rp(0n)).toBe("Rp 0");
    expect(rp("9007199254740993")).toBe("Rp 9.007.199.254.740.993");
  });
  it("shortens for axes", () => {
    expect(rpShort("1500000")).toBe("1,5 jt");
    expect(rpShort("250000")).toBe("250 rb");
    expect(rpShort("2000000000")).toBe("2 M");
  });
});

describe("parseRupiahInput", () => {
  it("reads what owners type", () => {
    expect(parseRupiahInput("150.000")).toBe(150_000n);
    expect(parseRupiahInput("Rp 150rb")).toBe(150_000n);
    expect(parseRupiahInput("1,5jt")).toBe(1_500_000n);
    expect(parseRupiahInput("175000")).toBe(175_000n);
  });
  it("refuses unclear amounts", () => {
    expect(parseRupiahInput("12,5")).toBeNull();
    expect(parseRupiahInput("0")).toBeNull();
    expect(parseRupiahInput("abc")).toBeNull();
  });
});

describe("presetRange", () => {
  it("is relative to the business's today", () => {
    expect(presetRange("7d", "2026-11-13")).toEqual({ from: "2026-11-07", to: "2026-11-13", bucket: "day" });
    expect(presetRange("lastMonth", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28", bucket: "week" });
    expect(presetRange("lastMonth", "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("year", "2026-11-13")).toEqual({ from: "2026-01-01", to: "2026-11-13", bucket: "month" });
  });
  it("lists recent months across a year boundary", () => {
    expect(recentMonths("2026-02-10", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
  });
});
