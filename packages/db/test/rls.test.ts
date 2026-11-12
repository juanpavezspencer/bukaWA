import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  auditLog,
  businesses,
  captures,
  categoryRules,
  contacts,
  journalLines,
  journals,
  messages,
  rows,
  TENANT_TABLES,
  users,
  findUserByPhoneHash,
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
  });
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
