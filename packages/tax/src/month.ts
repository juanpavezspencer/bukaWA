import { TaxError } from "./errors.js";

/** A tax period (masa pajak): calendar month "YYYY-MM". Pure date math on UTC calendar days. */
export type Month = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function assertMonth(month: string): { year: number; month: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new TaxError("INVALID_MONTH", `not a YYYY-MM month: ${month}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ym = (year: number, month0: number) => {
  const d = new Date(Date.UTC(year, month0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Inclusive date range of a month. */
export function monthRange(month: Month): { from: string; to: string } {
  const { year, month: m } = assertMonth(month);
  return { from: iso(Date.UTC(year, m - 1, 1)), to: iso(Date.UTC(year, m, 0)) };
}

/** January 1 up to the last day before `month`; null for January (nothing before it this year). */
export function ytdBeforeRange(month: Month): { from: string; to: string } | null {
  const { year, month: m } = assertMonth(month);
  if (m === 1) return null;
  return { from: `${year}-01-01`, to: iso(Date.UTC(year, m - 1, 0)) };
}

export function previousMonth(month: Month): Month {
  const { year, month: m } = assertMonth(month);
  return ym(year, m - 2);
}

export function nextMonth(month: Month): Month {
  const { year, month: m } = assertMonth(month);
  return ym(year, m);
}

/** "2026-11-13" -> "2026-11". */
export function monthOf(date: string): Month {
  const m = date.slice(0, 7);
  assertMonth(m);
  return m;
}

/**
 * When the month's final tax must be paid: `dueDay` of the following month;
 * a Saturday or Sunday moves to the next Monday. Public holidays are not
 * known here, so on a holiday the real deadline can be a day or two later.
 */
export function paymentDueDate(month: Month, dueDay: number): string {
  const { year, month: m } = assertMonth(month);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) throw new TaxError("INVALID_INPUT", `due day must be 1..28: ${dueDay}`);
  const t = Date.UTC(year, m, dueDay);
  const wd = new Date(t).getUTCDay();
  const shift = wd === 6 ? 2 : wd === 0 ? 1 : 0;
  return iso(t + shift * 86_400_000);
}

/** Basis points as an Indonesian percentage: 50 -> "0,5%", 1125 -> "11,25%". */
export function formatRate(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `,${frac}` : ""}%`;
}
