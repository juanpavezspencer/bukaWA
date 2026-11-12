/*
 * Number guard for answers (F7): every number the bot states must come from a
 * tool result. Compared on digits only, so "Rp 1.250.000", "1250000" and
 * "1,250,000" are the same number. Single digits are allowed in prose
 * ("3 biaya terbesar").
 */

const NUMBER = /\d+(?:[.,]\d+)*/g;
const digits = (s: string) => s.replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** Numbers in `answer` that appear in none of `sources`. `question` numbers count only as written (digits). */
export function unsupportedNumbers(answer: string, sources: string[], question = ""): string[] {
  const allowed = new Set<string>();
  for (const s of [...sources, question]) for (const m of s.match(NUMBER) ?? []) allowed.add(digits(m));
  const bad: string[] = [];
  for (const m of answer.match(NUMBER) ?? []) {
    const d = digits(m);
    if (d.length <= 1) continue;
    if (!allowed.has(d)) bad.push(m);
  }
  return [...new Set(bad)];
}
