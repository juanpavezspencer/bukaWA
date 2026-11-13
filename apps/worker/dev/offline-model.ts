/**
 * DEV ONLY. A crude keyword stand-in for the LLM so the chat simulator works
 * without Anthropic credentials. It is NOT the product's extractor, is never
 * used in production or evals, and handles only simple messages.
 */
import type { StructuredModel, StructuredRequest, StructuredResult } from "@bukuwa/ai";
import { ROUTER_SYSTEM } from "@bukuwa/ai";

const AMOUNT = /(\d+(?:[.,]\d+)*\s*(?:rb|ribu|rebu|k|jt|juta)?|ceban|goceng|gopek|seceng|seribu|sejuta)\b/i;
const DATE = /\b(hari ini|tadi|kemarin|kemaren|kmrn|senin|selasa|rabu|kamis|jumat|sabtu|minggu|\d{1,2}\/\d{1,2}|tgl \d{1,2})\b/i;

function route(text: string) {
  const t = text.toLowerCase();
  if (/\?|berapa|siapa/.test(t)) return { intent: "question" };
  if (/salah|hapus|koreksi/.test(t)) return { intent: "correction" };
  if (/^(bantuan|help|menu)$/.test(t.trim())) return { intent: "command" };
  if (AMOUNT.test(t) && /\d|ceban|goceng|gopek|seceng|sejuta|seribu/.test(t)) return { intent: "transaction" };
  return { intent: "chitchat" };
}

function extract(text: string) {
  const t = text.toLowerCase();
  const kind = /modal/.test(t) ? "owner_capital"
    : /prive|pribadi/.test(t) ? "owner_drawing"
    : /lunas|bayar utang|nyicil|cicil/.test(t) ? "settlement"
    : /\b(utang|ngutang|belum bayar|bon)\b/.test(t) && /\bke\b/.test(t) ? "payable"
    : /\b(utang|ngutang|belum bayar|bon)\b/.test(t) ? "receivable"
    : /jual|terima|dapat|laku|order|pesanan/.test(t) ? "sale"
    : "expense";
  const times = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)*\s*(?:rb|ribu|k|jt)?)/i.exec(text);
  const amount = times ? null : AMOUNT.exec(text.replace(DATE, ""))?.[1]?.trim() ?? null;
  const description = text.replace(/\d+\s*[x×]\s*\S+/i, "").replace(AMOUNT, "").replace(/\b(cash|tunai|tf|transfer|via|pakai|pake)\b.*$/i, "").trim().slice(0, 40) || "Transaksi";
  return {
    entries: [
      {
        kind,
        description: description.charAt(0).toUpperCase() + description.slice(1),
        amount_text: amount,
        items: times ? [{ name: description.replace(/^(jual|beli|belanja)\s+/i, ""), qty_text: times[1]!, unit: null, unit_price_text: times[2]!.trim(), line_total_text: null }] : [],
        date_text: DATE.exec(text)?.[1] ?? null,
        // "Bu Sari utang 350rb", "bon beras ke Toko Jaya 800rb": an honorific + name, or "ke <Name>".
        counterparty: /\b(?:bu|pak|mbak|mas|ibu|bapak)\s+[a-z]+/i.exec(text)?.[0] ?? /\bke\s+((?:toko|warung|agen)\s+[a-z]+)/i.exec(text)?.[1] ?? null,
        payment_text: /\b(cash|tunai|tf|transfer|qris|gopay|ovo|dana)\b/i.exec(text)?.[1] ?? null,
        suggested_category: kind === "sale" || kind === "receivable" ? "Penjualan" : null,
        confidence: { kind: 0.6, amount: 0.9, date: 0.9, counterparty: 0.9, payment_method: 0.9 },
      },
    ],
    needs_clarification: [],
  };
}

export const offlineModel: StructuredModel = {
  async generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const text = /<message>\n([\s\S]*)\n<\/message>/.exec(req.user)?.[1] ?? "";
    const output = req.system === ROUTER_SYSTEM ? route(text) : extract(text);
    return { output: req.schema.parse(output), model: "offline-dev" };
  },
};
