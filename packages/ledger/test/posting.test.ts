import { describe, expect, it } from "vitest";
import { buildJournalDraft, LedgerError, paymentAccountCode, validateJournalDraft, type PostableEntry } from "../src/index.js";

const BIZ = "00000000-0000-4000-8000-000000000001";
const base = { date: "2026-11-12", description: "jual nasi box", source: "text" as const, idempotencyKey: "cap-1:0" };

function code(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
}

describe("paymentAccountCode", () => {
  it.each([
    ["cash", "1100"],
    ["bank:BCA", "1110"],
    ["bank:other", "1110"],
    ["qris", "1110"],
    ["ewallet:GoPay", "1120"],
  ])("%s -> %s", (pm, acct) => {
    expect(paymentAccountCode(pm)).toBe(acct);
  });

  it.each(["other", "", "kartu kredit"])("returns null for %j", (pm) => {
    expect(paymentAccountCode(pm)).toBeNull();
  });
});

describe("buildJournalDraft", () => {
  it("sale: debit the payment account, credit income", () => {
    const entry: PostableEntry = { ...base, kind: "sale", amountIdr: 450_000n, paymentMethod: "bank:BCA" };
    const d = buildJournalDraft(BIZ, entry);
    expect(d.lines).toEqual([
      { accountCode: "1110", debit: 450_000n, memo: null },
      { accountCode: "4100", credit: 450_000n, memo: null },
    ]);
    expect(d.idempotencyKey).toBe("cap-1:0");
    expect(() => validateJournalDraft(d)).not.toThrow();
  });

  it("expense: debit the category, credit the payment account", () => {
    const d = buildJournalDraft(BIZ, {
      ...base,
      kind: "expense",
      amountIdr: 213_000n,
      paymentMethod: "cash",
      accountCode: "5100",
      counterparty: "Pasar Minggu",
    });
    expect(d.lines).toEqual([
      { accountCode: "5100", debit: 213_000n, memo: "Pasar Minggu" },
      { accountCode: "1100", credit: 213_000n, memo: "Pasar Minggu" },
    ]);
  });

  it("uses default categories when none is given", () => {
    expect(buildJournalDraft(BIZ, { ...base, kind: "sale", amountIdr: 1n, paymentMethod: "cash" }).lines[1]!.accountCode).toBe("4100");
    expect(buildJournalDraft(BIZ, { ...base, kind: "expense", amountIdr: 1n, paymentMethod: "cash" }).lines[0]!.accountCode).toBe("6900");
  });

  it("owner capital and drawings hit equity", () => {
    const cap = buildJournalDraft(BIZ, { ...base, kind: "owner_capital", amountIdr: 1_000_000n, paymentMethod: "cash" });
    expect(cap.lines.map((l) => l.accountCode)).toEqual(["1100", "3100"]);
    const draw = buildJournalDraft(BIZ, { ...base, kind: "owner_drawing", amountIdr: 200_000n, paymentMethod: "ewallet:DANA" });
    expect(draw.lines.map((l) => [l.accountCode, l.debit ?? 0n, l.credit ?? 0n])).toEqual([
      ["3200", 200_000n, 0n],
      ["1120", 0n, 200_000n],
    ]);
  });

  it("rejects a category that doesn't fit the kind", () => {
    expect(code(() => buildJournalDraft(BIZ, { ...base, kind: "sale", amountIdr: 1n, paymentMethod: "cash", accountCode: "6100" }))).toBe(
      "INVALID_CATEGORY",
    );
    expect(code(() => buildJournalDraft(BIZ, { ...base, kind: "expense", amountIdr: 1n, paymentMethod: "cash", accountCode: "4100" }))).toBe(
      "INVALID_CATEGORY",
    );
  });

  it("allows stock purchases as an expense-side asset", () => {
    const d = buildJournalDraft(BIZ, { ...base, kind: "expense", amountIdr: 5n, paymentMethod: "cash", accountCode: "1300" });
    expect(d.lines[0]!.accountCode).toBe("1300");
  });

  it("refuses to guess an unknown payment method", () => {
    expect(code(() => buildJournalDraft(BIZ, { ...base, kind: "sale", amountIdr: 1n, paymentMethod: null }))).toBe("MISSING_PAYMENT_METHOD");
  });

  it("refuses kinds that later milestones handle", () => {
    for (const kind of ["receivable", "payable", "settlement", "transfer_in", "transfer_out"] as const) {
      expect(code(() => buildJournalDraft(BIZ, { ...base, kind, amountIdr: 1n, paymentMethod: "cash" }))).toBe("UNSUPPORTED_KIND");
    }
  });

  it("refuses zero or negative amounts", () => {
    expect(code(() => buildJournalDraft(BIZ, { ...base, kind: "sale", amountIdr: 0n, paymentMethod: "cash" }))).toBe("INVALID_AMOUNT");
  });
});
