import { randomUUID } from "node:crypto";
import {
  auditLog,
  businesses,
  encryptPii,
  seedChartOfAccounts,
  setBusinessScope,
  users,
  type PiiKeys,
  type Tx,
} from "@bukuwa/db";
import { postJournal } from "@bukuwa/ledger";
import type { BusinessType } from "./onboarding.js";

export interface NewBusiness {
  phoneE164: string;
  phoneHash: string;
  name: string;
  type: BusinessType;
  openingCash: bigint;
  consentAt: Date;
  consentVersion: string;
  trialDays: number;
  timezone: string;
  now: Date;
}

/** Calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * Create a business from a confirmed onboarding: profile, owner with consent,
 * chart of accounts, and the opening cash journal (Kas / Modal pemilik), which
 * the owner confirmed on the summary card. Runs inside the caller's
 * transaction and leaves it scoped to the new business.
 */
export async function createBusinessFromOnboarding(
  tx: Tx,
  keys: PiiKeys,
  b: NewBusiness,
): Promise<{ businessId: string; userId: string }> {
  const businessId = randomUUID();
  const userId = randomUUID();
  await setBusinessScope(tx, businessId);

  await tx.insert(businesses).values({
    id: businessId,
    name: b.name,
    type: b.type,
    ownerPhoneHash: b.phoneHash,
    ownerPhoneEnc: encryptPii(keys, b.phoneE164),
    timezone: b.timezone,
    plan: "trial",
    trialEndsAt: new Date(b.now.getTime() + b.trialDays * 86_400_000),
  });
  await tx.insert(users).values({
    id: userId,
    businessId,
    phoneHash: b.phoneHash,
    phoneEnc: encryptPii(keys, b.phoneE164),
    role: "owner",
    consentAt: b.consentAt,
    consentVersion: b.consentVersion,
  });
  await seedChartOfAccounts(tx, businessId);

  await tx.insert(auditLog).values([
    {
      businessId,
      actor: userId,
      action: "consent.given",
      entity: "user",
      entityId: userId,
      after: { consentAt: b.consentAt.toISOString(), consentVersion: b.consentVersion, channel: "whatsapp" },
    },
    {
      businessId,
      actor: userId,
      action: "business.create",
      entity: "business",
      entityId: businessId,
      after: { name: b.name, type: b.type, openingCash: b.openingCash.toString() },
    },
  ]);

  if (b.openingCash > 0n) {
    await postJournal(tx, {
      businessId,
      date: localDate(b.now, b.timezone),
      description: "Saldo awal kas",
      source: "text",
      lines: [
        { accountCode: "1100", debit: b.openingCash },
        { accountCode: "3100", credit: b.openingCash },
      ],
      idempotencyKey: "opening-balance",
      createdBy: userId,
    });
  }
  return { businessId, userId };
}
