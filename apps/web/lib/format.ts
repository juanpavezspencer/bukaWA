/*
 * Display helpers. Money arrives from the API as integer-rupiah strings and
 * stays BigInt here: the browser never does float arithmetic on money.
 */

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** "1500000" -> "Rp 1.500.000"; "-25000" -> "-Rp 25.000". */
export function rp(idr: string | bigint): string {
  const v = typeof idr === "bigint" ? idr : BigInt(idr);
  const abs = (v < 0n ? -v : v).toString().replace(GROUP, ".");
  return `${v < 0n ? "-" : ""}Rp ${abs}`;
}

/** Compact axis label: 1.500.000 -> "1,5 jt", 250.000 -> "250 rb". Display only. */
export function rpShort(idr: string | bigint): string {
  const v = typeof idr === "bigint" ? idr : BigInt(idr);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const fmt = (whole: bigint, tenth: bigint, unit: string) => `${neg ? "-" : ""}${whole}${tenth ? `,${tenth}` : ""} ${unit}`;
  if (a >= 1_000_000_000n) return fmt(a / 1_000_000_000n, (a % 1_000_000_000n) / 100_000_000n, "M");
  if (a >= 1_000_000n) return fmt(a / 1_000_000n, (a % 1_000_000n) / 100_000n, "jt");
  if (a >= 1_000n) return fmt(a / 1_000n, 0n, "rb");
  return `${neg ? "-" : ""}${a}`;
}

/** Parse what an owner types ("150.000", "150rb", "1,5jt") into integer rupiah; null if unclear. */
export function parseRupiahInput(text: string): bigint | null {
  const t = text.trim().toLowerCase().replace(/^rp\.?\s*/, "").replace(/\s+/g, "");
  const m = /^(\d+)(?:,(\d{1,3}))?(rb|ribu|k|jt|juta)?$/.exec(t.replace(/\./g, ""));
  if (!m) return null;
  const mult = m[3] === "jt" || m[3] === "juta" ? 1_000_000n : m[3] ? 1_000n : 1n;
  const frac = m[2] ?? "";
  if (frac && mult === 1n) return null;
  const scaled = BigInt(m[1]! + frac) * mult / 10n ** BigInt(frac.length);
  return scaled > 0n ? scaled : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTHS_LONG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

export const dateShort = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
export const dateLong = (iso: string) => `${dateShort(iso)} ${iso.slice(0, 4)}`;
export const monthLong = (ym: string) => `${MONTHS_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);

export type Preset = "7d" | "30d" | "month" | "lastMonth" | "year";
export type Bucket = "day" | "week" | "month";

/** A date range relative to the business's local today, and the bucket that suits it. */
export function presetRange(p: Preset, today: string): { from: string; to: string; bucket: Bucket } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  switch (p) {
    case "7d":
      return { from: addDays(today, -6), to: today, bucket: "day" };
    case "30d":
      return { from: addDays(today, -29), to: today, bucket: "day" };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today, bucket: "day" };
    case "lastMonth": {
      const first = new Date(Date.UTC(y, m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      return { from: iso(first.getTime()), to: iso(last.getTime()), bucket: "week" };
    }
    case "year":
      return { from: `${y}-01-01`, to: today, bucket: "month" };
  }
}

/** Months an owner can export, newest first (the current one included). */
export function recentMonths(today: string, n = 12): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

export const KIND_LABEL: Record<string, string> = {
  sale: "Penjualan",
  expense: "Pengeluaran",
  receivable: "Piutang",
  payable: "Utang",
  settlement: "Pelunasan",
  owner_capital: "Modal",
  owner_drawing: "Prive",
  other: "Lainnya",
};
