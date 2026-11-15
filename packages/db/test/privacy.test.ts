import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  consumeInvite,
  dueErasures,
  erasureRequests,
  eraseBusiness,
  findUsableInvite,
  normalizeInviteCode,
  pilotInvites,
  rows,
  TENANT_TABLES,
  usageEvents,
  waInbound,
  withAdmin,
  withAppRole,
  withBusiness,
  type Db,
} from "../src/index.js";
import { createTestBusiness, createTestDb, expectPgError, populateEveryTenantTable } from "../src/testing.js";

let db: Db;
let bizA: string;
let bizB: string;
const NOW = new Date("2026-11-20T00:00:00Z");

/** Rows per tenant table for one business, read as the superuser (bypasses RLS). */
async function rowCounts(businessId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TENANT_TABLES) {
    const col = sql.identifier(t === "businesses" ? "id" : "business_id");
    const r = await db.execute(sql`select count(*)::int as n from ${sql.identifier(t)} where ${col} = ${businessId}`);
    out[t] = rows<{ n: number }>(r)[0]!.n;
  }
  return out;
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  bizA = await createTestBusiness(db, "Catering Rina");
  bizB = await createTestBusiness(db, "Toko Dimas");
  // populateEveryTenantTable files an erasure request due 2026-11-19 for each.
  await populateEveryTenantTable(db, bizA);
  await populateEveryTenantTable(db, bizB);
  await db.insert(waInbound).values([
    { waMessageId: "wamid.A1", fromPhone: "6281211110000", type: "text", payload: {} },
    { waMessageId: "wamid.B1", fromPhone: "6281322220000", type: "text", payload: {} },
  ]);
});

describe("erase_business", () => {
  it("deletes every row of the business in every tenant table, and leaves others alone", async () => {
    const before = await rowCounts(bizB);
    const counts = await eraseBusiness(db, bizA, "+6281211110000", NOW);

    expect(Object.values(await rowCounts(bizA)).every((n) => n === 0)).toBe(true);
    expect(await rowCounts(bizB)).toEqual(before);
    for (const t of TENANT_TABLES) expect(counts[t], t).toBeGreaterThan(0);
    expect(counts.wa_inbound).toBe(1);
    const left = rows<{ id: string }>(await db.execute(sql`select wa_message_id as id from wa_inbound`));
    expect(left.map((r) => r.id)).toEqual(["wamid.B1"]);

    const log = rows<{ subject_id: string; row_counts: Record<string, number> }>(await db.execute(sql`select subject_id, row_counts from erasure_log`));
    expect(log).toHaveLength(1);
    expect(log[0]!.subject_id).toBe(bizA);
    expect(log[0]!.row_counts.journals).toBeGreaterThan(0);
  });

  it("covers every tenant table (so a new table can't be forgotten)", async () => {
    const counts = await eraseBusiness(db, bizA, "+6281211110000", NOW);
    expect(Object.keys(counts).filter((k) => k !== "wa_inbound").sort()).toEqual([...TENANT_TABLES].sort());
  });

  it("refuses before the grace period ends", async () => {
    await expectPgError(eraseBusiness(db, bizA, "+6281211110000", new Date("2026-11-18T00:00:00Z")), /no due erasure request/);
    expect((await rowCounts(bizA)).journals).toBeGreaterThan(0);
  });

  it("refuses a cancelled request", async () => {
    await withBusiness(db, bizA, (tx) => tx.update(erasureRequests).set({ cancelledAt: new Date("2026-11-13T00:00:00Z") }));
    await expectPgError(eraseBusiness(db, bizA, "+6281211110000", NOW), /no due erasure request/);
  });

  it("refuses a business with no request", async () => {
    await db.execute(sql`delete from erasure_requests where business_id = ${bizA}`);
    await expectPgError(eraseBusiness(db, bizA, "+6281211110000", NOW), /no due erasure request/);
  });

  it("keeps the ledger append-only outside erasure, even with the erasure setting forged", async () => {
    await expectPgError(db.execute(sql`delete from journal_lines where business_id = ${bizA}`), /append-only/);
    await expectPgError(
      withBusiness(db, bizA, async (tx) => {
        await tx.execute(sql`select set_config('app.erasing_business', ${bizA}, true)`);
        await tx.execute(sql`delete from journals where business_id = ${bizA}`);
      }),
      /permission denied/,
    );
  });

  it("lists only due, uncancelled requests for the scheduler", async () => {
    await db.execute(sql`update erasure_requests set scheduled_for = '2026-12-01T00:00:00Z' where business_id = ${bizB}`);
    expect(await dueErasures(db, NOW)).toEqual([bizA]);
  });
});

describe("usage metering", () => {
  it("is insert-only for the app", async () => {
    await expectPgError(
      withBusiness(db, bizA, (tx) => tx.update(usageEvents).set({ costMicroIdr: 0n })),
      /permission denied/,
    );
  });

  it("rejects a negative cost", async () => {
    await expectPgError(
      withBusiness(db, bizA, (tx) => tx.insert(usageEvents).values({ businessId: bizA, kind: "llm", model: "x", costMicroIdr: -1n })),
      /usage_events_cost/,
    );
  });
});

describe("pilot invites", () => {
  beforeEach(async () => {
    await withAdmin(db, (tx) =>
      tx.insert(pilotInvites).values([
        { code: "BUKU42", cohort: "bandung-fnb", maxUses: 2, createdBy: "admin" },
        { code: "LAMA01", cohort: "old", maxUses: 5, createdBy: "admin", expiresAt: new Date("2026-11-01T00:00:00Z") },
      ]),
    );
  });

  it("reads codes the way owners type them", () => {
    expect(normalizeInviteCode("kode buku42")).toBe("BUKU42");
    expect(normalizeInviteCode("Kode: BUKU-42")).toBe("BUKU42");
    expect(normalizeInviteCode("BUKU42")).toBe("BUKU42");
    expect(normalizeInviteCode("Halo, mau daftar. KODE BUKU42")).toBe("BUKU42");
    expect(normalizeInviteCode("daftar pakai buku42 ya")).toBe("BUKU42");
    expect(normalizeInviteCode("halo")).toBe("HALO");
    expect(normalizeInviteCode("halo kak")).toBeNull();
    expect(normalizeInviteCode("??")).toBeNull();
  });

  it("counts uses up to the limit, then refuses", async () => {
    await withAppRole(db, async (tx) => {
      expect(await findUsableInvite(tx, "BUKU42", NOW)).toEqual({ code: "BUKU42", cohort: "bandung-fnb" });
      expect(await consumeInvite(tx, "BUKU42", NOW)).not.toBeNull();
      expect(await consumeInvite(tx, "BUKU42", NOW)).not.toBeNull();
      expect(await consumeInvite(tx, "BUKU42", NOW)).toBeNull();
      expect(await findUsableInvite(tx, "BUKU42", NOW)).toBeNull();
    });
  });

  it("refuses expired and unknown codes", async () => {
    await withAppRole(db, async (tx) => {
      expect(await findUsableInvite(tx, "LAMA01", NOW)).toBeNull();
      expect(await consumeInvite(tx, "LAMA01", NOW)).toBeNull();
      expect(await findUsableInvite(tx, "NOPE99", NOW)).toBeNull();
    });
  });

  it("lets only staff create codes", async () => {
    await expectPgError(
      withAppRole(db, (tx) => tx.insert(pilotInvites).values({ code: "HACK01", cohort: "x", maxUses: 1000, createdBy: "me" })),
      /permission denied/,
    );
  });
});
