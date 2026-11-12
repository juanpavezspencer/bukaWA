import { multiplyQty, parseIdDate, parsePaymentMethod, parseQty, parseRupiah } from "@bukuwa/idn";
import { CATEGORY_NAMES, type RawEntry, type RawExtraction } from "./extractor.js";

/*
 * Normalizer: turns the model's copied spans into numbers with deterministic
 * code. Every amount in a confirm card or journal comes from here.
 */

export type EntryKind = RawEntry["kind"];
export type FieldName = "kind" | "amount" | "date" | "counterparty" | "payment_method";

export interface NormalizedItem {
  name: string;
  qtyText: string | null;
  unit: string | null;
  /** Price per unit when the message gave one (qty x price). */
  unitPriceIdr: bigint | null;
  lineTotalIdr: bigint | null;
}

export interface NormalizedEntry {
  kind: EntryKind;
  description: string;
  amountIdr: bigint | null;
  date: string;
  counterparty: string | null;
  paymentMethod: string | null;
  items: NormalizedItem[];
  suggestedCategory: (typeof CATEGORY_NAMES)[number] | null;
  /** Fields the owner should double-check on the card. */
  lowConfidence: FieldName[];
  /** Fields that must be answered before the entry can be posted. */
  missing: Array<"amount" | "payment_method">;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

/** A copied span must actually appear in the message; otherwise it was invented. */
function inMessage(span: string, message: string): boolean {
  return squash(message).includes(squash(span));
}

function itemTotal(item: RawEntry["items"][number], message: string): bigint | null {
  if (item.line_total_text && inMessage(item.line_total_text, message)) {
    const v = parseRupiah(item.line_total_text);
    if (v !== null) return v;
  }
  if (!item.unit_price_text || !inMessage(item.unit_price_text, message)) return null;
  const unit = parseRupiah(item.unit_price_text);
  if (unit === null) return null;
  if (!item.qty_text) return unit;
  const qty = parseQty(item.qty_text);
  return qty ? multiplyQty(qty, unit) : null;
}

export function normalizeEntry(raw: RawEntry, message: string, today: string, threshold: number): NormalizedEntry {
  const low = new Set<FieldName>();
  for (const [field, c] of Object.entries(raw.confidence) as Array<[FieldName, number]>) {
    if (c < threshold) low.add(field);
  }

  const items: NormalizedItem[] = raw.items.map((it) => ({
    name: it.name,
    qtyText: it.qty_text,
    unit: it.unit,
    unitPriceIdr:
      !it.line_total_text && it.unit_price_text && inMessage(it.unit_price_text, message) ? parseRupiah(it.unit_price_text) : null,
    lineTotalIdr: itemTotal(it, message),
  }));
  const itemsSum =
    items.length > 0 && items.every((i) => i.lineTotalIdr !== null)
      ? items.reduce((s, i) => s + i.lineTotalIdr!, 0n)
      : null;

  let stated: bigint | null = null;
  if (raw.amount_text) {
    if (inMessage(raw.amount_text, message)) stated = parseRupiah(raw.amount_text);
    if (stated === null) low.add("amount");
  }
  const amountIdr = stated ?? itemsSum;
  if (stated !== null && itemsSum !== null && stated !== itemsSum) low.add("amount");

  let date = today;
  if (raw.date_text) {
    const parsed = parseIdDate(raw.date_text, today);
    if (parsed) date = parsed;
    else low.add("date");
  }

  const paymentMethod =
    (raw.payment_text ? parsePaymentMethod(raw.payment_text) : null) ?? parsePaymentMethod(message);

  const missing: NormalizedEntry["missing"] = [];
  if (amountIdr === null || amountIdr <= 0n) missing.push("amount");
  // Debts on credit move no money yet, so they need no payment method.
  if (paymentMethod === null && raw.kind !== "receivable" && raw.kind !== "payable") missing.push("payment_method");

  return {
    kind: raw.kind,
    description: raw.description.trim() || message.slice(0, 60),
    amountIdr: amountIdr !== null && amountIdr > 0n ? amountIdr : null,
    date,
    counterparty: raw.counterparty?.trim() || null,
    paymentMethod,
    items,
    suggestedCategory: raw.suggested_category,
    lowConfidence: [...low].filter((f) => !(f === "amount" && missing.includes("amount"))),
    missing,
  };
}

export function normalizeExtraction(raw: RawExtraction, message: string, today: string, threshold: number): NormalizedEntry[] {
  return raw.entries.map((e) => normalizeEntry(e, message, today, threshold));
}
