import { describe, expect, it } from "vitest";
import { categorize, normalizePattern, patternsFor, type Account, type NormalizedEntry } from "../src/index.js";

const accounts: Account[] = [
  { code: "1300", name: "Persediaan", type: "asset" },
  { code: "4100", name: "Penjualan", type: "income" },
  { code: "5100", name: "HPP / Bahan baku", type: "expense" },
  { code: "6300", name: "Listrik & air", type: "expense" },
  { code: "6900", name: "Lain-lain", type: "expense" },
];

function entry(p: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    kind: "expense",
    description: "Belanja ayam",
    amountIdr: 1n,
    date: "2026-11-12",
    counterparty: null,
    paymentMethod: "cash",
    items: [],
    suggestedCategory: null,
    lowConfidence: [],
    missing: [],
    ...p,
  };
}

describe("categorize", () => {
  it("uses a learned rule before the model's suggestion", () => {
    const r = categorize(entry({ suggestedCategory: "Lain-lain" }), [{ pattern: "ayam", kind: "expense", accountCode: "5100" }], accounts);
    expect(r).toEqual({ accountCode: "5100", source: "rule" });
  });

  it("falls back to the model's suggestion when it fits the kind", () => {
    expect(categorize(entry({ description: "Bayar listrik", suggestedCategory: "Listrik & air" }), [], accounts)).toEqual({
      accountCode: "6300",
      source: "model",
    });
  });

  it("ignores a suggestion that doesn't fit the kind", () => {
    expect(categorize(entry({ kind: "sale", suggestedCategory: "Listrik & air" }), [], accounts).source).toBe("default");
  });

  it("ignores rules for the other kind", () => {
    expect(categorize(entry({ kind: "sale" }), [{ pattern: "ayam", kind: "expense", accountCode: "5100" }], accounts).source).toBe("default");
  });
});

describe("patterns", () => {
  it("drops verbs, numbers and short words", () => {
    expect(normalizePattern("Belanja ayam 5 kg")).toBe("ayam");
    expect(normalizePattern("Bayar listrik bulan Nov")).toBe("listrik bulan");
    expect(normalizePattern("tf 50")).toBeNull();
  });

  it("learns from item names, else the description", () => {
    expect(patternsFor({ items: [{ name: "Ayam", qtyText: null, unit: null, unitPriceIdr: null, lineTotalIdr: 1n }, { name: "minyak goreng", qtyText: null, unit: null, unitPriceIdr: null, lineTotalIdr: 1n }], description: "x" })).toEqual(["ayam", "minyak goreng"]);
    expect(patternsFor({ items: [], description: "Bayar listrik" })).toEqual(["listrik"]);
  });
});
