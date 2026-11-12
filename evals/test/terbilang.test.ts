import { describe, expect, it } from "vitest";
import { parseRupiah } from "@bukuwa/idn";
import { terbilang, terbilangJawa } from "../src/terbilang.js";

describe("terbilang", () => {
  it.each([
    [175_000, "seratus tujuh puluh lima ribu"],
    [12_500, "dua belas ribu lima ratus"],
    [1_200_000, "satu juta dua ratus ribu"],
    [11_000, "sebelas ribu"],
    [1_000, "seribu"],
  ])("%d -> %s", (n, words) => {
    expect(terbilang(n)).toBe(words);
  });

  it("round-trips through the idn parser", () => {
    for (let n = 1_000; n <= 3_000_000; n += 7_500) expect(parseRupiah(terbilang(n)), terbilang(n)).toBe(BigInt(n));
  });

  it("says Javanese thousands the parser understands", () => {
    expect(terbilangJawa(250_000)).toBe("rong atus seket ewu");
    expect(terbilangJawa(25_000)).toBe("selawe ewu");
    for (let n = 1_000; n < 1_000_000; n += 1_000) {
      const w = terbilangJawa(n);
      if (w) expect(parseRupiah(w), w).toBe(BigInt(n));
    }
  });
});
