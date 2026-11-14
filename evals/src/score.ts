import type { NormalizedEntry } from "@bukuwa/ai";
import type { ImageCase, QuestionCase, TextCase } from "./types.js";

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
    outcome?: unknown;
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
  const fieldAccuracy = Object.fromEntries(
    fields.map((f) => {
      const scored = entries.filter((e) => f in e);
      return [f, pct(scored.filter((e) => e[f]).length, scored.length)];
    }),
  );
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

// --- questions (F7) and corrections (Flow D) ---------------------------------------

/** Question-set metrics: answers quote the right amounts, corrections target the right entry. */
export const QUESTION_FIELDS = ["answer", "unsupported", "reminder", "report", "correction_target", "correction_change"] as const;

/** "Rp 1.250.000", "Rp1.250.000" and "1.250.000" all count as quoting Rp 1.250.000. */
export function quotesAmount(answer: string, amount: string): boolean {
  const digits = amount.replace(/\D/g, "");
  const nums = answer.match(/\d[\d.,]*/g) ?? [];
  return nums.some((n) => n.replace(/[.,]00$/, "").replace(/\D/g, "") === digits);
}

export type QuestionOutcome =
  | { kind: "answer"; text: string }
  | { kind: "proposal"; journalId: string; action: string; amountIdr?: string; paymentCode?: string }
  | { kind: "reminder"; contactName: string; text: string }
  | { kind: "report"; month: string; format: string }
  | { kind: "not_routed"; intent: string };

/**
 * One result per case, with exactly one scored field: answer (all amounts
 * quoted), unsupported (says so, quotes no money amount), or for corrections
 * correction_target and correction_change.
 */
export function scoreQuestionCase(c: QuestionCase, out: QuestionOutcome, journalIds: Map<string, string>): CaseResult {
  const got = { intent: out.kind === "not_routed" ? out.intent : c.expected.intent, entries: [], outcome: out } as CaseResult["got"];
  const intentOk = out.kind !== "not_routed";
  const e = c.expected;
  let fields: Record<string, boolean>;
  if (e.kind === "answer") {
    fields = { answer: out.kind === "answer" && (e.must_include ?? []).every((a) => quotesAmount(out.text, a)) };
  } else if (e.kind === "reminder") {
    fields = {
      reminder:
        out.kind === "reminder" && sameCounterparty(e.reminder_contact ?? null, out.contactName) && (e.must_include ?? []).every((a) => quotesAmount(out.text, a)),
    };
  } else if (e.kind === "report") {
    fields = { report: out.kind === "report" && out.month === e.report?.month && out.format === e.report?.format };
  } else if (e.kind === "unsupported") {
    fields = { unsupported: out.kind === "answer" && !/rp\s?\d/i.test(out.text) };
  } else {
    const x = e.correction!;
    const target = out.kind === "proposal" && out.journalId === journalIds.get(x.entry_key) && out.action === x.action;
    fields = {
      correction_target: target,
      correction_change:
        target && out.kind === "proposal" && (out.amountIdr ?? null) === (x.amount_idr ?? null) && (out.paymentCode ?? null) === (x.payment_code ?? null),
    };
  }
  return { id: c.id, intentOk, fields: [fields], got };
}
