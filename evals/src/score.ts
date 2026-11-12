import type { NormalizedEntry } from "@bukuwa/ai";
import type { TextCase } from "./types.js";

/** Fields scored for F2 (spec: amount, type, payment method) plus date. */
export const FIELDS = ["kind", "amount", "payment_method", "date"] as const;
export type Field = (typeof FIELDS)[number];

export interface CaseResult {
  id: string;
  intentOk: boolean;
  /** Per expected entry, which fields matched. Empty for non-transaction cases. */
  fields: Array<Record<Field, boolean>>;
  got: { intent: string; entries: Array<{ kind: string; amount_idr: string | null; payment_method: string | null; date: string }> };
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

export interface Summary {
  cases: number;
  intentAccuracy: number;
  /** Percent of expected transaction entries with the field right (missed intent counts as wrong). */
  fieldAccuracy: Record<Field, number>;
}

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((1000 * n) / d) / 10);

export function summarize(results: CaseResult[]): Summary {
  const entries = results.flatMap((r) => r.fields);
  const fieldAccuracy = Object.fromEntries(FIELDS.map((f) => [f, pct(entries.filter((e) => e[f]).length, entries.length)])) as Record<Field, number>;
  return { cases: results.length, intentAccuracy: pct(results.filter((r) => r.intentOk).length, results.length), fieldAccuracy };
}

/** Fields whose accuracy dropped more than `maxDrop` points vs the baseline (CLAUDE.md: 2). */
export function regressions(current: Summary, baseline: Summary, maxDrop = 2): string[] {
  const out: string[] = [];
  if (baseline.intentAccuracy - current.intentAccuracy > maxDrop) {
    out.push(`intent ${baseline.intentAccuracy} -> ${current.intentAccuracy}`);
  }
  for (const f of FIELDS) {
    if (baseline.fieldAccuracy[f] - current.fieldAccuracy[f] > maxDrop) {
      out.push(`${f} ${baseline.fieldAccuracy[f]} -> ${current.fieldAccuracy[f]}`);
    }
  }
  return out;
}
