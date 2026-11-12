/**
 * Contact names as owners type them: "Bu Sari", "bu sari", "Ibu Sari" and
 * "Sari" are the same customer. The key drops honorifics, case and
 * punctuation; it is used to find a contact, never shown.
 */
const HONORIFICS = new Set([
  "bu", "ibu", "bunda", "pak", "bapak", "pk", "mbak", "mba", "mb", "mas", "kak", "ka", "kakak", "bang", "abang",
  "teh", "teteh", "a", "aa", "akang", "kang", "ko", "koh", "ci", "cik", "cici", "om", "tante", "dek", "adek", "neng", "ning", "cak", "ning",
]);

export function contactKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && HONORIFICS.has(words[i]!)) i++;
  return words.slice(i).join(" ");
}

/** "  bu   sari " -> "Bu Sari"; how a new contact's name is stored. */
export function displayContactName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Looser than an exact key match, for suggestions only (never for posting):
 * "SARI W" ~ "Bu Sari" ~ "Sari Wulandari", "Budi" ~ "Pak Budi Santoso".
 * First names must be equal (3+ letters); each further word of the shorter
 * name must equal, or be the initial of, the same word in the longer one.
 */
export function similarContact(a: string, b: string): boolean {
  const ka = contactKey(a).split(" ").filter(Boolean);
  const kb = contactKey(b).split(" ").filter(Boolean);
  if (!ka.length || !kb.length) return false;
  if (ka.join(" ") === kb.join(" ")) return true;
  if (ka[0] !== kb[0] || ka[0]!.length < 3) return false;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.every((w, i) => w === long[i] || (w.length === 1 && long[i]!.startsWith(w)) || (long[i]!.length === 1 && w.startsWith(long[i]!)));
}
