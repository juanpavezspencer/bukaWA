import type { NormalizedEntry } from "@bukuwa/ai";
import type { ImageCase, TextCase } from "./types.js";

/** Fields scored for F2/F4 (spec: amount, type, payment method) plus date. */
export const FIELDS = ["kind", "amount", "payment_method", "date"] as const;
export type Field = (typeof FIELDS)[number];
/** Fields scored for F3 (spec: amount, date, counterparty) plus kind and payment method. */
export const IMAGE_FIELDS = ["kind", "amount", "date", "counterparty", "payment_method"] as const;

export interface CaseResult {
  id: string;
  /** Text/voice: intent right. Images: document vs not-a-document right. */
  intentOk: boolean;
  /** Per expected entry, which fields matched. Empty for non-transaction cases. */
  fields: Array<Record<string, boolean>>;
  got: {
    intent: string;
    entries: Array<{ kind: string; amount_idr: string | null; payment_method: string | null; date: string; counterparty?: string | null }>;
  };
}

export function scoreCase(c: TextCase, intent: string, entries: NormalizedEntry[]): CaseResult {
  const got = {
    intent,
    entries: entries.map((e) => ({
      kind: e.kind,
      amount_idr: e.amountIdr?.toString() ?? null,
      payment_method: e.paymentMethod,
      date: e.date,
    })),
  };
  const fields = (c.expected.entries ?? []).map((exp, i) => {
    const g = got.entries[i];
    return {
      kind: g?.kind === exp.kind,
      amount: g?.amount_idr === exp.amount_idr,
      payment_method: g !== undefined && g.payment_method === exp.payment_method,
      date: g?.date === exp.date,
    };
  });
  return { id: c.id, intentOk: intent === c.expected.intent, fields, got };
}

/** Loose name match: case, spacing and punctuation ignored, and one may contain the other ("Sari W" matches "SARI WULANDARI"). */
export function sameCounterparty(expected: string | null, got: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(expected);
  const b = norm(got);
  if (!a || !b) return a === b;
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
}

export function scoreImageCase(c: ImageCase, isDocument: boolean, entries: NormalizedEntry[]): CaseResult {
  const got = {
    intent: isDocument ? "document" : "not_a_document",
    entries: entries.map((e) => ({
      kind: e.kind,
      amount_idr: e.amountIdr?.toString() ?? null,
      payment_method: e.paymentMethod,
      date: e.date,
      counterparty: e.counterparty,
    })),
  };
  const fields = (c.expected.entries ?? []).map((exp, i) => {
    const g = got.entries[i];
    return {
      kind: g?.kind === exp.kind,
      amount: g?.amount_idr === exp.amount_idr,
      date: g?.date === exp.date,
      counterparty: g !== undefined && sameCounterparty(exp.counterparty, g.counterparty),
      payment_method: g !== undefined && g.payment_method === exp.payment_method,
    };
  });
  return { id: c.id, intentOk: isDocument === c.expected.is_document, fields, got };
}

export interface Summary {
  cases: number;
  intentAccuracy: number;
  /** Percent of expected entries with the field right (a missed intent or document counts as wrong). */
  fieldAccuracy: Record<string, number>;
}

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((1000 * n) / d) / 10);

export function summarize(results: CaseResult[], fields: readonly string[] = FIELDS): Summary {
  const entries = results.flatMap((r) => r.fields);
  const fieldAccuracy = Object.fromEntries(fields.map((f) => [f, pct(entries.filter((e) => e[f]).length, entries.length)]));
  return { cases: results.length, intentAccuracy: pct(results.filter((r) => r.intentOk).length, results.length), fieldAccuracy };
}

/** Fields whose accuracy dropped more than `maxDrop` points vs the baseline (CLAUDE.md: 2). */
export function regressions(current: Summary, baseline: Summary, maxDrop = 2): string[] {
  const out: string[] = [];
  if (baseline.intentAccuracy - current.intentAccuracy > maxDrop) {
    out.push(`intent ${baseline.intentAccuracy} -> ${current.intentAccuracy}`);
  }
  for (const f of Object.keys(baseline.fieldAccuracy)) {
    if (baseline.fieldAccuracy[f]! - (current.fieldAccuracy[f] ?? 0) > maxDrop) {
      out.push(`${f} ${baseline.fieldAccuracy[f]} -> ${current.fieldAccuracy[f]}`);
    }
  }
  return out;
}
