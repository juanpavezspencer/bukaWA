import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accounts, auditLog, journalLines, journals, withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb, expectPgError } from "@bukuwa/db/testing";
import {
  daySummary,
  LedgerError,
  postJournal,
  reverseJournal,
  trialBalance,
  type JournalDraft,
} from "../src/index.js";

let db: Db;
let biz: string;
let other: string;

const sale = (businessId: string, amount: bigint, extra: Partial<JournalDraft> = {}): JournalDraft => ({
  businessId,
  date: "2026-11-12",
  description: "jual nasi box",
  source: "text",
  lines: [
    { accountCode: "1110", debit: amount },
    { accountCode: "4100", credit: amount },
  ],
  ...extra,
});

async function ledgerError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  throw new Error("expected LedgerError");
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  biz = await createTestBusiness(db, "Catering Rina");
  other = await createTestBusiness(db, "Toko Dimas");
});

describe("postJournal", () => {
  it("posts a balanced journal with its lines and an audit entry", async () => {
    const posted = await withBusiness(db, biz, (tx) => postJournal(tx, sale(biz, 450_000n)));
    expect(posted.status).toBe("posted");
    expect(posted.lines).toHaveLength(2);
    expect(posted.lines.map((l) => [l.debit, l.credit])).toEqual([
      [450_000n, 0n],
      [0n, 450_000n],
    ]);
    const audit = await withBusiness(db, biz, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, posted.id)),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("journal.post");
  });

  it("rejects an unbalanced journal in code and writes nothing", async () => {
    const before = await countJournals(biz);
    const draft = sale(biz, 450_000n, {
      lines: [
        { accountCode: "1110", debit: 450_000n },
        { accountCode: "4100", credit: 45_000n },
      ],
    });
    expect(await ledgerError(withBusiness(db, biz, (tx) => postJournal(tx, draft)))).toBe("UNBALANCED");
    expect(await countJournals(biz)).toBe(before);
  });

  it("rejects an unbalanced journal at the database level even if code is bypassed", async () => {
    const before = await countJournals(biz);
    await expectPgError(
      withBusiness(db, biz, async (tx) => {
        const [j] = await tx
          .insert(journals)
          .values({ businessId: biz, date: "2026-11-12", description: "raw", source: "manual" })
          .returning();
        await tx.insert(journalLines).values([
          { businessId: biz, journalId: j!.id, lineNo: 1, accountId: await acct(tx, biz, "1100"), debit: 100n },
          { businessId: biz, journalId: j!.id, lineNo: 2, accountId: await acct(tx, biz, "4100"), credit: 99n },
        ]);
      }),
      /unbalanced/,
    );
    await expectPgError(
      withBusiness(db, biz, (tx) =>
        tx.insert(journals).values({ businessId: biz, date: "2026-11-12", description: "no lines", source: "manual" }),
      ),
      /at least 2 required/,
    );
    expect(await countJournals(biz)).toBe(before);
  });

  it("rejects unknown account codes", async () => {
    const draft = sale(biz, 1_000n, {
      lines: [
        { accountCode: "9999", debit: 1_000n },
        { accountCode: "4100", credit: 1_000n },
      ],
    });
    expect(await ledgerError(withBusiness(db, biz, (tx) => postJournal(tx, draft)))).toBe("UNKNOWN_ACCOUNT");
  });

  it("refuses to post for a business other than the one in scope", async () => {
    expect(await ledgerError(withBusiness(db, other, (tx) => postJournal(tx, sale(biz, 1_000n))))).toBe(
      "BUSINESS_MISMATCH",
    );
  });

  it("posts once per idempotency key (double-tapped OK button)", async () => {
    const draft = sale(biz, 25_000n, { idempotencyKey: "capture-123" });
    const first = await withBusiness(db, biz, (tx) => postJournal(tx, draft));
    const second = await withBusiness(db, biz, (tx) => postJournal(tx, draft));
    expect(second.id).toBe(first.id);
    expect(second.alreadyPosted).toBe(true);
    const n = await withBusiness(db, biz, async (tx) => {
      const r = await tx.select().from(journals).where(eq(journals.idempotencyKey, "capture-123"));
      return r.length;
    });
    expect(n).toBe(1);
  });

  it("keeps amounts exact beyond Number.MAX_SAFE_INTEGER", async () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const posted = await withBusiness(db, biz, (tx) => postJournal(tx, sale(biz, big)));
    expect(posted.lines[0]!.debit).toBe(big);
  });
});

describe("append-only ledger", () => {
  it("forbids UPDATE and DELETE on journals and lines, even for the table owner", async () => {
    const posted = await withBusiness(db, biz, (tx) => postJournal(tx, sale(biz, 10_000n)));
    // App role has no UPDATE/DELETE privilege at all.
    await expectPgError(
      withBusiness(db, biz, (tx) => tx.update(journals).set({ description: "edited" }).where(eq(journals.id, posted.id))),
      /permission denied/,
    );
    // Owner/superuser connection is still stopped by the trigger.
    await expectPgError(db.update(journals).set({ description: "edited" }).where(eq(journals.id, posted.id)), /append-only/);
    await expectPgError(db.delete(journalLines).where(eq(journalLines.journalId, posted.id)), /append-only/);
    await expectPgError(db.execute(sql`truncate journal_lines cascade`), /append-only/);
  });
});

describe("reverseJournal", () => {
  it("posts a mirror journal that nets the original to zero", async () => {
    const original = await withBusiness(db, biz, (tx) => postJournal(tx, sale(biz, 450_000n)));
    const reversal = await withBusiness(db, biz, (tx) =>
      reverseJournal(tx, { businessId: biz, journalId: original.id, description: "salah input, harusnya 45rb" }),
    );
    expect(reversal.reversesJournalId).toBe(original.id);
    expect(reversal.date).toBe(original.date);
    expect(reversal.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual(
      original.lines.map((l) => [l.accountId, l.credit, l.debit]),
    );
    // Original is untouched.
    const [orig] = await withBusiness(db, biz, (tx) => tx.select().from(journals).where(eq(journals.id, original.id)));
    expect(orig!.description).toBe("jual nasi box");
  });

  it("refuses to reverse the same journal twice", async () => {
    const original = await withBusiness(db, biz, (tx) => postJournal(tx, sale(biz, 5_000n)));
    await withBusiness(db, biz, (tx) => reverseJournal(tx, { businessId: biz, journalId: original.id }));
    expect(
      await ledgerError(withBusiness(db, biz, (tx) => reverseJournal(tx, { businessId: biz, journalId: original.id }))),
    ).toBe("ALREADY_REVERSED");
  });

  it("refuses to reverse a reversal", async () => {
    const original = await withBusiness(db, biz, (tx) => postJournal(tx, sale(biz, 6_000n)));
    const rev = await withBusiness(db, biz, (tx) => reverseJournal(tx, { businessId: biz, journalId: original.id }));
    expect(
      await ledgerError(withBusiness(db, biz, (tx) => reverseJournal(tx, { businessId: biz, journalId: rev.id }))),
    ).toBe("CANNOT_REVERSE_REVERSAL");
  });

  it("cannot see or reverse another business's journal", async () => {
    const theirs = await withBusiness(db, other, (tx) => postJournal(tx, sale(other, 7_000n)));
    expect(
      await ledgerError(withBusiness(db, biz, (tx) => reverseJournal(tx, { businessId: biz, journalId: theirs.id }))),
    ).toBe("NOT_FOUND");
  });
});

describe("trialBalance", () => {
  it("balances and reflects only this business's postings", async () => {
    const { db: fresh } = await createTestDb();
    const a = await createTestBusiness(fresh, "A");
    const b = await createTestBusiness(fresh, "B");
    await withBusiness(fresh, a, async (tx) => {
      await postJournal(tx, {
        businessId: a,
        date: "2026-11-01",
        description: "modal awal",
        source: "manual",
        lines: [
          { accountCode: "1100", debit: 1_000_000n },
          { accountCode: "3100", credit: 1_000_000n },
        ],
      });
      await postJournal(tx, sale(a, 450_000n));
      await postJournal(tx, {
        businessId: a,
        date: "2026-11-12",
        description: "belanja ayam + minyak",
        source: "voice",
        lines: [
          { accountCode: "5100", debit: 175_000n },
          { accountCode: "5100", debit: 38_000n },
          { accountCode: "1100", credit: 213_000n },
        ],
      });
    });
    await withBusiness(fresh, b, (tx) => postJournal(tx, sale(b, 999_000n)));

    const tb = await withBusiness(fresh, a, (tx) => trialBalance(tx, a));
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.totalDebit).toBe(1_000_000n + 450_000n + 213_000n);
    const byCode = Object.fromEntries(tb.rows.map((r) => [r.code, r.balance]));
    expect(byCode).toEqual({
      "1100": 787_000n,
      "1110": 450_000n,
      "3100": -1_000_000n,
      "4100": -450_000n,
      "5100": 213_000n,
    });

    const asOf = await withBusiness(fresh, a, (tx) => trialBalance(tx, a, { asOf: "2026-11-01" }));
    expect(asOf.totalDebit).toBe(1_000_000n);

    // Reversal brings the affected accounts back.
    const tbBefore = tb;
    const [saleJournal] = await withBusiness(fresh, a, (tx) =>
      tx.select().from(journals).where(eq(journals.description, "jual nasi box")),
    );
    await withBusiness(fresh, a, (tx) => reverseJournal(tx, { businessId: a, journalId: saleJournal!.id }));
    const after = await withBusiness(fresh, a, (tx) => trialBalance(tx, a));
    expect(after.balanced).toBe(true);
    const afterByCode = Object.fromEntries(after.rows.map((r) => [r.code, r.balance]));
    expect(afterByCode["1110"]).toBe(0n);
    expect(afterByCode["4100"]).toBe(0n);
    expect(afterByCode["1100"]).toBe(tbBefore.rows.find((r) => r.code === "1100")!.balance);
  });

  it("daySummary reports income and expenses for one date, net of reversals", async () => {
    const { db: fresh } = await createTestDb();
    const a = await createTestBusiness(fresh, "A");
    const summary = await withBusiness(fresh, a, async (tx) => {
      const s1 = await postJournal(tx, sale(a, 450_000n));
      await postJournal(tx, sale(a, 50_000n, { date: "2026-11-11" }));
      await postJournal(tx, {
        businessId: a,
        date: "2026-11-12",
        description: "belanja",
        source: "text",
        lines: [
          { accountCode: "5100", debit: 213_000n },
          { accountCode: "1100", credit: 213_000n },
        ],
      });
      const before = await daySummary(tx, a, "2026-11-12");
      await reverseJournal(tx, { businessId: a, journalId: s1.id });
      return { before, after: await daySummary(tx, a, "2026-11-12") };
    });
    expect(summary.before).toEqual({ incomeIdr: 450_000n, expenseIdr: 213_000n });
    expect(summary.after).toEqual({ incomeIdr: 0n, expenseIdr: 213_000n });
  });

  it("is balanced across everything posted in this suite", async () => {
    const tb = await withBusiness(db, biz, (tx) => trialBalance(tx, biz));
    expect(tb.balanced).toBe(true);
  });
});

async function countJournals(businessId: string): Promise<number> {
  return withBusiness(db, businessId, async (tx) => (await tx.select().from(journals)).length);
}

async function acct(tx: Parameters<Parameters<typeof withBusiness>[2]>[0], businessId: string, code: string) {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.businessId, businessId), eq(accounts.code, code)));
  return row!.id;
}
