import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  auditLog,
  businesses,
  captureReviews,
  captures,
  categoryRules,
  contacts,
  dashboardSessions,
  erasureRequests,
  journalLines,
  journals,
  loginTokens,
  messages,
  reports,
  summarySchedules,
  taxNoticeSchedules,
  usageEvents,
  users,
} from "./schema.js";
import { pgError, withBusiness, type Db, type Tx } from "./client.js";
import { withAdmin } from "./auth.js";
import { seedChartOfAccounts } from "./chart-of-accounts.js";
import { migrationsFolder } from "./migrate.js";

/**
 * In-process Postgres (PGlite) with all migrations applied. The connection is
 * a superuser, like a migration user; withBusiness() drops to the app role,
 * so RLS is exercised exactly as in production.
 */
export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, client };
}

/** Create a business with the default chart of accounts. Test helper only. */
export async function createTestBusiness(db: Db, name = "Warung Test"): Promise<string> {
  const id = randomUUID();
  await withBusiness(db, id, async (tx) => {
    await tx.insert(businesses).values({
      id,
      name,
      type: "fnb",
      ownerPhoneHash: createHash("sha256").update(id).digest("hex"),
      ownerPhoneEnc: Buffer.from("test-ciphertext"),
    });
    await seedChartOfAccounts(tx, id);
  });
  return id;
}

/** Await `p`, expect it to fail with a Postgres error whose message matches `pattern`. */
export async function expectPgError(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const info = pgError(err);
    if (!info) throw err;
    if (!pattern.test(`${info.message} ${info.constraint ?? ""}`)) {
      throw new Error(`expected pg error matching ${pattern}, got: ${info.message}`);
    }
    return;
  }
  throw new Error(`expected pg error matching ${pattern}, but promise resolved`);
}

export async function accountId(tx: Tx, businessId: string, code: string): Promise<string> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.businessId, businessId), eq(accounts.code, code)));
  if (!row) throw new Error(`account ${code} not found`);
  return row.id;
}

/** Put at least one row in every tenant table for the given business. Test helper only. */
export async function populateEveryTenantTable(db: Db, businessId: string): Promise<void> {
  await withBusiness(db, businessId, async (tx) => {
    await tx.insert(users).values({
      businessId,
      phoneHash: `user-${businessId}`,
      phoneEnc: Buffer.from("x"),
    });
    const [contact] = await tx
      .insert(contacts)
      .values({ businessId, name: "Bu Sari", kind: "customer" })
      .returning();
    const [journal] = await tx
      .insert(journals)
      .values({ businessId, date: "2026-11-12", description: "seed", source: "manual" })
      .returning();
    await tx.insert(journalLines).values([
      { businessId, journalId: journal!.id, lineNo: 1, accountId: await accountId(tx, businessId, "1100"), debit: 1000n, contactId: contact!.id },
      { businessId, journalId: journal!.id, lineNo: 2, accountId: await accountId(tx, businessId, "4100"), credit: 1000n },
    ]);
    await tx.insert(captures).values({ businessId, source: "text", rawText: "jual 1rb", journalId: journal!.id });
    await tx.insert(messages).values({ businessId, direction: "inbound", type: "text", body: "halo" });
    await tx.insert(auditLog).values({ businessId, actor: "test", action: "create", entity: "journal" });
    await tx.insert(categoryRules).values({ businessId, pattern: "ayam", kind: "expense", accountId: await accountId(tx, businessId, "5100") });
    await tx.insert(summarySchedules).values({ businessId, frequency: "daily", localTime: "21:00", nextRunAt: new Date("2026-11-12T14:00:00Z") });
    await tx.insert(reports).values({
      businessId,
      kind: "monthly",
      format: "pdf",
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      fileName: "laporan.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("%PDF-"),
    });
    await tx.insert(taxNoticeSchedules).values({ businessId, nextRunAt: new Date("2026-12-01T01:00:00Z") });
    const [user] = await tx.select({ id: users.id }).from(users);
    await tx.insert(loginTokens).values({ businessId, userId: user!.id, tokenHash: `t-${businessId}`, expiresAt: new Date("2026-11-13T00:15:00Z") });
    await tx.insert(dashboardSessions).values({ businessId, userId: user!.id, sessionHash: `s-${businessId}`, expiresAt: new Date("2026-11-20T00:00:00Z") });
    await tx.insert(usageEvents).values({ businessId, kind: "llm", model: "claude-haiku-5-5", inputTokens: 900, outputTokens: 120, costMicroIdr: 2_475_000n });
    await tx.insert(erasureRequests).values({ businessId, requestedAt: new Date("2026-11-12T00:00:00Z"), scheduledFor: new Date("2026-11-19T00:00:00Z") });
  });
  // Reviews are written by the admin console role only.
  const [cap] = await withBusiness(db, businessId, (tx) => tx.select({ id: captures.id }).from(captures));
  await withAdmin(db, (tx) => tx.insert(captureReviews).values({ businessId, captureId: cap!.id, verdict: "correct", reviewer: "admin" }));
}

