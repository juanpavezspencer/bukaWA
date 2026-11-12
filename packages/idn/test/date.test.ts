import { describe, expect, it } from "vitest";
import { parseIdDate } from "../src/index.js";

// Thursday 12 Nov 2026
const TODAY = "2026-11-12";

describe("parseIdDate", () => {
  it.each([
    ["hari ini", "2026-11-12"],
    ["tadi", "2026-11-12"],
    ["td pagi", "2026-11-12"],
    ["barusan", "2026-11-12"],
    ["kemarin", "2026-11-11"],
    ["kemaren", "2026-11-11"],
    ["kmrn", "2026-11-11"],
    ["kemarin sore", "2026-11-11"],
    ["2 hari lalu", "2026-11-10"],
    ["3 hari yang lalu", "2026-11-09"],
    ["Senin", "2026-11-09"],
    ["hari senin", "2026-11-09"],
    ["kamis", "2026-11-12"],
    ["jumat", "2026-11-06"],
    ["Jum'at", "2026-11-06"],
    ["minggu", "2026-11-08"],
    ["12/11", "2026-11-12"],
    ["1/11", "2026-11-01"],
    ["5/10/2026", "2026-10-05"],
    ["05-10-26", "2026-10-05"],
    ["12 Nov", "2026-11-12"],
    ["3 november", "2026-11-03"],
    ["tgl 3", "2026-11-03"],
    ["tanggal 10", "2026-11-10"],
    ["28 Des", "2025-12-28"],
    ["15 Agustus 2026", "2026-08-15"],
    ["2026-11-01", "2026-11-01"],
  ])("%s -> %s", (input, expected) => {
    expect(parseIdDate(input, TODAY)).toBe(expected);
  });

  it.each(["", "besok", "lusa", "31/02", "tgl 40", "minggu depan", "pokoknya"])("rejects %j", (input) => {
    expect(parseIdDate(input, TODAY)).toBeNull();
  });

  it("rolls a day-of-month in the future back to last month", () => {
    expect(parseIdDate("tgl 20", TODAY)).toBe("2026-10-20");
  });
});

// Dates as printed on receipts and m-banking screenshots.
describe("parseIdDate on receipt timestamps", () => {
  it.each([
    ["2026-11-12 14:03", "2026-11-12"],
    ["2026-11-10T09:15:00", "2026-11-10"],
    ["12/11/2026 14:03:22", "2026-11-12"],
    ["12 Nov 2026 14:03 WIB", "2026-11-12"],
    ["10 Dec 2025", "2025-12-10"],
    ["5 Oct", "2026-10-05"],
    ["3 May 2026", "2026-05-03"],
    ["17 Aug 2026", "2026-08-17"],
    ["Nov 10, 2026", "2026-11-10"],
    ["Selasa, 10 November 2026", "2026-11-10"],
  ])("%s -> %s", (input, expected) => {
    expect(parseIdDate(input, TODAY)).toBe(expected);
  });
});

// Javanese and Sundanese "yesterday", common in voice notes.
describe("parseIdDate regional words", () => {
  it.each([["wingi", "2026-11-11"], ["kamari", "2026-11-11"], ["wingi sore", "2026-11-11"]])("%s -> %s", (input, expected) => {
    expect(parseIdDate(input, TODAY)).toBe(expected);
  });
});
