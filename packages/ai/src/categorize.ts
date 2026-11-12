import type { NormalizedEntry } from "./normalize.js";

/*
 * Categorizer: per-business rules first, then the model's suggestion, then the
 * default for the kind. Validity per kind is enforced again by the posting engine.
 */

export interface CategoryRule {
  pattern: string;
  kind: string;
  accountCode: string;
}

export interface Account {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}

const STOPWORDS = new Set([
  "jual", "beli", "belanja", "bayar", "buat", "untuk", "dan", "yang", "di", "ke", "dari", "pakai", "pake",
  "transfer", "cash", "tunai", "tf", "via", "lunas", "biaya", "ongkos",
]);

export function normalizePattern(s: string): string | null {
  const words = s
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return words.length ? words.slice(0, 2).join(" ") : null;
}

/** Patterns to learn from a confirmed entry: each item name, else the description. */
export function patternsFor(entry: Pick<NormalizedEntry, "items" | "description">): string[] {
  const sources = entry.items.length ? entry.items.map((i) => i.name) : [entry.description];
  return [...new Set(sources.map(normalizePattern).filter((p): p is string => p !== null))];
}

function fitsKind(kind: string, a: Account | undefined): boolean {
  if (!a) return false;
  if (kind === "sale") return a.type === "income";
  if (kind === "expense") return a.type === "expense" || a.code === "1300";
  return false;
}

function ruleFor(text: string, kind: string, rules: CategoryRule[], byCode: Map<string, Account>): string | undefined {
  const haystack = ` ${text.toLowerCase()} `;
  const hit = rules
    .filter((r) => r.kind === kind && haystack.includes(r.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  return hit && fitsKind(kind, byCode.get(hit.accountCode)) ? hit.accountCode : undefined;
}

export function categorize(
  entry: NormalizedEntry,
  rules: CategoryRule[],
  accounts: Account[],
): { accountCode: string | undefined; source: "rule" | "model" | "default" } {
  if (entry.kind !== "sale" && entry.kind !== "expense") return { accountCode: undefined, source: "default" };
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const hit = ruleFor([entry.description, ...entry.items.map((i) => i.name)].join(" "), entry.kind, rules, byCode);
  if (hit) return { accountCode: hit, source: "rule" };

  const suggested = accounts.find((a) => a.name === entry.suggestedCategory);
  if (suggested && fitsKind(entry.kind, suggested)) return { accountCode: suggested.code, source: "model" };

  return { accountCode: undefined, source: "default" };
}

/**
 * Per-item categories for one receipt with items in different categories
 * (Flow B: "ayam 175rb, token listrik 100rb"). Items without a rule take the
 * entry's category. Returns null unless a split is both needed and exact:
 * every item total known and summing to the entry amount.
 */
export function categorizeItems(
  entry: NormalizedEntry,
  entryAccountCode: string,
  rules: CategoryRule[],
  accounts: Account[],
): string[] | null {
  if (entry.kind !== "sale" && entry.kind !== "expense") return null;
  if (entry.items.length < 2 || entry.amountIdr === null) return null;
  if (entry.items.some((i) => i.lineTotalIdr === null)) return null;
  if (entry.items.reduce((s, i) => s + i.lineTotalIdr!, 0n) !== entry.amountIdr) return null;
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const codes = entry.items.map((i) => ruleFor(i.name, entry.kind, rules, byCode) ?? entryAccountCode);
  return new Set(codes).size > 1 ? codes : null;
}
