/**
 * Spelled-out numbers, as speech-to-text writes them for voice notes:
 * "seratus tujuh puluh lima ribu" -> 175000. Indonesian plus common Javanese
 * and Sundanese number words. Strict: any unknown word -> null.
 *
 * Values are tracked in halves (x2) so "dua setengah juta" stays integer math.
 */

const UNITS: Record<string, bigint> = {
  nol: 0n,
  satu: 1n, hiji: 1n, siji: 1n,
  dua: 2n, loro: 2n, rong: 2n,
  tiga: 3n, tilu: 3n, telu: 3n, telung: 3n,
  empat: 4n, opat: 4n, papat: 4n, patang: 4n,
  lima: 5n, limo: 5n, limang: 5n,
  enam: 6n, genep: 6n, enem: 6n, nem: 6n,
  tujuh: 7n, pitu: 7n, pitung: 7n,
  delapan: 8n, dalapan: 8n, wolu: 8n, wolung: 8n,
  sembilan: 9n, salapan: 9n, songo: 9n, sanga: 9n, sangang: 9n,
};

/** Complete numbers below 1000 that can't take puluh/belas/ratus. */
const WHOLE: Record<string, bigint> = {
  sepuluh: 10n, sapuluh: 10n,
  sebelas: 11n,
  selawe: 25n, seket: 50n, sewidak: 60n,
  seratus: 100n, saratus: 100n, satus: 100n,
};

/** Unit x factor: "tujuh puluh" = 7 x 10. belas/welas add 10 instead. */
const FACTORS: Record<string, bigint> = { puluh: 10n, ratus: 100n, atus: 100n };
const TEENS = new Set(["belas", "welas"]);

const MULTIPLIERS: Record<string, bigint> = {
  ribu: 1_000n, rebu: 1_000n, ewu: 1_000n, "èwu": 1_000n,
  juta: 1_000_000n, yuta: 1_000_000n,
  miliar: 1_000_000_000n, milyar: 1_000_000_000n,
};
/** "seribu", "sejuta": one of the multiplier, standing alone. */
const ONE_TIMES: Record<string, bigint> = {
  seribu: 1_000n, sarebu: 1_000n, sewu: 1_000n,
  sejuta: 1_000_000n, sajuta: 1_000_000n,
  semiliar: 1_000_000_000n,
};

const IGNORED = new Set(["rp", "rupiah", "idr"]);

type Prev = "start" | "unit" | "whole" | "factor" | "teen" | "mult" | "half";

export function parseSpokenNumber(input: string): bigint | null {
  if (/^\s*-/.test(input)) return null; // negative, not a hyphenated word
  const words = input
    .toLowerCase()
    .replace(/[-,.]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !IGNORED.has(w));
  if (!words.length) return null;

  let total = 0n; // halves
  let cur = 0n; // halves, the group below the next multiplier
  let lastUnit = 0n;
  let lastMult = 0n;
  let prev: Prev = "start";
  let seen = false;

  for (const w of words) {
    const after = (...ok: Prev[]) => ok.includes(prev);
    if (w in UNITS || /^\d+$/.test(w)) {
      if (!after("start", "factor", "whole", "mult")) return null;
      lastUnit = w in UNITS ? UNITS[w]! : BigInt(w);
      cur += lastUnit * 2n;
      prev = "unit";
      seen = true;
    } else if (w in WHOLE) {
      // "satus seket" (150): a whole below 100 may follow round hundreds.
      const afterHundreds = WHOLE[w]! < 100n && cur > 0n && cur % 200n === 0n && after("whole", "factor");
      if (!after("start", "mult") && !afterHundreds) return null;
      cur += WHOLE[w]! * 2n;
      prev = "whole";
      seen = true;
    } else if (w in FACTORS) {
      if (prev !== "unit") return null;
      cur += lastUnit * 2n * (FACTORS[w]! - 1n);
      prev = "factor";
    } else if (TEENS.has(w)) {
      if (prev !== "unit") return null;
      cur += 20n;
      prev = "teen";
    } else if (w in MULTIPLIERS) {
      if (cur === 0n || prev === "mult" || prev === "start") return null;
      lastMult = MULTIPLIERS[w]!;
      total += cur * lastMult;
      cur = 0n;
      prev = "mult";
    } else if (w in ONE_TIMES) {
      if (!after("start", "mult")) return null;
      lastMult = ONE_TIMES[w]!;
      total += 2n * lastMult;
      prev = "mult";
      seen = true;
    } else if (w === "setengah") {
      if (prev === "unit" || prev === "whole") {
        cur += 1n; // "dua setengah juta": must be followed by a multiplier
        prev = "half";
      } else if (prev === "mult") {
        total += lastMult; // "dua juta setengah"
        prev = "mult";
        lastMult = 0n;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!seen || prev === "half") return null;
  total += cur;
  return total % 2n === 0n ? total / 2n : null;
}
