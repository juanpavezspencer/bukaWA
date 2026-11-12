import { describe, expect, it } from "vitest";
import { correctedDraft, LedgerError, validateJournalDraft, type CorrectableJournal } from "../src/index.js";

const BIZ = "00000000-0000-4000-8000-000000000001";
const expense: CorrectableJournal = {
  id: "j1",
  date: "2026-11-12",
  description: "Belanja ayam",
  kind: "expense",
  reversed: false,
  lines: [
    { code: "5100", debit: 450_000n, credit: 0n, memo: "Pak Harun" },
    { code: "1100", debit: 0n, credit: 450_000n, memo: "Pak Harun" },
  ],
};

function code(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
}

describe("correctedDraft", () => {
  it("changes the amount on both sides and keeps accounts, memo and description", () => {
    const d = correctedDraft(BIZ, expense, { amountIdr: 45_000n });
    expect(d.lines).toEqual([
      { accountCode: "5100", debit: 45_000n, memo: "Pak Harun" },
      { accountCode: "1100", credit: 45_000n, memo: "Pak Harun" },
    ]);
    expect(d).toMatchObject({ date: "2026-11-12", description: "Belanja ayam", source: "manual" });
    expect(validateJournalDraft(d)).toBeUndefined();
  });

  it("changes date, payment account and category", () => {
    const d = correctedDraft(BIZ, expense, { date: "2026-11-11", paymentCode: "1110", categoryCode: "6900" });
    expect(d.date).toBe("2026-11-11");
    expect(d.lines.map((l) => l.accountCode)).toEqual(["6900", "1110"]);
  });

  it("keeps a sale's category on the income side", () => {
    const sale: CorrectableJournal = {
      ...expense,
      kind: "sale",
      lines: [
        { code: "1110", debit: 100_000n, credit: 0n, memo: null },
        { code: "4100", debit: 0n, credit: 100_000n, memo: null },
      ],
    };
    expect(code(() => correctedDraft(BIZ, sale, { categoryCode: "5100" }))).toBe("INVALID_CATEGORY");
    expect(correctedDraft(BIZ, sale, { categoryCode: "4200" }).lines[1]).toMatchObject({ accountCode: "4200", credit: 100_000n });
  });

  it("refuses an amount change on split entries, and category changes on owner entries", () => {
    const split: CorrectableJournal = {
      ...expense,
      lines: [
        { code: "5100", debit: 175_000n, credit: 0n, memo: null },
        { code: "6300", debit: 100_000n, credit: 0n, memo: null },
        { code: "1100", debit: 0n, credit: 275_000n, memo: null },
      ],
    };
    expect(code(() => correctedDraft(BIZ, split, { amountIdr: 200_000n }))).toBe("NOT_CORRECTABLE");
    expect(correctedDraft(BIZ, split, { paymentCode: "1110" }).lines.map((l) => l.accountCode)).toEqual(["5100", "6300", "1110"]);
    const drawing: CorrectableJournal = { ...expense, kind: "owner_drawing", lines: [{ code: "3200", debit: 1n, credit: 0n, memo: null }, { code: "1100", debit: 0n, credit: 1n, memo: null }] };
    expect(code(() => correctedDraft(BIZ, drawing, { categoryCode: "6900" }))).toBe("NOT_CORRECTABLE");
  });

  it("refuses reversed journals, empty changes and non-money payment accounts", () => {
    expect(code(() => correctedDraft(BIZ, { ...expense, reversed: true }, { amountIdr: 1n }))).toBe("ALREADY_REVERSED");
    expect(code(() => correctedDraft(BIZ, expense, {}))).toBe("NOT_CORRECTABLE");
    expect(code(() => correctedDraft(BIZ, expense, { paymentCode: "4100" }))).toBe("INVALID_CATEGORY");
    expect(code(() => correctedDraft(BIZ, expense, { amountIdr: 0n }))).toBe("INVALID_AMOUNT");
  });
});
