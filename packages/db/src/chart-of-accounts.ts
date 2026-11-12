import { accounts } from "./schema.js";
import type { Tx } from "./client.js";

export type AccountTypeName = "asset" | "liability" | "equity" | "income" | "expense";

/** Default UMKM chart of accounts (spec section 6). Codes are stable identifiers used by the posting engine. */
export const DEFAULT_CHART_OF_ACCOUNTS: ReadonlyArray<{
  code: string;
  name: string;
  type: AccountTypeName;
}> = [
  { code: "1100", name: "Kas", type: "asset" },
  { code: "1110", name: "Bank", type: "asset" },
  { code: "1120", name: "E-wallet", type: "asset" },
  { code: "1200", name: "Piutang usaha", type: "asset" },
  { code: "1300", name: "Persediaan", type: "asset" },
  { code: "2100", name: "Utang usaha", type: "liability" },
  { code: "3100", name: "Modal pemilik", type: "equity" },
  { code: "3200", name: "Prive", type: "equity" },
  { code: "4100", name: "Penjualan", type: "income" },
  { code: "4200", name: "Diskon penjualan", type: "income" },
  { code: "5100", name: "HPP / Bahan baku", type: "expense" },
  { code: "6100", name: "Gaji", type: "expense" },
  { code: "6200", name: "Sewa", type: "expense" },
  { code: "6300", name: "Listrik & air", type: "expense" },
  { code: "6400", name: "Transport & ongkir", type: "expense" },
  { code: "6500", name: "Iklan & marketing", type: "expense" },
  { code: "6600", name: "Biaya admin bank & marketplace", type: "expense" },
  { code: "6700", name: "Beban pajak", type: "expense" },
  { code: "6900", name: "Lain-lain", type: "expense" },
];

/** Idempotently seed the default chart for the business selected by withBusiness(). */
export async function seedChartOfAccounts(tx: Tx, businessId: string): Promise<void> {
  await tx
    .insert(accounts)
    .values(DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({ ...a, businessId, isSystem: true })))
    .onConflictDoNothing({ target: [accounts.businessId, accounts.code] });
}
