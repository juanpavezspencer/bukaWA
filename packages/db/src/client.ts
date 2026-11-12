import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema.js";

export type Schema = typeof schema;
/** Any Drizzle Postgres database (node-postgres in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export const APP_ROLE = "bukuwa_app";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction scoped to one business. Every business-scoped
 * query must go through here: it drops to the non-privileged app role (so RLS
 * applies even if the connection user owns the tables) and sets the tenant
 * GUC that the RLS policies read. Both settings are transaction-local.
 */
export async function withBusiness<T>(
  db: Db,
  businessId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(businessId)) throw new Error(`invalid business id: ${businessId}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    await setBusinessScope(tx, businessId);
    return fn(tx);
  });
}

/**
 * Select the tenant inside a transaction opened with withAppRole(), for flows
 * that only learn the business mid-transaction (inbound message routing,
 * onboarding). Transaction-local.
 */
export async function setBusinessScope(tx: Tx, businessId: string): Promise<void> {
  if (!UUID_RE.test(businessId)) throw new Error(`invalid business id: ${businessId}`);
  await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
}

/** Find the business a sender belongs to via the phone_lookup RLS policy. */
export async function findUserByPhoneHash(
  tx: Tx,
  phoneHash: string,
): Promise<{ userId: string; businessId: string } | undefined> {
  await tx.execute(sql`select set_config('app.phone_hash', ${phoneHash}, true)`);
  const [row] = rows<{ id: string; business_id: string }>(
    await tx.execute(sql`select id, business_id from users where phone_hash = ${phoneHash}`),
  );
  return row ? { userId: row.id, businessId: row.business_id } : undefined;
}

/**
 * Run `fn` as the app role with no tenant selected. Tenant tables return no
 * rows here; use it only for non-tenant tables such as wa_inbound.
 */
export async function withAppRole<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx);
  });
}

export interface PgErrorInfo {
  code?: string;
  message: string;
  constraint?: string;
}

/** Unwrap the underlying Postgres error (Drizzle wraps driver errors in `cause`). */
export function pgError(err: unknown): PgErrorInfo | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const e = cur as { code?: unknown; message?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      return {
        code: e.code,
        message: String(e.message),
        constraint: typeof e.constraint === "string" ? e.constraint : undefined,
      };
    }
    cur = e.cause;
  }
  return undefined;
}

/** Rows from a raw `execute()` result (node-postgres and PGlite both return `{ rows }`). */
export function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}
