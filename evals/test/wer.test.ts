import { describe, expect, it } from "vitest";
import { wer } from "../src/wer.js";

describe("wer", () => {
  it("is 0 for identical text, ignoring case and punctuation", () => {
    expect(wer("Belanja ayam, seratus ribu.", "belanja ayam seratus ribu")).toBe(0);
  });
  it("counts substitutions, insertions and deletions", () => {
    expect(wer("belanja ayam seratus ribu", "belanja ayam dua ratus ribu")).toBe(0.5); // 1 sub + 1 ins over 4
    expect(wer("a b c d", "a c d")).toBe(0.25);
  });
});
