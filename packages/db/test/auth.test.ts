import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  adminSessions,
  auditLog,
  captureReviews,
  captures,
  createAdminLoginToken,
  createLoginToken,
  dashboardSessions,
  exchangeAdminLoginToken,
  exchangeLoginToken,
  journals,
  loginTokens,
  resolveAdminSession,
  resolveSession,
  revokeSession,
  rows,
  users,
  withAdmin,
  withAppRole,
  withBusiness,
  type Db,
} from "../src/index.js";
import { createTestBusiness, createTestDb, expectPgError } from "../src/testing.js";

let db: Db;
let bizA: string;
let bizB: string;
let userA: string;
let userB: string;
const NOW = new Date("2026-11-13T05:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const DAY = 86_400_000;

async function owner(businessId: string, tag: string) {
  return withBusiness(db, businessId, async (tx) => {
    const [u] = await tx.insert(users).values({ businessId, phoneHash: `phone-${tag}`, phoneEnc: Buffer.from("x") }).returning();
    return u!.id;
  });
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  bizA = await createTestBusiness(db, "Catering Rina");
  bizB = await createTestBusiness(db, "Toko Dimas");
  userA = await owner(bizA, "a");
  userB = await owner(bizB, "b");
});

const issue = (businessId: string, userId: string) =>
  withBusiness(db, businessId, (tx) => createLoginToken(tx, { businessId, userId, now: NOW, ttlMs: 15 * MIN }));

describe("dashboard magic links", () => {
  it("exchanges a token once for a 7-day session and audits the login", async () => {
    const token = await issue(bizA, userA);
    expect(token).toMatch(/^[\w-]{43}$/);
    const s = await exchangeLoginToken(db, token, later(MIN), 7 * DAY);
    expect(s).toMatchObject({ businessId: bizA, userId: userA, expiresAt: later(MIN + 7 * DAY) });
    expect(await exchangeLoginToken(db, token, later(2 * MIN), 7 * DAY)).toBeNull();
    const audits = await withBusiness(db, bizA, (tx) => tx.select().from(auditLog).where(sql`action = 'login'`));
    expect(audits).toHaveLength(1);
    expect(await resolveSession(db, s!.sessionToken, later(DAY))).toEqual({ businessId: bizA, userId: userA });
    expect(await resolveSession(db, s!.sessionToken, later(MIN + 7 * DAY))).toBeNull();
  });

  it("refuses an expired or unknown token", async () => {
    const token = await issue(bizA, userA);
    expect(await exchangeLoginToken(db, token, later(15 * MIN), 7 * DAY)).toBeNull();
    expect(await exchangeLoginToken(db, "not-a-token", NOW, 7 * DAY)).toBeNull();
  });

  it("stores only hashes", async () => {
    const token = await issue(bizA, userA);
    const stored = await withBusiness(db, bizA, (tx) => tx.select({ h: loginTokens.tokenHash }).from(loginTokens));
    expect(stored.map((r) => r.h)).not.toContain(token);
  });

  it("revokes a session on logout", async () => {
    const s = (await exchangeLoginToken(db, await issue(bizA, userA), NOW, 7 * DAY))!;
    await revokeSession(db, s.sessionToken, NOW);
    expect(await resolveSession(db, s.sessionToken, NOW)).toBeNull();
  });

  it("keeps each business's sessions apart", async () => {
    const sb = (await exchangeLoginToken(db, await issue(bizB, userB), NOW, 7 * DAY))!;
    expect(await resolveSession(db, sb.sessionToken, NOW)).toEqual({ businessId: bizB, userId: userB });
    const seenFromA = await withBusiness(db, bizA, (tx) => tx.select().from(dashboardSessions).where(sql`business_id = ${bizB}`));
    expect(seenFromA).toEqual([]);
    // The lookup policy reveals only the row whose hash was presented.
    const n = await withAppRole(db, async (tx) => {
      await tx.execute(sql`select set_config('app.session_hash', 'nope', true)`);
      return rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from dashboard_sessions`))[0]!.n;
    });
    expect(n).toBe(0);
  });

  it("refuses to issue a token for another business's user", async () => {
    await expectPgError(
      withBusiness(db, bizA, (tx) => createLoginToken(tx, { businessId: bizB, userId: userB, now: NOW, ttlMs: MIN })),
      /row-level security/,
    );
  });
});

describe("admin console access", () => {
  it("exchanges an admin token for a session", async () => {
    const token = await withAppRole(db, (tx) => createAdminLoginToken(tx, { phoneHash: "admin-1", now: NOW, ttlMs: 10 * MIN }));
    const s = (await exchangeAdminLoginToken(db, token, NOW, 12 * 3_600_000))!;
    expect(await resolveAdminSession(db, s.sessionToken, later(MIN))).toEqual({ phoneHash: "admin-1" });
    expect(await exchangeAdminLoginToken(db, token, NOW, DAY)).toBeNull();
    expect(await resolveAdminSession(db, s.sessionToken, later(13 * 3_600_000))).toBeNull();
    const stored = await withAppRole(db, (tx) => tx.select().from(adminSessions));
    expect(stored.map((r) => r.sessionHash)).not.toContain(s.sessionToken);
  });

  it("reads across businesses but cannot write the ledger or see owners", async () => {
    await withBusiness(db, bizA, (tx) => tx.insert(captures).values({ businessId: bizA, source: "text", rawText: "jual 1rb", status: "failed" }));
    await withBusiness(db, bizB, (tx) => tx.insert(captures).values({ businessId: bizB, source: "text", rawText: "beli 2rb", status: "failed" }));
    const seen = await withAdmin(db, (tx) => tx.select({ b: captures.businessId }).from(captures));
    expect(new Set(seen.map((r) => r.b))).toEqual(new Set([bizA, bizB]));
    await expectPgError(withAdmin(db, (tx) => tx.select().from(users)), /permission denied/);
    await expectPgError(
      withAdmin(db, (tx) => tx.insert(journals).values({ businessId: bizA, date: "2026-11-13", description: "x", source: "manual" })),
      /permission denied/,
    );
    await expectPgError(withAdmin(db, (tx) => tx.update(captures).set({ status: "confirmed" })), /permission denied/);
  });

  it("records reviews but cannot change them", async () => {
    const [c] = await withAdmin(db, (tx) => tx.select({ id: captures.id, b: captures.businessId }).from(captures).limit(1));
    await withAdmin(db, (tx) => tx.insert(captureReviews).values({ businessId: c!.b, captureId: c!.id, verdict: "wrong", wrongFields: ["amount"], reviewer: "admin-1" }));
    await expectPgError(withAdmin(db, (tx) => tx.update(captureReviews).set({ verdict: "correct" })), /permission denied/);
    const own = await withBusiness(db, c!.b, (tx) => tx.select().from(captureReviews));
    expect(own).toHaveLength(1);
  });
});
