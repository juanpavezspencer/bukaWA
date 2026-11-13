/**
 * Daily / weekly summary settings (F9): parse the owner's request, and the
 * date math for when to send and which days a summary covers. Pure.
 */

export type SummaryFrequency = "daily" | "weekly";

export interface SummarySchedule {
  frequency: SummaryFrequency;
  /** Local time "HH:MM" in the business's timezone. */
  time: string;
  /** Weekly only: 0 = Sunday (Minggu) ... 6 = Saturday (Sabtu). */
  weekday: number | null;
}

export type SummaryRequest =
  | { action: "set"; frequency: SummaryFrequency; time: string | null; weekday: number | null }
  | { action: "off" }
  | { action: "now" };

const TRIGGER = /\b(ringkasan|rekap(an)?|summary|laporan (harian|mingguan))\b/;
const OFF = /\b(stop|matikan|matiin|berhenti|jangan|nonaktifkan|off|udahan)\b/;
const DAILY = /\b(harian|(se)?tiap hari|daily)\b/;
const WEEKLY = /\b(mingguan|seminggu sekali|weekly)\b/;
const DAY_NAMES: Record<string, number> = { minggu: 0, ahad: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, "jum'at": 5, sabtu: 6 };
const WEEKDAY = /\b(?:hari|tiap|setiap)\s+(minggu|ahad|senin|selasa|rabu|kamis|jum'?at|sabtu)\b/;

/** "jam 9 malam" -> "21:00", "20.30" -> "20:30"; null if none or impossible. */
function parseTime(t: string): string | null | undefined {
  const m = /\bjam\s*(\d{1,2})(?:[.:](\d{2}))?(?:\s*(pagi|siang|sore|malam|subuh))?/.exec(t) ?? /\b(\d{1,2})[.:](\d{2})\b/.exec(t);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const part = m[3];
  if (h > 23 || min > 59) return null;
  if (part === "siang" && h >= 1 && h <= 4) h += 12;
  else if (part === "sore" && h >= 1 && h <= 11) h += 12;
  else if (part === "malam" && h >= 5 && h <= 11) h += 12;
  else if (part === "malam" && h === 12) h = 0;
  else if ((part === "pagi" || part === "subuh") && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseSummaryRequest(text: string): SummaryRequest | null {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!TRIGGER.test(t)) return null;
  if (OFF.test(t)) return { action: "off" };

  const day = WEEKDAY.exec(t);
  const weekday = day ? DAY_NAMES[day[1]!.replace("'", "")]! : null;
  const time = parseTime(t);
  const weekly = WEEKLY.test(t) || weekday !== null;
  const daily = !weekly && DAILY.test(t);
  if (!weekly && !daily && time === undefined) return { action: "now" };
  return {
    action: "set",
    frequency: weekly ? "weekly" : "daily",
    time: time ?? null,
    weekday: weekly ? (weekday ?? 0) : null,
  };
}

/** Indonesia has no daylight saving: fixed offsets in hours. */
const UTC_OFFSET: Record<string, number> = { "Asia/Jakarta": 7, "Asia/Pontianak": 7, "Asia/Makassar": 8, "Asia/Jayapura": 9 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function utcOffsetHours(timezone: string): number {
  const h = UTC_OFFSET[timezone];
  if (h === undefined) throw new Error(`unsupported timezone ${timezone}`);
  return h;
}

/** The local calendar date ("YYYY-MM-DD") and time ("HH:MM") at an instant. */
export function localDateTime(now: Date, timezone: string): { date: string; time: string } {
  const iso = new Date(now.getTime() + utcOffsetHours(timezone) * HOUR).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** The first send time strictly after `now`. */
export function nextSummaryRun(s: SummarySchedule, timezone: string, now: Date): Date {
  const offset = utcOffsetHours(timezone) * HOUR;
  const [h, m] = s.time.split(":").map(Number);
  const local = now.getTime() + offset;
  let candidate = Math.floor(local / DAY) * DAY + h! * HOUR + m! * 60_000;
  for (let i = 0; i < 8; i++) {
    const weekdayOk = s.frequency === "daily" || new Date(candidate).getUTCDay() === s.weekday;
    if (candidate > local && weekdayOk) return new Date(candidate - offset);
    candidate += DAY;
  }
  throw new Error("no next run found");
}

const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * Which days a summary sent at local `date` `time` covers. An evening send
 * (17:00 or later) covers that day; an earlier one covers the day before.
 * Weekly covers the seven days ending on that day. `key` makes a send idempotent.
 */
export function summaryPeriod(frequency: SummaryFrequency, date: string, time: string): { from: string; to: string; key: string } {
  const to = time >= "17:00" ? date : shift(date, -1);
  const from = frequency === "weekly" ? shift(to, -6) : to;
  return { from, to, key: `${frequency}:${to}` };
}
