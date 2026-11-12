import { contacts, type Tx } from "@bukuwa/db";
import { formatRupiah, similarContact } from "@bukuwa/idn";
import { findContact, openBalances, type ContactKind, type OpenItemKind } from "@bukuwa/ledger";

/*
 * Receivables and payables in the capture flow (F8). Everything here reads
 * the ledger; amounts are computed by code, never by the model.
 *
 *   receivable / payable  need a contact name, no payment method
 *   settlement            needs a contact and which debt it pays; if the
 *                         owner gave no amount, the open balance is used
 *   sale / expense        from a contact with an open debt: offer to record
 *                         it as that debt's payment instead (Flow A step 5)
 */

export const DEBT_KINDS = new Set(["receivable", "payable", "settlement"]);

export type Missing = "amount" | "payment_method" | "counterparty" | "settles";

/** The fields of a stored entry this module reads and writes. */
export interface DebtFields {
  kind: string;
  amountIdr: string | null;
  counterparty: string | null;
  missing: Missing[];
  /** Settlement: which debt is being paid. */
  settles?: OpenItemKind | null;
  /** Name of the existing contact it matched, if any. */
  contactName?: string | null;
  /** The contact's open balance (of the relevant kind) before this entry. */
  openBefore?: string | null;
  /** The amount was taken from the open balance ("Bu Sari udah lunas"). */
  amountFromBalance?: boolean;
  /** Sale/expense from a contact with an open debt: could be its payment. */
  offer?: { settles: OpenItemKind; balanceIdr: string; since: string | null } | null;
}

async function findLoose(tx: Tx, name: string): Promise<{ id: string; name: string } | undefined> {
  const all = await tx.select({ id: contacts.id, name: contacts.name }).from(contacts);
  const hits = all.filter((c) => similarContact(c.name, name));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Fill in contact, debt side, balance and offer for one entry. Idempotent. */
export async function resolveDebt(tx: Tx, businessId: string, e: DebtFields): Promise<void> {
  e.missing = e.missing.filter((m) => m !== "counterparty" && m !== "settles");
  e.contactName = null;
  e.openBefore = null;
  e.offer = null;
  const isDebt = DEBT_KINDS.has(e.kind);
  if (!e.counterparty) {
    if (isDebt) e.missing.push("counterparty");
    return;
  }
  if (!isDebt && e.kind !== "sale" && e.kind !== "expense") return;

  // Posting uses exact matches only; a loose one may still find who is paying.
  const contact = (await findContact(tx, businessId, e.counterparty)) ?? (e.kind === "receivable" || e.kind === "payable" ? undefined : await findLoose(tx, e.counterparty));
  const balances = contact ? await openBalances(tx, businessId, { contactId: contact.id }) : [];
  const owed = (k: OpenItemKind) => balances.find((b) => b.kind === k && b.balanceIdr > 0n);
  if (contact) e.contactName = contact.name;

  if (e.kind === "receivable" || e.kind === "payable") {
    e.openBefore = owed(e.kind)?.balanceIdr.toString() ?? null;
    return;
  }
  if (e.kind === "settlement") {
    if (!e.settles) {
      const open = (["receivable", "payable"] as const).filter((k) => owed(k));
      if (open.length === 1) e.settles = open[0];
    }
    if (!e.settles) {
      e.missing.push("settles");
      return;
    }
    const b = balances.find((x) => x.kind === e.settles);
    e.openBefore = b ? b.balanceIdr.toString() : null;
    if ((e.amountIdr === null || e.amountFromBalance) && b && b.balanceIdr > 0n) {
      e.amountIdr = b.balanceIdr.toString();
      e.amountFromBalance = true;
      e.missing = e.missing.filter((m) => m !== "amount");
    }
    return;
  }
  const k: OpenItemKind = e.kind === "sale" ? "receivable" : "payable";
  const b = owed(k);
  if (b) e.offer = { settles: k, balanceIdr: b.balanceIdr.toString(), since: b.oldestOpenDate };
}

const who = (e: DebtFields) => e.contactName ?? e.counterparty ?? "";
/** "piutang Bu Sari" / "utang ke Toko Jaya" */
export function debtLabel(kind: OpenItemKind, name: string): string {
  return kind === "receivable" ? `piutang ${name}` : `utang ke ${name}`;
}

/** Lines under the entry on the confirm card. */
export function debtNotes(e: DebtFields): string[] {
  if (!DEBT_KINDS.has(e.kind) || e.amountIdr === null) return [];
  const amt = BigInt(e.amountIdr);
  const before = e.openBefore === null || e.openBefore === undefined ? null : BigInt(e.openBefore);
  if (e.kind === "receivable" || e.kind === "payable") {
    return before ? [`Total ${debtLabel(e.kind, who(e))} jadi ${formatRupiah(before + amt)}.`] : [];
  }
  const label = debtLabel(e.settles!, who(e));
  const notes: string[] = [];
  if (e.amountFromBalance) notes.push(`Nominal diambil dari sisa ${label}.`);
  if (before === null || before <= 0n) notes.push(`⚠️ Belum ada catatan ${label} yang belum lunas.`);
  else if (amt === before) notes.push(`${label[0]!.toUpperCase()}${label.slice(1)} jadi lunas ✅`);
  else if (amt < before) notes.push(`Sisa ${label} jadi ${formatRupiah(before - amt)}.`);
  else notes.push(`⚠️ Lebih besar dari sisa ${label} (${formatRupiah(before)}).`);
  return notes;
}

/** Who a new contact is, from the entry it first appears in. */
export function contactKindFor(kind: string, settles?: OpenItemKind | null): ContactKind {
  if (kind === "sale" || kind === "receivable" || (kind === "settlement" && settles === "receivable")) return "customer";
  if (kind === "expense" || kind === "payable" || (kind === "settlement" && settles === "payable")) return "supplier";
  return "other";
}

/** After posting: the contact's remaining balance, for the reply. */
export async function balanceAfter(tx: Tx, businessId: string, contactId: string, kind: OpenItemKind, name: string): Promise<string> {
  const [b] = await openBalances(tx, businessId, { contactId, kind });
  const label = debtLabel(kind, name);
  if (!b || b.balanceIdr === 0n) return `${label[0]!.toUpperCase()}${label.slice(1)} lunas ✅`;
  if (b.balanceIdr < 0n) return `${label[0]!.toUpperCase()}${label.slice(1)}: lebih bayar ${formatRupiah(-b.balanceIdr)}.`;
  return `Sisa ${label}: ${formatRupiah(b.balanceIdr)}.`;
}
