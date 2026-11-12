import { describe, expect, it } from "vitest";
import { normalizeEntry, type RawEntry } from "../src/index.js";

const TODAY = "2026-11-12";
const sure = { kind: 0.95, amount: 0.95, date: 0.95, counterparty: 0.95, payment_method: 0.95 };

function raw(p: Partial<RawEntry>): RawEntry {
  return {
    kind: "sale",
    description: "Jual nasi box",
    amount_text: null,
    items: [],
    date_text: null,
    counterparty: null,
    payment_text: null,
    suggested_category: "Penjualan",
    confidence: sure,
    ...p,
  };
}

describe("normalizeEntry", () => {
  it("computes qty x unit price in code (F2 example)", () => {
    const msg = "jual nasi box 25 x 18rb transfer BCA";
    const e = normalizeEntry(
      raw({ items: [{ name: "nasi box", qty_text: "25", unit: null, unit_price_text: "18rb", line_total_text: null }], payment_text: "transfer BCA" }),
      msg,
      TODAY,
      0.7,
    );
    expect(e.amountIdr).toBe(450_000n);
    expect(e.paymentMethod).toBe("bank:BCA");
    expect(e.date).toBe(TODAY);
    expect(e.missing).toEqual([]);
    expect(e.lowConfidence).toEqual([]);
  });

  it("sums item line totals (Flow B)", () => {
    const msg = "tadi belanja ayam 5 kilo 175 ribu, minyak 2 liter 38 ribu, cash";
    const e = normalizeEntry(
      raw({
        kind: "expense",
        description: "Belanja bahan",
        items: [
          { name: "ayam", qty_text: "5", unit: "kilo", unit_price_text: null, line_total_text: "175 ribu" },
          { name: "minyak", qty_text: "2", unit: "liter", unit_price_text: null, line_total_text: "38 ribu" },
        ],
        date_text: "tadi",
        payment_text: "cash",
        suggested_category: "HPP / Bahan baku",
      }),
      msg,
      TODAY,
      0.7,
    );
    expect(e.amountIdr).toBe(213_000n);
    expect(e.items.map((i) => i.lineTotalIdr)).toEqual([175_000n, 38_000n]);
    expect(e.paymentMethod).toBe("cash");
  });

  it("prefers the stated total and flags a mismatch with the items", () => {
    const msg = "jual 3 x 10rb total 35rb cash";
    const e = normalizeEntry(
      raw({ amount_text: "35rb", items: [{ name: "kue", qty_text: "3", unit: null, unit_price_text: "10rb", line_total_text: null }] }),
      msg,
      TODAY,
      0.7,
    );
    expect(e.amountIdr).toBe(35_000n);
    expect(e.lowConfidence).toContain("amount");
  });

  it("ignores amounts the model invented (not in the message)", () => {
    const e = normalizeEntry(raw({ amount_text: "450rb" }), "jual nasi box cash", TODAY, 0.7);
    expect(e.amountIdr).toBeNull();
    expect(e.missing).toContain("amount");
  });

  it("reads slang amounts and relative dates", () => {
    const e = normalizeEntry(raw({ kind: "expense", amount_text: "goceng", date_text: "kemarin", payment_text: "cash" }), "parkir goceng kemarin cash", TODAY, 0.7);
    expect(e.amountIdr).toBe(5_000n);
    expect(e.date).toBe("2026-11-11");
  });

  it("falls back to the whole message for the payment method", () => {
    const e = normalizeEntry(raw({ amount_text: "50rb" }), "jual 50rb via gopay", TODAY, 0.7);
    expect(e.paymentMethod).toBe("ewallet:GoPay");
  });

  it("marks a missing payment method instead of guessing", () => {
    const e = normalizeEntry(raw({ amount_text: "50rb" }), "jual kue 50rb", TODAY, 0.7);
    expect(e.paymentMethod).toBeNull();
    expect(e.missing).toEqual(["payment_method"]);
  });

  it("flags low-confidence fields and unparseable dates", () => {
    const e = normalizeEntry(
      raw({ amount_text: "50rb", payment_text: "cash", date_text: "pas lebaran", confidence: { ...sure, counterparty: 0.4 } }),
      "jual kue 50rb cash pas lebaran",
      TODAY,
      0.7,
    );
    expect(e.date).toBe(TODAY);
    expect(e.lowConfidence.sort()).toEqual(["counterparty", "date"]);
  });

  it("handles fractional quantities exactly", () => {
    const msg = "beli daging 1,5 kg x 120rb cash";
    const e = normalizeEntry(
      raw({ kind: "expense", items: [{ name: "daging", qty_text: "1,5", unit: "kg", unit_price_text: "120rb", line_total_text: null }] }),
      msg,
      TODAY,
      0.7,
    );
    expect(e.amountIdr).toBe(180_000n);
  });
});
