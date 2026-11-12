import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";
import { businesses } from "./schema.js";
import { pgError, withBusiness, type Db } from "./client.js";
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
