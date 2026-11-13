/**
 * Tax and report requests typed in chat (F10, Flow E), parsed by code so the
 * common ones need no model: "pajak bulan ini berapa?", "minta laporan
 * oktober excel", "stop pengingat pajak". Deliberately narrow: anything else
 * ("kenapa pajaknya segitu?") goes to the agent, and "bayar pajak 150rb" stays
 * a transaction. Pure.
 */
import { utcOffsetHours } from "./summary-schedule.js";

export type TaxRequest =
  | { action: "estimate"; month: string | null }
  | { action: "report"; month: string | null; format: "pdf" | "xlsx" }
  | { action: "notice"; enabled: boolean };

const MONTHS: Array<[number, string[]]> = [
  [1, ["januari", "jan"]],
  [2, ["februari", "pebruari", "feb", "peb"]],
  [3, ["maret", "mar"]],
  [4, ["april", "apr"]],
  [5, ["mei"]],
  [6, ["juni", "jun"]],
  [7, ["juli", "jul"]],
  [8, ["agustus", "agu", "agt", "ags", "aug"]],
  [9, ["september", "sept", "sep"]],
  [10, ["oktober", "okt", "oct"]],
  [11, ["november", "nopember", "nov", "nop"]],
  [12, ["desember", "des", "dec"]],
];
const MONTH_NUMBER = new Map(MONTHS.flatMap(([n, names]) => names.map((w) => [w, n] as const)));
const NAMES = [...MONTH_NUMBER.keys()].sort((a, b) => b.length - a.length).join("|");
const PHRASE = new RegExp(`\\b(?:bulan\\s+(ini|lalu|kemarin|kmrn|kmarin)|(?:bulan\\s+)?(${NAMES})(?:\\s+(20\\d\\d))?)\\b`);

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** A month named in `text`, relative to `today`. Bare month names later than now mean last year. */
export function parseMonthPhrase(text: string, today: string): { month: string; match: string } | null {
  const m = PHRASE.exec(text.toLowerCase());
  if (!m) return null;
  const y = Number(today.slice(0, 4));
  const cur = Number(today.slice(5, 7));
  if (m[1] === "ini") return { month: ym(y, cur), match: m[0] };
  if (m[1]) return { month: cur === 1 ? ym(y - 1, 12) : ym(y, cur - 1), match: m[0] };
  const n = MONTH_NUMBER.get(m[2]!)!;
  const year = m[3] ? Number(m[3]) : n > cur ? y - 1 : y;
  return { month: ym(year, n), match: m[0] };
}

const NOTICE = /\b(pengingat|reminder|notif|notifikasi)\s+pajak\b/;
const OFF = /\b(stop|matikan|matiin|berhenti|nonaktifkan|off|jangan)\b/;
const ON = /\b(nyalakan|nyalain|aktifkan|hidupkan|on|mulai)\b/;

// Every other word must be filler, or the message is something else.
const COMMON = ["dong", "ya", "yah", "kak", "nih", "sih", "deh", "aja", "saja", "tolong", "mau", "aku", "saya", "untuk", "buat", "yang", "di", "ku", "usaha", "usahaku", "punyaku"];
const ESTIMATE_WORDS = new Set([...COMMON, "berapa", "cek", "hitung", "hitungin", "lihat", "liat", "info", "perkiraan", "estimasi", "total", "pajak", "pajakku", "pph", "final", "harus", "dibayar", "terutang"]);
const REPORT_WORDS = new Set([
  ...COMMON,
  "laporan", "laporanku", "report", "lihat", "liat", "minta", "kirim", "kirimin", "bikin", "bikinin", "buatin", "download", "unduh",
  "keuangan", "pajak", "bulanan", "pdf", "excel", "xlsx", "versi", "format", "dalam", "bentuk", "file", "nya", "laporannya",
]);

const words = (t: string) => t.split(/\s+/).filter(Boolean);

export function parseTaxRequest(text: string, today: string): TaxRequest | null {
  const t = text.toLowerCase().replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (NOTICE.test(t)) {
    if (OFF.test(t)) return { action: "notice", enabled: false };
    if (ON.test(t)) return { action: "notice", enabled: true };
    return null;
  }

  const month = parseMonthPhrase(t, today);
  const rest = words(month ? t.replace(month.match, " ") : t);

  if (rest.some((w) => w === "laporan" || w === "laporanku" || w === "report" || w === "laporannya")) {
    if (!rest.every((w) => REPORT_WORDS.has(w))) return null;
    const format = rest.some((w) => w === "excel" || w === "xlsx") ? "xlsx" : "pdf";
    return { action: "report", month: month?.month ?? null, format };
  }
  if (rest.some((w) => w === "pajak" || w === "pajakku" || w === "pph")) {
    // "harus bayar berapa?" asks; "bayar pajak 150rb" records (it has an amount, so it fails here anyway).
    const asks = rest.includes("berapa");
    if (!rest.every((w) => ESTIMATE_WORDS.has(w) || (asks && w === "bayar"))) return null;
    return { action: "estimate", month: month?.month ?? null };
  }
  return null;
}

const HOUR = 3_600_000;

/** The first `time` (local "HH:MM") on the 1st of a month that is strictly after `now`. */
export function nextMonthlyRun(timezone: string, now: Date, time: string): Date {
  const offset = utcOffsetHours(timezone) * HOUR;
  const [h, m] = time.split(":").map(Number);
  const local = new Date(now.getTime() + offset);
  for (let i = 0; i <= 1; i++) {
    const candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + i, 1, h!, m!) - offset;
    if (candidate > now.getTime()) return new Date(candidate);
  }
  throw new Error("no next monthly run found");
}
