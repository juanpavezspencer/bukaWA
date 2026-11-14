import { describe, expect, it } from "vitest";
import { nextMonthlyRun, parseMonthPhrase, parseTaxRequest } from "../src/index.js";

const TODAY = "2026-11-13";

describe("parseMonthPhrase", () => {
  it.each([
    ["bulan ini", "2026-11"],
    ["bulan lalu", "2026-10"],
    ["bulan kemarin", "2026-10"],
    ["oktober", "2026-10"],
    ["okt", "2026-10"],
    ["bulan september", "2026-09"],
    ["desember", "2025-12"], // a month name later than now means last year
    ["maret 2025", "2025-03"],
    ["nop", "2026-11"],
  ])("%s -> %s", (text, month) => {
    expect(parseMonthPhrase(text, TODAY)?.month).toBe(month);
  });
  it("crosses the year in January", () => {
    expect(parseMonthPhrase("bulan lalu", "2027-01-05")?.month).toBe("2026-12");
  });
  it("finds nothing in unrelated text", () => {
    expect(parseMonthPhrase("pajak berapa", TODAY)).toBeNull();
  });
});

describe("parseTaxRequest", () => {
  it.each([
    ["pajak bulan ini berapa?", { action: "estimate", month: "2026-11" }],
    ["berapa pajak oktober", { action: "estimate", month: "2026-10" }],
    ["pajakku berapa", { action: "estimate", month: null }],
    ["cek pph final bulan lalu dong", { action: "estimate", month: "2026-10" }],
    ["pajak yang harus dibayar bulan lalu berapa", { action: "estimate", month: "2026-10" }],
    ["Pajak?", { action: "estimate", month: null }],
    ["pajak bulan ini harus bayar berapa?", { action: "estimate", month: "2026-11" }],
  ])("estimate: %s", (text, expected) => {
    expect(parseTaxRequest(text, TODAY)).toEqual(expected);
  });

  it.each([
    ["lihat laporan", { action: "report", month: null, format: "pdf" }],
    ["minta laporan bulan lalu", { action: "report", month: "2026-10", format: "pdf" }],
    ["kirim laporan oktober excel ya", { action: "report", month: "2026-10", format: "xlsx" }],
    ["laporan pajak september dalam bentuk xlsx", { action: "report", month: "2026-09", format: "xlsx" }],
    ["laporan keuangan bulan ini pdf", { action: "report", month: "2026-11", format: "pdf" }],
  ])("report: %s", (text, expected) => {
    expect(parseTaxRequest(text, TODAY)).toEqual(expected);
  });

  it.each([
    ["stop pengingat pajak", { action: "notice", enabled: false }],
    ["matikan reminder pajak", { action: "notice", enabled: false }],
    ["nyalakan pengingat pajak", { action: "notice", enabled: true }],
  ])("notice: %s", (text, expected) => {
    expect(parseTaxRequest(text, TODAY)).toEqual(expected);
  });

  it.each([
    "bayar pajak 150rb tf bca", // a transaction to record
    "setor pph final oktober 150 ribu",
    "bayar pajak oktober", // no question: leave it to the router
    "kenapa pajaknya segitu?", // a real question: the agent answers
    "gimana cara lapor pajak di coretax",
    "laporan harian jam 9 malam", // summary settings, handled elsewhere
    "jual nasi box 25 x 18rb",
    "laporan penjualan nasi box minggu ini paling laku apa aja sih kak",
  ])("leaves %j to the other handlers", (text) => {
    expect(parseTaxRequest(text, TODAY)).toBeNull();
  });
});

describe("nextMonthlyRun", () => {
  it("is the 1st of next month at the local time", () => {
    // 08:00 WIB on 1 Dec 2026 = 01:00 UTC.
    expect(nextMonthlyRun("Asia/Jakarta", new Date("2026-11-13T05:00:00Z"), "08:00").toISOString()).toBe("2026-12-01T01:00:00.000Z");
  });
  it("is later today when it is the 1st and the time hasn't passed", () => {
    expect(nextMonthlyRun("Asia/Jakarta", new Date("2026-11-30T23:30:00Z"), "08:00").toISOString()).toBe("2026-12-01T01:00:00.000Z");
  });
  it("moves on to the next month once the time has passed", () => {
    expect(nextMonthlyRun("Asia/Jakarta", new Date("2026-12-01T01:00:00Z"), "08:00").toISOString()).toBe("2027-01-01T01:00:00.000Z");
    expect(nextMonthlyRun("Asia/Makassar", new Date("2026-12-01T23:00:00Z"), "08:00").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
