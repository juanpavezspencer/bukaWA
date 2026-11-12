/**
 * Indonesian date phrases -> YYYY-MM-DD, relative to the business's "today"
 * (already in its timezone). Only past or today: bookkeeping entries are never
 * future-dated, so "besok"/"lusa" return null and the caller asks.
 */

const DAY_MS = 86_400_000;

const WEEKDAYS: Record<string, number> = {
  minggu: 0, ahad: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6,
};

const MONTHS: Array<[RegExp, number]> = [
  [/^jan(uari)?$/, 1], [/^feb(ruari)?$/, 2], [/^mar(et)?$/, 3], [/^apr(il)?$/, 4],
  [/^mei$/, 5], [/^jun(i)?$/, 6], [/^jul(i)?$/, 7], [/^agu?s(tus)?$/, 8],
  [/^sep(t(ember)?)?$/, 9], [/^okt(ober)?$/, 10], [/^nov(ember)?$/, 11], [/^des(ember)?$/, 12],
];

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function make(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

/** Day+month without a year: this year, or last year if that would be in the future. */
function dayMonth(today: Date, d: number, m: number): Date | null {
  const y = today.getUTCFullYear();
  const dt = make(y, m, d);
  if (!dt) return null;
  return dt > today ? make(y - 1, m, d) : dt;
}

function month(token: string): number | undefined {
  return MONTHS.find(([re]) => re.test(token))?.[1];
}

export function parseIdDate(input: string, todayIso: string): string | null {
  const today = toUtc(todayIso);
  const s = input.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/\b(besok|lusa|depan|nanti)\b/.test(s)) return null;

  if (/\b(hari ini|tadi|td|barusan|skrg|sekarang)\b/.test(s)) return fmt(today);
  if (/\b(kemarin|kemaren|kmrn|kmarin|kmren)\b/.test(s)) return fmt(new Date(today.getTime() - DAY_MS));

  let m = /\b(\d{1,2}) hari (yang |yg )?lalu\b/.exec(s);
  if (m) return fmt(new Date(today.getTime() - Number(m[1]) * DAY_MS));

  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const dt = make(Number(m[1]), Number(m[2]), Number(m[3]));
    return dt && dt <= today ? fmt(dt) : null;
  }

  // DD/MM[/YY[YY]] or DD-MM[-YY[YY]] (Indonesian order)
  m = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?\b/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const dt = make(y, mo, d);
      return dt && dt <= today ? fmt(dt) : null;
    }
    const dt = dayMonth(today, d, mo);
    return dt ? fmt(dt) : null;
  }

  // "12 Nov", "3 november 2026"
  m = /\b(\d{1,2}) ([a-z]+)(?: (\d{4}))?\b/.exec(s);
  if (m) {
    const mo = month(m[2]!);
    if (mo) {
      const dt = m[3] ? make(Number(m[3]), mo, Number(m[1])) : dayMonth(today, Number(m[1]), mo);
      return dt && dt <= today ? fmt(dt) : null;
    }
  }

  // "tgl 3", "tanggal 10": this month, else last month
  m = /\b(tgl|tanggal|tg)\.? ?(\d{1,2})\b/.exec(s);
  if (m) {
    const d = Number(m[2]);
    const y = today.getUTCFullYear();
    const mo = today.getUTCMonth() + 1;
    const dt = make(y, mo, d);
    if (dt && dt <= today) return fmt(dt);
    const prev = mo === 1 ? make(y - 1, 12, d) : make(y, mo - 1, d);
    return prev ? fmt(prev) : null;
  }

  // Weekday name: most recent such day, today included.
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(s)) {
      const back = (today.getUTCDay() - dow + 7) % 7;
      return fmt(new Date(today.getTime() - back * DAY_MS));
    }
  }
  return null;
}
