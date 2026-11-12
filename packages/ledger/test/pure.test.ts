import { describe, expect, it } from "vitest";
import {
  buildReversalLines,
  LedgerError,
  summarizeTrialBalance,
  validateJournalDraft,
  type JournalDraft,
} from "../src/index.js";

const base: JournalDraft = {
  businessId: "00000000-0000-4000-8000-000000000001",
  date: "2026-11-12",
  description: "jual nasi box 25 x 18rb",
  source: "text",
  lines: [
    { accountCode: "1110", debit: 450_000n },
    { accountCode: "4100", credit: 450_000n },
  ],
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return undefined;
}

describe("validateJournalDraft", () => {
  it("accepts a balanced two-line journal", () => {
    expect(() => validateJournalDraft(base)).not.toThrow();
  });

  it("accepts a balanced multi-line journal", () => {
    expect(
      codeOf(() =>
        validateJournalDraft({
          ...base,
          lines: [
            { accountCode: "5100", debit: 175_000n },
            { accountCode: "5100", debit: 38_000n },
            { accountCode: "1100", credit: 213_000n },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects an unbalanced journal", () => {
    const draft = { ...base, lines: [{ accountCode: "1110", debit: 450_000n }, { accountCode: "4100", credit: 45_000n }] };
    expect(codeOf(() => validateJournalDraft(draft))).toBe("UNBALANCED");
  });

  it("rejects fewer than two lines", () => {
    expect(codeOf(() => validateJournalDraft({ ...base, lines: [{ accountCode: "1110", debit: 1n }] }))).toBe(
      "TOO_FEW_LINES",
    );
  });

  it("rejects a line with both or neither side set", () => {
    const both = { ...base, lines: [{ accountCode: "1110", debit: 1n, credit: 1n }, { accountCode: "4100", credit: 0n }] };
    expect(codeOf(() => validateJournalDraft(both))).toBe("INVALID_LINE");
    const neither = { ...base, lines: [{ accountCode: "1110" }, { accountCode: "4100" }] };
    expect(codeOf(() => validateJournalDraft(neither))).toBe("INVALID_LINE");
  });

  it("rejects negative amounts", () => {
    const draft = { ...base, lines: [{ accountCode: "1110", debit: -5n }, { accountCode: "4100", credit: -5n }] };
    expect(codeOf(() => validateJournalDraft(draft))).toBe("INVALID_AMOUNT");
  });

  it("rejects non-bigint money (no floats, no plain numbers)", () => {
    const draft = {
      ...base,
      lines: [
        { accountCode: "1110", debit: 450000.5 },
        { accountCode: "4100", credit: 450000.5 },
      ],
    } as unknown as JournalDraft;
    expect(codeOf(() => validateJournalDraft(draft))).toBe("INVALID_AMOUNT");
  });

  it("rejects malformed or impossible dates", () => {
    expect(codeOf(() => validateJournalDraft({ ...base, date: "12/11/2026" }))).toBe("INVALID_DATE");
    expect(codeOf(() => validateJournalDraft({ ...base, date: "2026-02-30" }))).toBe("INVALID_DATE");
  });

  it("rejects an empty description", () => {
    expect(codeOf(() => validateJournalDraft({ ...base, description: "  " }))).toBe("INVALID_DESCRIPTION");
  });
});

describe("buildReversalLines", () => {
  it("swaps debit and credit on every line and keeps accounts and contacts", () => {
    const lines = buildReversalLines([
      { lineNo: 1, accountId: "a", debit: 450_000n, credit: 0n, contactId: "c", memo: null },
      { lineNo: 2, accountId: "b", debit: 0n, credit: 450_000n, contactId: null, memo: "x" },
    ]);
    expect(lines).toEqual([
      { lineNo: 1, accountId: "a", debit: 0n, credit: 450_000n, contactId: "c", memo: null },
      { lineNo: 2, accountId: "b", debit: 450_000n, credit: 0n, contactId: null, memo: "x" },
    ]);
  });
});

describe("summarizeTrialBalance", () => {
  it("totals debits and credits and reports whether they match", () => {
    const tb = summarizeTrialBalance([
      { accountId: "1", code: "1110", name: "Bank", type: "asset", debit: 500n, credit: 100n },
      { accountId: "2", code: "4100", name: "Penjualan", type: "income", debit: 0n, credit: 400n },
    ]);
    expect(tb.totalDebit).toBe(500n);
    expect(tb.totalCredit).toBe(500n);
    expect(tb.balanced).toBe(true);
    expect(tb.rows[0]!.balance).toBe(400n);
    expect(tb.rows[1]!.balance).toBe(-400n);
  });

  it("flags an out-of-balance set", () => {
    const tb = summarizeTrialBalance([
      { accountId: "1", code: "1110", name: "Bank", type: "asset", debit: 500n, credit: 0n },
    ]);
    expect(tb.balanced).toBe(false);
  });
});
