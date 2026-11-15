import { sql } from "drizzle-orm";
import { rows, withAppRole, type Db, type Tx } from "./client.js";

/** Businesses whose erasure grace period has passed. Same pattern as dueSummaryBusinesses. */
export async function dueErasures(db: Db, now: Date, limit = 20): Promise<string[]> {
  return withAppRole(db, async (tx) => {
    await tx.execute(sql`select set_config('app.erasure_scan', 'on', true)`);
    const r = await tx.execute(
      sql`select business_id from erasure_requests where cancelled_at is null and scheduled_for <= ${now.toISOString()}::timestamptz order by scheduled_for limit ${limit}`,
    );
    return rows<{ business_id: string }>(r).map((x) => x.business_id);
  });
}

/**
 * Delete every row of a business through erase_business(). The function
 * refuses unless a due, uncancelled request exists. Returns rows deleted per table.
 */
export async function eraseBusiness(db: Db, businessId: string, ownerPhone: string, now: Date): Promise<Record<string, number>> {
  return withAppRole(db, async (tx) => {
    const r = await tx.execute(sql`select erase_business(${businessId}::uuid, ${ownerPhone}, ${now.toISOString()}::timestamptz) as counts`);
    const counts = rows<{ counts: Record<string, string | number> }>(r)[0]!.counts;
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)]));
  });
}

export interface InviteCheck {
  code: string;
  cohort: string;
}

/**
 * Pick the invite code out of what the owner typed ("Halo, mau daftar. KODE
 * buku-42" -> "BUKU42"): the word after "kode", else a word with a digit in
 * it, else the message itself if it is a single word.
 */
export function normalizeInviteCode(text: string): string | null {
  const clean = (w: string) => w.replace(/-/g, "");
  const ok = (w: string | undefined) => (w && /^[A-Z0-9]{4,12}$/.test(clean(w)) ? clean(w) : null);
  const upper = text.toUpperCase();
  const after = /\b(?:KODE|CODE|UNDANGAN|INVITE)\b[\s:]*([A-Z0-9-]+)/.exec(upper);
  if (after) return ok(after[1]);
  const words = upper.match(/[A-Z0-9-]+/g) ?? [];
  const withDigit = words.find((w) => /\d/.test(w) && /[A-Z]/.test(w) && ok(w));
  if (withDigit) return ok(withDigit);
  return words.length === 1 ? ok(words[0]) : null;
}

/** A code that exists, is not expired and has uses left. */
export async function findUsableInvite(tx: Tx, code: string, now: Date): Promise<InviteCheck | null> {
  const r = await tx.execute(
    sql`select code, cohort from pilot_invites where code = ${code} and uses < max_uses and (expires_at is null or expires_at > ${now.toISOString()}::timestamptz)`,
  );
  return rows<InviteCheck>(r)[0] ?? null;
}

/** Count one use. False if the code ran out or expired in the meantime (the check constraint also guards it). */
export async function consumeInvite(tx: Tx, code: string, now: Date): Promise<InviteCheck | null> {
  const r = await tx.execute(
    sql`update pilot_invites set uses = uses + 1 where code = ${code} and uses < max_uses and (expires_at is null or expires_at > ${now.toISOString()}::timestamptz) returning code, cohort`,
  );
  return rows<InviteCheck>(r)[0] ?? null;
}
