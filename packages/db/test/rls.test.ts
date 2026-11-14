import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  auditLog,
  businesses,
  captures,
  categoryRules,
  dueSummaryBusinesses,
  dueTaxNoticeBusinesses,
  reports,
  captureReviews,
  dashboardSessions,
  loginTokens,
  summarySchedules,
  taxNoticeSchedules,
  taxProfiles,
  contacts,
  journalLines,
  journals,
  messages,
  rows,
  TENANT_TABLES,
  users,
  findUserByPhoneHash,
  withAdmin,
  withAppRole,
  withBusiness,
  type Db,
  type Tx,
} from "../src/index.js";
import { createTestBusiness, createTestDb, expectPgError } from "../src/testing.js";

let db: Db;
let bizA: string;
let bizB: string;

async function accountId(tx: Tx, businessId: string, code: string): Promise<string> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.businessId, businessId), eq(accounts.code, code)));
  if (!row) throw new Error(`account ${code} not found`);
  return row.id;
}

/** Put one row in every tenant table for the given business. */
async function populate(businessId: string): Promise<void> {
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
  });
  // Reviews are written by the admin console role only.
  const [cap] = await withBusiness(db, businessId, (tx) => tx.select({ id: captures.id }).from(captures));
  await withAdmin(db, (tx) => tx.insert(captureReviews).values({ businessId, captureId: cap!.id, verdict: "correct", reviewer: "admin" }));
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  bizA = await createTestBusiness(db, "Catering Rina");
  bizB = await createTestBusiness(db, "Toko Dimas");
  await populate(bizA);
  await populate(bizB);
});

function tenantColumn(table: string): string {
  return table === "businesses" ? "id" : "business_id";
}

describe("row-level security", () => {
  it("covers every table that has a business_id column, with RLS enabled and forced", async () => {
    const result = await db.execute(sql`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname = 'businesses' or exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'business_id'))
      order by 1`);
    const tables = rows<{ table: string; enabled: boolean; forced: boolean }>(result);
    expect(tables.map((r) => r.table).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of tables) {
      expect(r, r.table).toMatchObject({ enabled: true, forced: true });
    }
  });

  it.each(TENANT_TABLES)("%s: business B sees only its own rows, never business A's", async (table) => {
    const col = sql.identifier(tenantColumn(table));
    const t = sql.identifier(table);
    const counts = await withBusiness(db, bizB, async (tx) => {
      const r = await tx.execute(sql`
        select count(*)::int as total,
               count(*) filter (where ${col} = ${bizA})::int as other,
               count(*) filter (where ${col} = ${bizB})::int as own
        from ${t}`);
      return rows<{ total: number; other: number; own: number }>(r)[0]!;
    });
    expect(counts.other).toBe(0);
    expect(counts.own).toBeGreaterThan(0);
    expect(counts.total).toBe(counts.own);
  });

  it.each(TENANT_TABLES)("%s: no rows are visible when no business is selected", async (table) => {
    const total = await withAppRole(db, async (tx) => {
      const r = await tx.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`);
      return rows<{ n: number }>(r)[0]!.n;
    });
    expect(total).toBe(0);
  });

  it("lets the scheduler find due summaries without seeing anything else", async () => {
    expect((await dueSummaryBusinesses(db, new Date("2026-11-12T14:00:00Z"))).sort()).toEqual([bizA, bizB].sort());
    expect(await dueSummaryBusinesses(db, new Date("2026-11-12T13:59:00Z"))).toEqual([]);
    // The scan flag opens summary_schedules for reading only, and nothing else.
    const seen = await withAppRole(db, async (tx) => {
      await tx.execute(sql`select set_config('app.summary_scan', 'on', true)`);
      const n = async (t: string) => rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)}`))[0]!.n;
      return { journals: await n("journals"), businesses: await n("businesses"), users: await n("users") };
    });
    expect(seen).toEqual({ journals: 0, businesses: 0, users: 0 });
    const updated = await withAppRole(db, async (tx) => {
      await tx.execute(sql`select set_config('app.summary_scan', 'on', true)`);
      return tx.update(summarySchedules).set({ enabled: false }).returning();
    });
    expect(updated).toHaveLength(0);
  });

  it("lets the scheduler find due tax notices without seeing anything else", async () => {
    expect((await dueTaxNoticeBusinesses(db, new Date("2026-12-01T01:00:00Z"))).sort()).toEqual([bizA, bizB].sort());
    expect(await dueTaxNoticeBusinesses(db, new Date("2026-12-01T00:59:00Z"))).toEqual([]);
    const seen = await withAppRole(db, async (tx) => {
      await tx.execute(sql`select set_config('app.tax_notice_scan', 'on', true)`);
      const n = async (t: string) => rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)}`))[0]!.n;
      return { reports: await n("reports"), businesses: await n("businesses"), summaries: await n("summary_schedules") };
    });
    expect(seen).toEqual({ reports: 0, businesses: 0, summaries: 0 });
    const updated = await withAppRole(db, async (tx) => {
      await tx.execute(sql`select set_config('app.tax_notice_scan', 'on', true)`);
      return tx.update(taxNoticeSchedules).set({ enabled: false }).returning();
    });
    expect(updated).toHaveLength(0);
  });

  it("never serves another business's report file, even by id", async () => {
    const [a] = await withBusiness(db, bizA, (tx) => tx.select({ id: reports.id }).from(reports));
    const fromB = await withBusiness(db, bizB, (tx) => tx.select().from(reports).where(eq(reports.id, a!.id)));
    expect(fromB).toEqual([]);
  });

  it("keeps generated reports insert-only for the app", async () => {
    await expectPgError(
      withBusiness(db, bizA, (tx) => tx.update(reports).set({ fileName: "x" })),
      /permission denied/,
    );
    await expectPgError(
      withBusiness(db, bizA, (tx) => tx.delete(reports)),
      /permission denied/,
    );
  });

  it("lets the app read tax profiles but never change them", async () => {
    const profiles = await withAppRole(db, (tx) => tx.select().from(taxProfiles));
    expect(profiles.length).toBeGreaterThan(0);
    await expectPgError(
      withAppRole(db, (tx) => tx.update(taxProfiles).set({ rateBps: 0 })),
      /permission denied/,
    );
  });

  it("rejects writing a row tagged with another business", async () => {
    await expectPgError(
      withBusiness(db, bizB, (tx) =>
        tx.insert(journals).values({ businessId: bizA, date: "2026-11-12", description: "x", source: "manual" }),
      ),
      /row-level security/,
    );
    await expectPgError(
      withBusiness(db, bizB, (tx) => tx.insert(contacts).values({ businessId: bizA, name: "intruder" })),
      /row-level security/,
    );
  });

  it("cannot update or read another business's profile", async () => {
    const updated = await withBusiness(db, bizB, (tx) =>
      tx.update(businesses).set({ name: "hacked" }).where(eq(businesses.id, bizA)).returning(),
    );
    expect(updated).toHaveLength(0);
    const nameA = await withBusiness(db, bizA, async (tx) => {
      const [b] = await tx.select().from(businesses).where(eq(businesses.id, bizA));
      return b?.name;
    });
    expect(nameA).toBe("Catering Rina");
  });

  it("rejects a journal line in B that points at A's account", async () => {
    const aCash = await withBusiness(db, bizA, (tx) => accountId(tx, bizA, "1100"));
    await expectPgError(
      withBusiness(db, bizB, async (tx) => {
        const [j] = await tx
          .insert(journals)
          .values({ businessId: bizB, date: "2026-11-12", description: "x", source: "manual" })
          .returning();
        await tx.insert(journalLines).values([
          { businessId: bizB, journalId: j!.id, lineNo: 1, accountId: aCash, debit: 5n },
          { businessId: bizB, journalId: j!.id, lineNo: 2, accountId: await accountId(tx, bizB, "4100"), credit: 5n },
        ]);
      }),
      /journal_lines_account_fk/,
    );
  });

  it("refuses a malformed business id instead of running unscoped", async () => {
    await expect(withBusiness(db, "' or 1=1 --", async () => 1)).rejects.toThrow(/invalid business id/);
    await expect(withBusiness(db, randomUUID(), async (tx) => tx.select().from(journals))).resolves.toEqual([]);
  });
});

describe("phone lookup policy", () => {
  it("reveals only the sender's own users row, and nothing else", async () => {
    const found = await withAppRole(db, async (tx) => {
      const user = await findUserByPhoneHash(tx, `user-${bizA}`);
      const r = await tx.execute(sql`
        select (select count(*)::int from users) as users,
               (select count(*)::int from businesses) as businesses,
               (select count(*)::int from journals) as journals`);
      return { user, counts: rows<{ users: number; businesses: number; journals: number }>(r)[0]! };
    });
    expect(found.user?.businessId).toBe(bizA);
    expect(found.counts).toEqual({ users: 1, businesses: 0, journals: 0 });
  });

  it("does not allow writes through the lookup policy", async () => {
    const updated = await withAppRole(db, async (tx) => {
      await findUserByPhoneHash(tx, `user-${bizA}`);
      return tx.update(users).set({ consentVersion: "x" }).where(eq(users.phoneHash, `user-${bizA}`)).returning();
    });
    expect(updated).toHaveLength(0);
  });

  it("finds nobody for an unknown phone", async () => {
    expect(await withAppRole(db, (tx) => findUserByPhoneHash(tx, "nope"))).toBeUndefined();
  });
});

describe("chart of accounts seed", () => {
  it("seeds the default UMKM accounts once per business", async () => {
    const rows = await withBusiness(db, bizA, (tx) => tx.select().from(accounts));
    expect(rows).toHaveLength(19);
    expect(rows.find((r) => r.code === "4100")).toMatchObject({ name: "Penjualan", type: "income", isSystem: true });
  });
});
