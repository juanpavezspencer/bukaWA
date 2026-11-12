import { describe, expect, it } from "vitest";
import { ENTRY_KINDS, INTENTS, normalizeExtraction, type RawExtraction } from "@bukuwa/ai";
import { loadTextCases } from "../src/dataset.js";
import { FIELDS, regressions, scoreCase, summarize } from "../src/score.js";

const cases = loadTextCases();
const sure = { kind: 1, amount: 1, date: 1, counterparty: 1, payment_method: 1 };

describe("text eval dataset", () => {
  it("has 300 cases with unique ids and texts", () => {
    expect(cases).toHaveLength(300);
    expect(new Set(cases.map((c) => c.id)).size).toBe(300);
    expect(new Set(cases.map((c) => c.text.toLowerCase())).size).toBe(300);
  });

  it("uses only valid intents and kinds, with integer-rupiah amounts", () => {
    for (const c of cases) {
      expect(INTENTS, c.id).toContain(c.expected.intent);
      for (const e of c.expected.entries ?? []) {
        expect(ENTRY_KINDS, c.id).toContain(e.kind);
        expect(e.amount_idr, c.id).toMatch(/^[1-9]\d*$/);
        expect(e.date, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("covers every intent and the main transaction kinds", () => {
    const intents = new Set(cases.map((c) => c.expected.intent));
    expect([...intents].sort()).toEqual([...INTENTS].sort());
    const kinds = new Set(cases.flatMap((c) => c.expected.entries ?? []).map((e) => e.kind));
    for (const k of ["sale", "expense", "owner_capital", "owner_drawing"]) expect(kinds).toContain(k);
  });

  it("every transaction case has oracle spans that occur verbatim in the text", () => {
    for (const c of cases.filter((x) => x.expected.intent === "transaction")) {
      expect(c.oracle, c.id).toBeDefined();
      const t = c.text.toLowerCase().replace(/\s+/g, "");
      for (const e of c.oracle!.entries) {
        const spans = [e.amount_text, e.date_text, e.payment_text, ...e.items.flatMap((i) => [i.qty_text, i.unit_price_text, i.line_total_text])];
        for (const s of spans.filter((x): x is string => !!x)) {
          expect(t, `${c.id}: "${s}"`).toContain(s.toLowerCase().replace(/\s+/g, ""));
        }
      }
    }
  });

  // The code half of the pipeline: given perfect spans, parsers and arithmetic
  // must reproduce every expected number. A failure here is a code bug, not a model error.
  it("normalizer turns the oracle spans into the expected entries for every case", () => {
    const failures: string[] = [];
    for (const c of cases.filter((x) => x.oracle)) {
      const raw: RawExtraction = {
        entries: c.oracle!.entries.map((e) => ({ ...e, confidence: sure })),
        needs_clarification: [],
      };
      const result = scoreCase(c, "transaction", normalizeExtraction(raw, c.text, c.today, 0.7));
      for (const f of result.fields) {
        const bad = FIELDS.filter((k) => !f[k]);
        if (bad.length) failures.push(`${c.id} "${c.text}": ${bad.join(", ")} -> ${JSON.stringify(result.got.entries)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("scoring", () => {
  it("summarizes field accuracy and flags drops of more than 2 points", () => {
    const base = { cases: 10, intentAccuracy: 95, fieldAccuracy: { kind: 95, amount: 92, payment_method: 90, date: 97 } };
    expect(regressions({ ...base, fieldAccuracy: { ...base.fieldAccuracy, amount: 90 } }, base)).toEqual([]);
    expect(regressions({ ...base, fieldAccuracy: { ...base.fieldAccuracy, amount: 89.5 } }, base)).toEqual(["amount 92 -> 89.5"]);
    expect(summarize([]).fieldAccuracy.amount).toBe(100);
  });
});
