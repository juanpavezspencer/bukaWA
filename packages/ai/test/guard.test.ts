import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "../src/index.js";

const tools = [JSON.stringify({ period: { from: "2026-11-09", to: "2026-11-12" }, income: "Rp 1.250.000", expenses: "Rp 525.000", profit: "Rp 725.000", change_pct: "+12,5%", count: 14 })];

describe("unsupportedNumbers", () => {
  it("accepts numbers that appear in tool results, however they are grouped", () => {
    expect(unsupportedNumbers("Untung minggu ini *Rp 725.000* dari 14 transaksi (9-12 Nov), naik 12,5%.", tools)).toEqual([]);
    expect(unsupportedNumbers("Pemasukan Rp1.250.000, pengeluaran Rp 525.000", tools)).toEqual([]);
  });

  it("flags numbers the model made up or computed", () => {
    expect(unsupportedNumbers("Untung Rp 800.000, rata-rata Rp 51.786 per transaksi", tools)).toEqual(["800.000", "51.786"]);
  });

  it("ignores single digits used in prose", () => {
    expect(unsupportedNumbers("Ini 3 biaya terbesar:", tools)).toEqual([]);
  });

  it("also accepts numbers the owner wrote in the question", () => {
    expect(unsupportedNumbers("Yang Rp 450.000 itu ya?", tools, "yang 450rb kemarin")).toEqual(["450.000"]);
    expect(unsupportedNumbers("Yang Rp 450.000 itu ya?", [...tools, "450000"])).toEqual([]);
  });
});
