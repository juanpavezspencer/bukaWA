import { describe, expect, it } from "vitest";
import { categorize, categorizeItems, normalizePattern, patternsFor, type Account, type NormalizedEntry } from "../src/index.js";

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

describe("categorizeItems", () => {
  const item = (name: string, total: bigint | null) => ({ name, qtyText: null, unit: null, unitPriceIdr: null, lineTotalIdr: total });
  const rules = [
    { pattern: "ayam", kind: "expense", accountCode: "5100" },
    { pattern: "token listrik", kind: "expense", accountCode: "6300" },
  ];

  it("gives each item its own learned category when they differ", () => {
    const e = entry({ amountIdr: 275_000n, items: [item("ayam", 175_000n), item("token listrik", 100_000n)] });
    expect(categorizeItems(e, "5100", rules, accounts)).toEqual(["5100", "6300"]);
  });

  it("falls back to the entry category for items without a rule", () => {
    const e = entry({ amountIdr: 213_000n, items: [item("ayam", 175_000n), item("plastik", 38_000n)] });
    expect(categorizeItems(e, "6900", rules, accounts)).toEqual(["5100", "6900"]);
  });

  it("returns null when every item lands in the same category", () => {
    const e = entry({ amountIdr: 213_000n, items: [item("ayam", 175_000n), item("ayam kampung", 38_000n)] });
    expect(categorizeItems(e, "5100", rules, accounts)).toBeNull();
  });

  it("returns null when item totals don't add up to the amount (tax, discount)", () => {
    const e = entry({ amountIdr: 250_000n, items: [item("ayam", 175_000n), item("token listrik", 100_000n)] });
    expect(categorizeItems(e, "5100", rules, accounts)).toBeNull();
  });

  it("returns null when an item total is unknown, or for other kinds", () => {
    expect(categorizeItems(entry({ amountIdr: 275_000n, items: [item("ayam", 175_000n), item("token listrik", null)] }), "5100", rules, accounts)).toBeNull();
    expect(categorizeItems(entry({ kind: "owner_drawing", amountIdr: 275_000n, items: [item("ayam", 175_000n), item("token listrik", 100_000n)] }), "5100", rules, accounts)).toBeNull();
  });
});
