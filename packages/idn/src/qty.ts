import { parseSpokenNumber } from "./spoken.js";

/** Quantity as an exact fraction so qty x price stays integer arithmetic. */
export interface Qty {
  num: bigint;
  den: bigint;
}

const WORDS: Record<string, Qty> = {
  setengah: { num: 1n, den: 2n },
  seperempat: { num: 1n, den: 4n },
  satu: { num: 1n, den: 1n }, se: { num: 1n, den: 1n },
  dua: { num: 2n, den: 1n }, tiga: { num: 3n, den: 1n }, empat: { num: 4n, den: 1n },
  lima: { num: 5n, den: 1n }, enam: { num: 6n, den: 1n }, tujuh: { num: 7n, den: 1n },
  delapan: { num: 8n, den: 1n }, sembilan: { num: 9n, den: 1n }, sepuluh: { num: 10n, den: 1n },
  selusin: { num: 12n, den: 1n },
};

export function parseQty(input: string): Qty | null {
  const s = input.toLowerCase().trim();
  if (WORDS[s]) return WORDS[s];
  let m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) {
    const q = { num: BigInt(m[1]!), den: BigInt(m[2]!) };
    return q.num > 0n && q.den > 0n ? q : null;
  }
  m = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(s);
  if (!m) {
    const spoken = parseSpokenNumber(s); // "dua puluh lima" from a voice transcript
    return spoken !== null && spoken > 0n ? { num: spoken, den: 1n } : null;
  }
  const frac = m[2] ?? "";
  const q = { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
  return q.num > 0n ? q : null;
}

/** qty x unit price in rupiah, or null if the result isn't whole rupiah. */
export function multiplyQty(q: Qty, price: bigint): bigint | null {
  const p = q.num * price;
  return p % q.den === 0n ? p / q.den : null;
}
