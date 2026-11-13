import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { setBusinessScope, withAppRole, type Db, type Tx } from "./client.js";
import { adminLoginTokens, adminSessions, auditLog, dashboardSessions, loginTokens } from "./schema.js";

/*
 * Dashboard and admin login (milestone 7). Magic-link tokens and session
 * cookies are 256-bit random values; only their SHA-256 is stored, so a
 * database leak doesn't hand out sessions. Tokens are single-use.
 */

export const ADMIN_ROLE = "bukuwa_admin";

const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A one-time magic link token for a business user. Runs in that business's scope. */
export async function createLoginToken(tx: Tx, a: { businessId: string; userId: string; now: Date; ttlMs: number }): Promise<string> {
  const token = newToken();
  await tx.insert(loginTokens).values({
    businessId: a.businessId,
    userId: a.userId,
    tokenHash: tokenHash(token),
    expiresAt: new Date(a.now.getTime() + a.ttlMs),
  });
  return token;
}

export interface NewSession {
  sessionToken: string;
  businessId: string;
  userId: string;
  expiresAt: Date;
}

/** Spend a magic link: one session per token, audited as a login. Null if unknown, used or expired. */
export async function exchangeLoginToken(db: Db, token: string, now: Date, sessionTtlMs: number): Promise<NewSession | null> {
  const hash = tokenHash(token);
  return withAppRole(db, async (tx) => {
    await tx.execute(sql`select set_config('app.login_token_hash', ${hash}, true)`);
    const [t] = await tx.select().from(loginTokens).where(eq(loginTokens.tokenHash, hash));
    if (!t || t.usedAt || t.expiresAt <= now) return null;
    await setBusinessScope(tx, t.businessId);
    // Conditional update: two concurrent clicks can't both get a session.
    const spent = await tx
      .update(loginTokens)
      .set({ usedAt: now })
      .where(and(eq(loginTokens.id, t.id), isNull(loginTokens.usedAt)))
      .returning({ id: loginTokens.id });
    if (!spent.length) return null;
    const sessionToken = newToken();
    const expiresAt = new Date(now.getTime() + sessionTtlMs);
    const [s] = await tx
      .insert(dashboardSessions)
      .values({ businessId: t.businessId, userId: t.userId, sessionHash: tokenHash(sessionToken), expiresAt })
      .returning({ id: dashboardSessions.id });
    await tx.insert(auditLog).values({ businessId: t.businessId, actor: t.userId, action: "login", entity: "dashboard_session", entityId: s!.id, after: { channel: "magic_link" } });
    return { sessionToken, businessId: t.businessId, userId: t.userId, expiresAt };
  });
}

async function findSession(tx: Tx, sessionToken: string) {
  const hash = tokenHash(sessionToken);
  await tx.execute(sql`select set_config('app.session_hash', ${hash}, true)`);
  const [s] = await tx.select().from(dashboardSessions).where(eq(dashboardSessions.sessionHash, hash));
  return s;
}

export async function resolveSession(db: Db, sessionToken: string, now: Date): Promise<{ businessId: string; userId: string } | null> {
  return withAppRole(db, async (tx) => {
    const s = await findSession(tx, sessionToken);
    if (!s || s.revokedAt || s.expiresAt <= now) return null;
    return { businessId: s.businessId, userId: s.userId };
  });
}

export async function revokeSession(db: Db, sessionToken: string, now: Date): Promise<void> {
  await withAppRole(db, async (tx) => {
    const s = await findSession(tx, sessionToken);
    if (!s || s.revokedAt) return;
    await setBusinessScope(tx, s.businessId);
    await tx.update(dashboardSessions).set({ revokedAt: now }).where(eq(dashboardSessions.id, s.id));
    await tx.insert(auditLog).values({ businessId: s.businessId, actor: s.userId, action: "logout", entity: "dashboard_session", entityId: s.id });
  });
}

/** Staff magic link for an allowlisted phone (the caller checks the allowlist). */
export async function createAdminLoginToken(tx: Tx, a: { phoneHash: string; now: Date; ttlMs: number }): Promise<string> {
  const token = newToken();
  await tx.insert(adminLoginTokens).values({ tokenHash: tokenHash(token), phoneHash: a.phoneHash, expiresAt: new Date(a.now.getTime() + a.ttlMs) });
  return token;
}

export async function exchangeAdminLoginToken(db: Db, token: string, now: Date, sessionTtlMs: number): Promise<{ sessionToken: string; phoneHash: string; expiresAt: Date } | null> {
  return withAppRole(db, async (tx) => {
    const [t] = await tx
      .update(adminLoginTokens)
      .set({ usedAt: now })
      .where(and(eq(adminLoginTokens.tokenHash, tokenHash(token)), isNull(adminLoginTokens.usedAt), gt(adminLoginTokens.expiresAt, now)))
      .returning({ phoneHash: adminLoginTokens.phoneHash });
    if (!t) return null;
    const sessionToken = newToken();
    const expiresAt = new Date(now.getTime() + sessionTtlMs);
    await tx.insert(adminSessions).values({ sessionHash: tokenHash(sessionToken), phoneHash: t.phoneHash, expiresAt });
    return { sessionToken, phoneHash: t.phoneHash, expiresAt };
  });
}

export async function resolveAdminSession(db: Db, sessionToken: string, now: Date): Promise<{ phoneHash: string } | null> {
  return withAppRole(db, async (tx) => {
    const [s] = await tx.select().from(adminSessions).where(eq(adminSessions.sessionHash, tokenHash(sessionToken)));
    if (!s || s.revokedAt || s.expiresAt <= now) return null;
    return { phoneHash: s.phoneHash };
  });
}

export async function revokeAdminSession(db: Db, sessionToken: string, now: Date): Promise<void> {
  await withAppRole(db, (tx) => tx.update(adminSessions).set({ revokedAt: now }).where(eq(adminSessions.sessionHash, tokenHash(sessionToken))));
}

/**
 * Run `fn` as the admin console role: read-only across businesses through the
 * admin_read policies, plus inserting reviews and audit rows. Call only after
 * resolveAdminSession succeeded.
 */
export async function withAdmin<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${ADMIN_ROLE}`));
    return fn(tx);
  });
}
