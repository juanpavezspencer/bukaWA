/**
 * Indonesian money parsing. Integer rupiah as bigint only; no floats anywhere,
 * decimals like "1,5jt" are resolved with integer arithmetic.
 *
 * Milestone 1 scope: a whole input that is just an amount (onboarding answers).
 * Finding amounts inside free text is milestone 2.
 */

const MULTIPLIERS: Record<string, bigint> = {
  rb: 1_000n,
  ribu: 1_000n,
  rebu: 1_000n,
  k: 1_000n,
  jt: 1_000_000n,
  juta: 1_000_000n,
  miliar: 1_000_000_000n,
  milyar: 1_000_000_000n,
};

// Whole-word slang, rewritten to number + multiplier before tokenizing.
const SLANG: Array<[RegExp, string]> = [
  [/\bsetengah\s*juta\b/g, "500rb"],
  [/\bsetengah\s*miliar\b/g, "500jt"],
  [/\bceban\b/g, "10rb"],
  [/\bgoceng\b/g, "5rb"],
  [/\bgopek\b/g, "500"],
  [/\bseceng\b/g, "1rb"],
  [/\bseribu\b/g, "1rb"],
  [/\bsejuta\b/g, "1jt"],
  [/\bnol\b/g, "0"],
];

const TOKEN = /^(\d+(?:[.,]\d+)*)\s*(rb|ribu|rebu|k|jt|juta|miliar|milyar)?\b\s*/;

/** Parse a digit string with "." or "," separators into integer units of `mult`. */
function toRupiah(num: string, mult: bigint | undefined): bigint | null {
  const groups = num.split(/[.,]/);
  const [head, ...rest] = groups;
  if (!head) return null;

  // All trailing groups exactly 3 digits -> thousands separators.
  if (rest.every((g) => g.length === 3)) {
    return BigInt(groups.join("")) * (mult ?? 1n);
  }
  // Otherwise only "int<sep>frac" with a multiplier is meaningful (e.g. 1,5jt).
  if (rest.length !== 1 || !mult) return null;
  const frac = rest[0]!;
  const scale = 10n ** BigInt(frac.length);
  const scaled = BigInt(head + frac) * mult;
  if (scaled % scale !== 0n) return null; // fractional rupiah
  return scaled / scale;
}

export function parseRupiah(input: string): bigint | null {
  let s = input.toLowerCase().trim();
  s = s.replace(/^(rp\.?|idr)\s*/, "").replace(/\s*(rupiah|,-|\.-)$/, "").trim();
  for (const [re, rep] of SLANG) s = s.replace(re, rep);
  if (!s) return null;

  let total = 0n;
  let tokens = 0;
  while (s.length > 0) {
    const m = TOKEN.exec(s);
    if (!m) return null;
    const value = toRupiah(m[1]!, m[2] ? MULTIPLIERS[m[2]] : undefined);
    if (value === null) return null;
    total += value;
    tokens++;
    s = s.slice(m[0].length);
  }
  return tokens > 0 ? total : null;
}

export function formatRupiah(n: bigint): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}Rp ${digits}`;
}
