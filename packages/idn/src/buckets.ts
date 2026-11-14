/** Split an inclusive date range into day / week (Monday start) / month buckets, clipped to the range. Pure. */
export type BucketUnit = "day" | "week" | "month";

const DAY = 86_400_000;
const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function periodBuckets(from: string, to: string, unit: BucketUnit, max = 400): Array<{ from: string; to: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error(`invalid range ${from}..${to}`);
  const end = t(to);
  const out: Array<{ from: string; to: string }> = [];
  let start = t(from);
  while (start <= end) {
    const d = new Date(start);
    let next: number;
    if (unit === "day") next = start + DAY;
    else if (unit === "week") next = start + (7 - ((d.getUTCDay() + 6) % 7)) * DAY;
    else next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    out.push({ from: iso(start), to: iso(Math.min(next - DAY, end)) });
    if (out.length > max) throw new Error(`too many ${unit} buckets; use a larger unit`);
    start = next;
  }
  return out;
}
