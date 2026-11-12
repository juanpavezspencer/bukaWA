/**
 * Number -> Indonesian words, the way speech-to-text spells amounts out.
 * Written independently of packages/idn's parser so the voice set checks it.
 */
const ONES = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];

function below1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h === 1) parts.push("seratus");
  else if (h > 1) parts.push(`${ONES[h]} ratus`);
  if (rest === 10) parts.push("sepuluh");
  else if (rest === 11) parts.push("sebelas");
  else if (rest > 11 && rest < 20) parts.push(`${ONES[rest - 10]} belas`);
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t > 0) parts.push(`${ONES[t]} puluh`);
    if (o > 0) parts.push(ONES[o]!);
  }
  return parts.join(" ");
}

export function terbilang(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`terbilang: ${n}`);
  const parts: string[] = [];
  const jt = Math.floor(n / 1_000_000);
  const rb = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (jt) parts.push(jt === 1 ? "satu juta" : `${below1000(jt)} juta`);
  if (rb) parts.push(rb === 1 ? "seribu" : `${below1000(rb)} ribu`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}

/** Javanese (ngoko) for round thousands, e.g. 250000 -> "rong atus seket ewu". */
const JV_ONES = ["", "siji", "loro", "telu", "papat", "limo", "enem", "pitu", "wolu", "songo"];
const JV_PREFIX = ["", "se", "rong", "telung", "patang", "limang", "nem", "pitung", "wolung", "sangang"];

function jvBelow1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h === 1) parts.push("satus");
  else if (h > 1) parts.push(`${JV_PREFIX[h]} atus`);
  if (rest === 25) parts.push("selawe");
  else if (rest === 50) parts.push("seket");
  else if (rest === 60) parts.push("sewidak");
  else if (rest === 10) parts.push("sepuluh");
  else if (rest > 0) {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t >= 2) parts.push(`${JV_PREFIX[t]} puluh`);
    else if (t === 1) return "";
    if (o > 0) parts.push(JV_ONES[o]!);
  }
  return parts.join(" ");
}

/** Only for amounts it can say cleanly; returns null otherwise (11k-19k, millions). */
export function terbilangJawa(n: number): string | null {
  if (n % 1000 !== 0 || n >= 1_000_000 || n < 1000) return null;
  const k = n / 1000;
  if (k === 1) return "sewu";
  const words = jvBelow1000(k);
  if (!words) return null;
  return `${words} ewu`;
}
