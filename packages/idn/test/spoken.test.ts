import { describe, expect, it } from "vitest";
import { parseRupiah, parseSpokenNumber } from "../src/index.js";

// Voice notes come back from speech-to-text with numbers spelled out.
describe("parseSpokenNumber", () => {
  it.each([
    ["satu", 1n],
    ["sepuluh", 10n],
    ["sebelas", 11n],
    ["lima belas", 15n],
    ["dua puluh", 20n],
    ["tujuh puluh lima", 75n],
    ["seratus", 100n],
    ["lima ratus", 500n],
    ["seratus tujuh puluh lima", 175n],
    ["seribu", 1_000n],
    ["lima ribu", 5_000n],
    ["tiga puluh delapan ribu", 38_000n],
    ["seratus tujuh puluh lima ribu", 175_000n],
    ["dua ratus lima puluh ribu", 250_000n],
    ["dua belas ribu lima ratus", 12_500n],
    ["sejuta", 1_000_000n],
    ["dua juta tiga ratus ribu", 2_300_000n],
    ["satu setengah juta", 1_500_000n],
    ["dua setengah juta", 2_500_000n],
    ["dua juta setengah", 2_500_000n],
    ["seratus ribu rupiah", 100_000n],
    ["dua juta 300 ribu", 2_300_000n],
    ["Seratus Ribu", 100_000n],
    ["seratus-ribu", 100_000n],
    // Javanese
    ["rong atus ewu", 200_000n],
    ["sewu", 1_000n],
    ["satus seket ewu", 150_000n],
    ["selawe ewu", 25_000n],
    ["telung yuta", 3_000_000n],
    // Sundanese
    ["tilu rebu", 3_000n],
    ["saratus rebu", 100_000n],
    ["genep welas rebu", 16_000n],
  ])("%s -> %s", (input, expected) => {
    expect(parseSpokenNumber(input)).toBe(expected);
  });

  it.each(["", "ribu", "juta", "puluh", "ayam", "seratus ayam", "dua tiga", "ribu ribu", "setengah", "dua setengah"])(
    "rejects %j",
    (input) => {
      expect(parseSpokenNumber(input)).toBeNull();
    },
  );
});

describe("parseRupiah with spoken amounts", () => {
  it.each([
    ["seratus tujuh puluh lima ribu", 175_000n],
    ["tiga puluh delapan ribu rupiah", 38_000n],
    ["Rp dua juta", 2_000_000n],
  ])("%s -> %s", (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });

  it("still rejects free text", () => {
    expect(parseRupiah("seratus ribu buat ayam")).toBeNull();
  });
});
