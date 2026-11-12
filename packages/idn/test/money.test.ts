import { describe, expect, it } from "vitest";
import { formatRupiah, parseRupiah } from "../src/index.js";

describe("parseRupiah", () => {
  it.each([
    ["0", 0n],
    ["nol", 0n],
    ["500000", 500_000n],
    ["500.000", 500_000n],
    ["1.500.000", 1_500_000n],
    ["1,500,000", 1_500_000n],
    ["Rp 1.500.000", 1_500_000n],
    ["rp1.500.000,-", 1_500_000n],
    ["500rb", 500_000n],
    ["500 rb", 500_000n],
    ["500 ribu", 500_000n],
    ["500 rebu", 500_000n],
    ["18rb", 18_000n],
    ["450k", 450_000n],
    ["450K", 450_000n],
    ["2jt", 2_000_000n],
    ["2 juta", 2_000_000n],
    ["1,5jt", 1_500_000n],
    ["1.5jt", 1_500_000n],
    ["1.25 juta", 1_250_000n],
    ["2,5rb", 2_500n],
    ["1.500rb", 1_500_000n],
    ["2jt 500rb", 2_500_000n],
    ["1 juta 200 ribu", 1_200_000n],
    ["ceban", 10_000n],
    ["goceng", 5_000n],
    ["gopek", 500n],
    ["seceng", 1_000n],
    ["seribu", 1_000n],
    ["sejuta", 1_000_000n],
    ["setengah juta", 500_000n],
    ["2 miliar", 2_000_000_000n],
    ["500 ribu rupiah", 500_000n],
    ["  300rb  ", 300_000n],
  ])("%s -> %s", (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "-500rb",
    "1,5",
    "1.2345rb",
    "500rb buat beli ayam",
    "rb",
    "12.34.567",
  ])("rejects %j", (input) => {
    expect(parseRupiah(input)).toBeNull();
  });

  it("never loses precision on large amounts", () => {
    expect(parseRupiah("9.007.199.254.740.993")).toBe(9_007_199_254_740_993n);
  });
});

describe("formatRupiah", () => {
  it.each([
    [0n, "Rp 0"],
    [500n, "Rp 500"],
    [1_500_000n, "Rp 1.500.000"],
    [-45_000n, "-Rp 45.000"],
  ])("%s -> %s", (n, s) => {
    expect(formatRupiah(n)).toBe(s);
  });
});

// Amounts as printed on receipts, with zero cents.
describe("parseRupiah on printed amounts", () => {
  it.each([
    ["450.000,00", 450_000n],
    ["Rp 1.250.000,00", 1_250_000n],
    ["IDR 450,000.00", 450_000n],
    ["Rp450.000", 450_000n],
    ["Rp 35.500", 35_500n],
  ])("%s -> %s", (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });

  it("rejects non-zero cents", () => {
    expect(parseRupiah("450.000,50")).toBeNull();
  });
});
