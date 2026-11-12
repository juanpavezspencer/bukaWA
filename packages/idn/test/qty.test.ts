import { describe, expect, it } from "vitest";
import { multiplyQty, parseQty } from "../src/index.js";

describe("parseQty / multiplyQty", () => {
  it.each([
    ["25", 25_000n, 625_000n],
    ["2", 18_000n, 36_000n],
    ["1,5", 40_000n, 60_000n],
    ["0.5", 30_000n, 15_000n],
    ["setengah", 30_000n, 15_000n],
    ["sepuluh", 1_000n, 10_000n],
    ["dua", 18_000n, 36_000n],
    ["1/2", 30_000n, 15_000n],
  ])("%s x %s = %s", (qty, price, total) => {
    expect(multiplyQty(parseQty(qty)!, price)).toBe(total);
  });

  it("returns null when the product is not whole rupiah", () => {
    expect(multiplyQty(parseQty("0,333")!, 10n)).toBeNull();
  });

  it.each(["", "banyak", "-2", "0"])("rejects %j", (q) => {
    expect(parseQty(q)).toBeNull();
  });
});

// Voice transcripts spell quantities out.
describe("parseQty spoken", () => {
  it.each([
    ["dua puluh lima", 25n],
    ["lima belas", 15n],
    ["seratus", 100n],
  ])("%s -> %s", (input, num) => {
    expect(parseQty(input)).toEqual({ num, den: 1n });
  });

  it("rejects zero", () => {
    expect(parseQty("nol")).toBeNull();
  });
});
