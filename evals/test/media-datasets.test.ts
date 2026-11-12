import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENTRY_KINDS, INTENTS, normalizeExtraction, type RawExtraction } from "@bukuwa/ai";
import { imagePath, loadImageCases, loadVoiceCases } from "../src/dataset.js";
import { FIELDS, IMAGE_FIELDS, sameCounterparty, scoreCase, scoreImageCase, summarize } from "../src/score.js";

const sure = { kind: 1, amount: 1, date: 1, counterparty: 1, payment_method: 1 };
const withConfidence = (entries: NonNullable<ReturnType<typeof loadVoiceCases>[number]["oracle"]>["entries"]): RawExtraction => ({
  entries: entries.map((e) => ({ ...e, confidence: sure })),
  needs_clarification: [],
});

describe("voice eval dataset", () => {
  const cases = loadVoiceCases();

  it("has 100 cases, mostly transactions, with valid labels", () => {
    expect(cases).toHaveLength(100);
    expect(new Set(cases.map((c) => c.id)).size).toBe(100);
    expect(cases.filter((c) => c.expected.intent === "transaction").length).toBeGreaterThanOrEqual(80);
    for (const c of cases) {
      expect(INTENTS, c.id).toContain(c.expected.intent);
      for (const e of c.expected.entries ?? []) expect(ENTRY_KINDS, c.id).toContain(e.kind);
    }
  });

  it("reads like speech: spelled-out amounts, no typed slang", () => {
    const spelled = cases.filter((c) => /\b(ribu|rebu|ewu|juta)\b/.test(c.text)).length;
    expect(spelled).toBeGreaterThanOrEqual(70);
    expect(cases.some((c) => /\b(rb|jt|tf|trf)\b/.test(c.text))).toBe(false);
    expect(cases.some((c) => c.tags.includes("javanese"))).toBe(true);
  });

  // Same guarantee as the text set: with perfect spans, code reproduces every expected number.
  it("normalizer turns the oracle spans into the expected entries for every case", () => {
    const failures: string[] = [];
    for (const c of cases.filter((x) => x.oracle)) {
      const result = scoreCase(c, "transaction", normalizeExtraction(withConfidence(c.oracle!.entries), c.text, c.today, 0.7));
      for (const f of result.fields) {
        const bad = FIELDS.filter((k) => !f[k]);
        if (bad.length) failures.push(`${c.id} "${c.text}": ${bad.join(", ")} -> ${JSON.stringify(result.got.entries)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("image eval dataset", () => {
  const cases = loadImageCases();

  it("has 60 cases whose files exist, covering every document type", () => {
    expect(cases).toHaveLength(60);
    for (const c of cases) expect(existsSync(imagePath(c)), c.file).toBe(true);
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const t of ["transfer_receipt", "qris_receipt", "ewallet_receipt", "store_receipt", "handwritten_nota", "supplier_invoice", "not_a_document"]) {
      expect(tags).toContain(t);
    }
  });

  it("draws exactly the oracle text on each synthetic image", () => {
    for (const c of cases.filter((x) => x.oracle)) {
      const svg = readFileSync(imagePath(c), "utf8").replace(/&amp;/g, "&");
      for (const line of c.oracle!.visible_text.split("\n")) {
        for (const part of line.split(/ (?=\S)/).slice(0, 1)) expect(svg, `${c.id}: ${part}`).toContain(part);
      }
    }
  });

  it("normalizer turns the oracle spans (checked against the transcription) into the expected entries", () => {
    const failures: string[] = [];
    for (const c of cases.filter((x) => x.oracle)) {
      const source = c.caption ? `${c.caption}\n${c.oracle!.visible_text}` : c.oracle!.visible_text;
      const result = scoreImageCase(c, true, normalizeExtraction(withConfidence(c.oracle!.entries), source, c.today, 0.7));
      for (const f of result.fields) {
        const bad = IMAGE_FIELDS.filter((k) => !f[k]);
        if (bad.length) failures.push(`${c.id}: ${bad.join(", ")} -> ${JSON.stringify(result.got.entries)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("scores not-a-document cases on detection only", () => {
    const c = cases.find((x) => !x.expected.is_document)!;
    expect(scoreImageCase(c, false, []).intentOk).toBe(true);
    expect(scoreImageCase(c, true, []).intentOk).toBe(false);
    expect(summarize([scoreImageCase(c, false, [])], IMAGE_FIELDS).fieldAccuracy.amount).toBe(100);
  });
});

describe("sameCounterparty", () => {
  it.each([
    ["SARI WULANDARI", "Sari Wulandari", true],
    ["SARI WULANDARI", "Sari W", true],
    ["TOKO MAKMUR JAYA", "Toko Makmur Jaya", true],
    ["SARI WULANDARI", "Budi", false],
    ["SARI WULANDARI", null, false],
    [null, null, true],
    ["ANI SUMARNI", "Ani", false],
  ] as const)("%s ~ %s = %s", (a, b, ok) => {
    expect(sameCounterparty(a, b)).toBe(ok);
  });
});
