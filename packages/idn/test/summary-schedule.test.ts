import { describe, expect, it } from "vitest";
import { nextSummaryRun, parseSummaryRequest, summaryPeriod } from "../src/index.js";

describe("parseSummaryRequest", () => {
  it.each([
    ["kirim ringkasan tiap hari jam 9 malam", { action: "set", frequency: "daily", time: "21:00", weekday: null }],
    ["rekap harian jam 20.30 ya", { action: "set", frequency: "daily", time: "20:30", weekday: null }],
    ["minta laporan harian setiap jam 7 pagi", { action: "set", frequency: "daily", time: "07:00", weekday: null }],
    ["ringkasan tiap hari jam 21:00", { action: "set", frequency: "daily", time: "21:00", weekday: null }],
    ["ringkasan mingguan tiap senin jam 8 pagi", { action: "set", frequency: "weekly", time: "08:00", weekday: 1 }],
    ["kirim rekap tiap hari minggu jam 7 malam", { action: "set", frequency: "weekly", time: "19:00", weekday: 0 }],
    ["ringkasan seminggu sekali hari sabtu jam 5 sore", { action: "set", frequency: "weekly", time: "17:00", weekday: 6 }],
    ["ringkasan mingguan jam 9 malam", { action: "set", frequency: "weekly", time: "21:00", weekday: 0 }],
    ["ringkasan harian jam 12 siang", { action: "set", frequency: "daily", time: "12:00", weekday: null }],
    ["rekap harian jam 1 siang", { action: "set", frequency: "daily", time: "13:00", weekday: null }],
  ])("%s", (text, expected) => {
    expect(parseSummaryRequest(text)).toEqual(expected);
  });

  it("asks for a time when none is given", () => {
    expect(parseSummaryRequest("kirim ringkasan harian dong")).toEqual({ action: "set", frequency: "daily", time: null, weekday: null });
  });

  it("turns summaries off", () => {
    for (const t of ["stop ringkasan", "matikan rekap harian", "jangan kirim ringkasan lagi", "berhenti kirim laporan harian"]) {
      expect(parseSummaryRequest(t), t).toEqual({ action: "off" });
    }
  });

  it("sends one now", () => {
    for (const t of ["kirim ringkasan sekarang", "ringkasan hari ini", "rekap dong"]) expect(parseSummaryRequest(t), t).toEqual({ action: "now" });
  });

  it("ignores messages that aren't about summaries", () => {
    for (const t of ["jual nasi box 25 x 18rb", "untung minggu ini berapa?", "jam 9 malam belanja ayam 50rb", "laporan pajak bulan lalu", "minggu ini omzet berapa"]) {
      expect(parseSummaryRequest(t), t).toBeNull();
    }
  });

  it("rejects impossible times", () => {
    expect(parseSummaryRequest("ringkasan harian jam 25")).toEqual({ action: "set", frequency: "daily", time: null, weekday: null });
  });
});

describe("nextSummaryRun", () => {
  // 2026-11-12 is a Thursday. 14:00 UTC = 21:00 WIB.
  it("daily: later today if the time hasn't passed, else tomorrow (WIB)", () => {
    const s = { frequency: "daily" as const, time: "21:00", weekday: null };
    expect(nextSummaryRun(s, "Asia/Jakarta", new Date("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-12T14:00:00.000Z");
    expect(nextSummaryRun(s, "Asia/Jakarta", new Date("2026-11-12T14:00:00Z")).toISOString()).toBe("2026-11-13T14:00:00.000Z");
    expect(nextSummaryRun(s, "Asia/Jakarta", new Date("2026-11-12T18:00:00Z")).toISOString()).toBe("2026-11-13T14:00:00.000Z");
  });

  it("uses the business's Indonesian timezone", () => {
    const s = { frequency: "daily" as const, time: "07:00", weekday: null };
    expect(nextSummaryRun(s, "Asia/Makassar", new Date("2026-11-12T00:00:00Z")).toISOString()).toBe("2026-11-12T23:00:00.000Z");
    expect(nextSummaryRun(s, "Asia/Jayapura", new Date("2026-11-12T00:00:00Z")).toISOString()).toBe("2026-11-12T22:00:00.000Z");
  });

  it("weekly: the next chosen weekday", () => {
    const mon = { frequency: "weekly" as const, time: "08:00", weekday: 1 };
    expect(nextSummaryRun(mon, "Asia/Jakarta", new Date("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-16T01:00:00.000Z");
    const thu = { frequency: "weekly" as const, time: "21:00", weekday: 4 };
    expect(nextSummaryRun(thu, "Asia/Jakarta", new Date("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-12T14:00:00.000Z");
    expect(nextSummaryRun(thu, "Asia/Jakarta", new Date("2026-11-12T14:00:01Z")).toISOString()).toBe("2026-11-19T14:00:00.000Z");
  });
});

describe("summaryPeriod", () => {
  it("daily: the same day from 17:00, otherwise the day before", () => {
    expect(summaryPeriod("daily", "2026-11-12", "21:00")).toEqual({ from: "2026-11-12", to: "2026-11-12", key: "daily:2026-11-12" });
    expect(summaryPeriod("daily", "2026-11-12", "07:00")).toEqual({ from: "2026-11-11", to: "2026-11-11", key: "daily:2026-11-11" });
  });

  it("weekly: the seven days ending on the summarized day", () => {
    expect(summaryPeriod("weekly", "2026-11-15", "19:00")).toEqual({ from: "2026-11-09", to: "2026-11-15", key: "weekly:2026-11-15" });
    expect(summaryPeriod("weekly", "2026-11-16", "08:00")).toEqual({ from: "2026-11-09", to: "2026-11-15", key: "weekly:2026-11-15" });
  });
});
