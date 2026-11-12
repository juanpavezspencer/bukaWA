/**
 * Named reporting periods -> inclusive date ranges, relative to the business's
 * "today" (already in its timezone). Weeks start on Monday (Senin). "This ..."
 * periods end today, never in the future.
 */
export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_year",
  "last_7_days",
  "last_30_days",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

const DAY = 86_400_000;
const parse = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
};
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

export function resolvePeriod(preset: PeriodPreset, today: string): { from: string; to: string } {
  const t = parse(today);
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: fmt(t - DAY), to: fmt(t - DAY) };
    case "this_week":
      return { from: fmt(t - sinceMonday * DAY), to: today };
    case "last_week":
      return { from: fmt(t - (sinceMonday + 7) * DAY), to: fmt(t - (sinceMonday + 1) * DAY) };
    case "this_month":
      return { from: fmt(Date.UTC(y, m, 1)), to: today };
    case "last_month":
      return { from: fmt(Date.UTC(y, m - 1, 1)), to: fmt(Date.UTC(y, m, 0)) };
    case "this_year":
      return { from: fmt(Date.UTC(y, 0, 1)), to: today };
    case "last_7_days":
      return { from: fmt(t - 6 * DAY), to: today };
    case "last_30_days":
      return { from: fmt(t - 29 * DAY), to: today };
  }
}
