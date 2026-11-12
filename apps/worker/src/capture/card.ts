import { formatRupiah } from "@bukuwa/idn";
import type { FieldName } from "@bukuwa/ai";
import type { OutboundMessage } from "@bukuwa/wa";

/** What the card needs per entry; amounts already computed by code. */
export interface CardEntry {
  kind: string;
  description: string;
  amountIdr: bigint;
  date: string;
  counterparty: string | null;
  /** Null for debts on credit (no money moved yet). */
  paymentMethod: string | null;
  /** Settlement: which debt is paid. */
  settles?: "receivable" | "payable" | null;
  categoryName: string | null;
  /** Extra lines, e.g. the contact's balance after this entry. */
  notes?: string[];
  items: Array<{
    name: string;
    qtyText: string | null;
    unit: string | null;
    unitPriceIdr: bigint | null;
    lineTotalIdr: bigint | null;
    /** Set when items post to different categories. */
    categoryName?: string | null;
  }>;
  lowConfidence: FieldName[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m! - 1]}`;
}

export function paymentLabel(pm: string): string {
  if (pm === "cash") return "cash";
  if (pm === "qris") return "QRIS";
  if (pm === "bank:other") return "transfer";
  if (pm.startsWith("bank:")) return `transfer ${pm.slice(5)}`;
  if (pm === "ewallet:other") return "e-wallet";
  if (pm.startsWith("ewallet:")) return pm.slice(8);
  return pm;
}

const FIELD_LABEL: Record<FieldName, string> = {
  kind: "jenis transaksi",
  amount: "nominal",
  date: "tanggal",
  counterparty: "nama pelanggan/supplier",
  payment_method: "cara bayar",
};

function headline(e: CardEntry): string {
  const amt = formatRupiah(e.amountIdr);
  const who = e.counterparty ? (e.kind === "sale" ? ` dari ${e.counterparty}` : ` ke ${e.counterparty}`) : "";
  const tail = e.paymentMethod ? ` (${paymentLabel(e.paymentMethod)}), ${shortDate(e.date)}` : `, ${shortDate(e.date)}`;
  const name = e.counterparty ?? "";
  switch (e.kind) {
    case "sale":
      return `Pemasukan ${amt}${who}${tail}`;
    case "expense":
      return `Pengeluaran ${amt}${who}${tail}`;
    case "owner_capital":
      return `Tambah modal ${amt}${tail}`;
    case "owner_drawing":
      return `Ambil uang pribadi (prive) ${amt}${tail}`;
    case "receivable":
      return `Piutang ${amt}: ${name} belum bayar${tail}`;
    case "payable":
      return `Utang ${amt} ke ${name}, belum dibayar${tail}`;
    case "settlement":
      return e.settles === "payable" ? `Bayar utang ${amt} ke ${name}${tail}` : `Pelunasan piutang ${amt} dari ${name}${tail}`;
    default:
      return `${e.description} ${amt}${tail}`;
  }
}

function entryBlock(e: CardEntry): string {
  const lines = [headline(e)];
  const showItems = e.items.length > 1 || e.items.some((i) => i.qtyText);
  if (showItems) {
    for (const i of e.items) {
      const total = i.lineTotalIdr !== null ? formatRupiah(i.lineTotalIdr) : "";
      const cat = i.categoryName ? ` (${i.categoryName})` : "";
      if (i.qtyText && i.unitPriceIdr !== null) {
        // "• nasi box 25 x Rp 18.000 = Rp 450.000"
        const unit = i.unit ? ` ${i.unit}` : "";
        lines.push(`• ${i.name} ${i.qtyText}${unit} x ${formatRupiah(i.unitPriceIdr)} = ${total}${cat}`);
      } else {
        // "• ayam 5 kilo Rp 175.000"
        const qty = i.qtyText ? ` ${i.qtyText}${i.unit ? ` ${i.unit}` : ""}` : "";
        lines.push(`• ${i.name}${qty}${total ? ` ${total}` : ""}${cat}`);
      }
    }
  }
  const split = e.items.some((i) => i.categoryName);
  if (e.categoryName && !split) lines.push(`Kategori: ${e.categoryName}`);
  lines.push(...(e.notes ?? []));
  return lines.join("\n");
}

export function captureCard(captureId: string, entries: CardEntry[], notes: string[] = []): OutboundMessage {
  const blocks = entries.length === 1 ? [entryBlock(entries[0]!)] : entries.map((e, i) => `${i + 1}. ${entryBlock(e)}`);
  const unsure = [...new Set(entries.flatMap((e) => e.lowConfidence))].map((f) => FIELD_LABEL[f]);
  const parts = [blocks.join("\n\n")];
  if (unsure.length) parts.push(`⚠️ Aku kurang yakin soal ${unsure.join(", ")}. Cek dulu ya.`);
  parts.push(...notes);
  parts.push("Sudah benar?");
  return {
    kind: "buttons",
    body: parts.join("\n\n"),
    buttons: [
      { id: `cap:ok:${captureId}`, title: "OK" },
      { id: `cap:edit:${captureId}`, title: "Ubah" },
      { id: `cap:cancel:${captureId}`, title: "Batal" },
    ],
  };
}

/**
 * A sale (or expense) from a contact who still owes (or is owed): Flow A step 5.
 * "Ya, pelunasan" records it as the debt's payment; "Bukan" as a new sale.
 */
export function settleOfferCard(
  captureId: string,
  e: CardEntry,
  offer: { settles: "receivable" | "payable"; balanceIdr: string; since: string | null; name: string },
): OutboundMessage {
  const since = offer.since ? ` sejak ${shortDate(offer.since)}` : "";
  const debt =
    offer.settles === "receivable"
      ? `${offer.name} masih punya utang ${formatRupiah(BigInt(offer.balanceIdr))}${since}. Ini pelunasan utang ${offer.name}?`
      : `Kamu masih ada utang ${formatRupiah(BigInt(offer.balanceIdr))} ke ${offer.name}${since}. Ini bayar utang ke ${offer.name}?`;
  return {
    kind: "buttons",
    body: `${entryBlock(e)}\n\n${debt}`,
    buttons: [
      { id: `cap:settle:${captureId}`, title: "Ya, pelunasan" },
      { id: `cap:ok:${captureId}`, title: e.kind === "expense" ? "Bukan, belanja baru" : "Bukan, jualan baru" },
      { id: `cap:cancel:${captureId}`, title: "Batal" },
    ],
  };
}

export function askCounterparty(kind: string, amount: string): OutboundMessage {
  const q =
    kind === "receivable" ? `Siapa yang belum bayar ${amount}?`
    : kind === "payable" ? `Utang ${amount} ini ke siapa?`
    : `Pembayaran ${amount} ini dari/ke siapa?`;
  return { kind: "text", body: `${q} Tulis namanya aja ya, contoh: Bu Sari.` };
}

export function askSettles(captureId: string, name: string, amount: string): OutboundMessage {
  return {
    kind: "buttons",
    body: `Pembayaran ${amount} dengan ${name}: siapa yang bayar?`,
    buttons: [
      { id: `cap:side:${captureId}:r`, title: `Dia bayar ke aku` },
      { id: `cap:side:${captureId}:p`, title: `Aku bayar ke dia` },
    ],
  };
}

export function askAmount(): OutboundMessage {
  return { kind: "text", body: "Nominalnya berapa? Tulis angkanya aja ya, contoh: 450rb atau 1,5jt." };
}

export const PAYMENT_CHOICES = [
  { id: "cash", title: "Cash", method: "cash" },
  { id: "bank", title: "Transfer bank", method: "bank:other" },
  { id: "qris", title: "QRIS", method: "qris" },
  { id: "ewallet", title: "E-wallet", method: "ewallet:other" },
] as const;

export function askPayment(captureId: string, summary: string): OutboundMessage {
  return {
    kind: "list",
    body: `${summary}\n\nDibayar pakai apa?`,
    buttonText: "Pilih cara bayar",
    rows: PAYMENT_CHOICES.map((c) => ({ id: `cap:pay:${captureId}:${c.id}`, title: c.title })),
  };
}

export type CaptureAction =
  | { action: "ok" | "edit" | "cancel" | "settle"; captureId: string }
  | { action: "pay"; captureId: string; method: string }
  | { action: "side"; captureId: string; settles: "receivable" | "payable" };

export function parseCaptureReply(replyId: string | undefined): CaptureAction | null {
  if (!replyId?.startsWith("cap:")) return null;
  const [, action, captureId, choice] = replyId.split(":");
  if (!captureId || !/^[0-9a-f-]{36}$/i.test(captureId)) return null;
  if (action === "ok" || action === "edit" || action === "cancel" || action === "settle") return { action, captureId };
  if (action === "side" && (choice === "r" || choice === "p")) {
    return { action, captureId, settles: choice === "r" ? "receivable" : "payable" };
  }
  if (action === "pay") {
    const c = PAYMENT_CHOICES.find((p) => p.id === choice);
    return c ? { action: "pay", captureId, method: c.method } : null;
  }
  return null;
}
