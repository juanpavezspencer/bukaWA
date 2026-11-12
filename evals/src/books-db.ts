/**
 * Posts the fixture books (books-fixture.ts) into an in-process Postgres, so
 * the question set runs against the real ledger, RLS and agent tools.
 */
import { withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import { buildJournalDraft, postJournal, reverseJournal } from "@bukuwa/ledger";
import { buildFixture, FIXTURE_BUSINESS } from "./books-fixture.js";

export interface FixtureBooks {
  db: Db;
  businessId: string;
  /** Fixture entry key -> journal id. */
  journalIds: Map<string, string>;
}

export async function seedFixtureBooks(): Promise<FixtureBooks> {
  const { db } = await createTestDb();
  const businessId = await createTestBusiness(db, FIXTURE_BUSINESS);
  const journalIds = new Map<string, string>();
  await withBusiness(db, businessId, async (tx) => {
    for (const e of buildFixture()) {
      const posted = await postJournal(
        tx,
        buildJournalDraft(businessId, {
          kind: e.kind,
          amountIdr: BigInt(e.amountIdr),
          date: e.date,
          description: e.description,
          source: "text",
          paymentMethod: e.paymentMethod,
          accountCode: e.kind === "sale" || e.kind === "expense" ? e.accountCode : undefined,
          counterparty: e.counterparty,
        }),
      );
      journalIds.set(e.key, posted.id);
      if (e.cancelled) await reverseJournal(tx, { businessId, journalId: posted.id });
    }
  });
  return { db, businessId, journalIds };
}
