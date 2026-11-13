import { sql } from "drizzle-orm";
import { rows, type Tx } from "@bukuwa/db";
import { LedgerError } from "./errors.js";

/** Reads must run in the same business scope (RLS) they ask about. */
export async function assertScope(tx: Tx, businessId: string): Promise<void> {
  const r = await tx.execute(sql`select app_current_business_id()::text as id`);
  if (rows<{ id: string | null }>(r)[0]?.id !== businessId) {
    throw new LedgerError("BUSINESS_MISMATCH", "query business does not match the transaction's business scope");
  }
}
