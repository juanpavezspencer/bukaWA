/**
 * Offline check of the question set: posts the fixture books into PGlite,
 * runs each case's oracle tool call through the real agent tools and checks
 * the expected amounts come back. This validates the dataset and the
 * read-only tools together, without calling a model.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTools } from "@bukuwa/worker/agent/tools";
import { loadQuestionCases } from "../src/dataset.js";
import { seedFixtureBooks, type FixtureBooks } from "../src/books-db.js";
import { FIXTURE_TODAY } from "../src/books-fixture.js";
import { quotesAmount, scoreQuestionCase } from "../src/score.js";

const cases = loadQuestionCases();
let books: FixtureBooks;

beforeAll(async () => {
  books = await seedFixtureBooks();
}, 60_000);

describe("question dataset", () => {
  it("has about 100 well-formed cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      if (c.expected.kind === "answer" || c.expected.kind === "reminder") expect(c.expected.must_include?.length, c.id).toBeGreaterThan(0);
      if (c.expected.kind === "correction") expect(c.expected.correction, c.id).toBeDefined();
    }
  });

  it.each(cases.filter((c) => c.oracle).map((c) => [c.id, c.text, c] as const))("%s %s: oracle tools return the expected amounts", async (_id, _t, c) => {
    let reminder = "";
    const byName = new Map(
      buildTools({ db: books.db, businessId: books.businessId, today: FIXTURE_TODAY, message: c.text, businessName: "Catering Bu Rina" }, () => {}, (r) => {
        reminder = `${r.contactName}: ${r.text}`;
      }).map((t) => [t.name, t]),
    );
    let out = "";
    for (const call of c.oracle!) {
      const tool = byName.get(call.tool)!;
      const r = await tool.run(tool.input.parse(call.input));
      out += JSON.stringify(r.output);
    }
    if (c.expected.kind === "reminder") {
      expect(reminder.startsWith(`${c.expected.reminder_contact}: `), reminder).toBe(true);
      out = reminder;
    }
    for (const amount of c.expected.must_include!) expect(out, `${amount} not in ${out.slice(0, 400)}`).toContain(amount);
  });

  it.each(cases.filter((c) => c.expected.kind === "correction").map((c) => [c.id, c.text, c] as const))(
    "%s %s: target exists and the correction is valid",
    async (_id, _t, c) => {
      const x = c.expected.correction!;
      const ref = books.journalIds.get(x.entry_key);
      expect(ref).toBeDefined();
      let proposal: { journalId: string; action: string; amountIdr?: string; paymentCode?: string } | undefined;
      const propose = buildTools({ db: books.db, businessId: books.businessId, today: FIXTURE_TODAY, message: c.text }, (p) => (proposal = p)).find(
        (t) => t.name === "propose_correction",
      )!;
      const amountText = x.amount_idr ? c.text.match(/\d+\s*(rb|ribu)/i)?.[0] ?? null : null;
      const r = await propose.run(
        propose.input.parse({
          ref,
          action: x.action,
          new_amount_text: amountText,
          new_date_text: null,
          new_payment_text: x.payment_code ? "transfer" : null,
          new_category: null,
        }),
      );
      expect(r.stop, JSON.stringify(r.output)).toBe(true);
      const scored = scoreQuestionCase(c, { kind: "proposal", ...proposal! }, books.journalIds);
      expect(scored.fields[0]).toEqual({ correction_target: true, correction_change: true });
    },
  );
});

describe("question scoring", () => {
  it("accepts amounts with or without Rp and spacing", () => {
    expect(quotesAmount("Untungnya *Rp 1.250.000* kak", "Rp 1.250.000")).toBe(true);
    expect(quotesAmount("untung Rp1.250.000", "Rp 1.250.000")).toBe(true);
    expect(quotesAmount("untung Rp 1.250.000,00", "Rp 1.250.000")).toBe(true);
    expect(quotesAmount("untung Rp 12.500.000", "Rp 1.250.000")).toBe(false);
  });
});
