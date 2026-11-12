import { z } from "zod/v4";
import { maskSensitiveIds } from "@bukuwa/idn";
import type { AiConfig } from "./config.js";
import type { StructuredModel } from "./model.js";

/*
 * The extractor copies spans out of the message; it never converts or adds
 * amounts. "25 x 18rb" comes back as qty_text "25" + unit_price_text "18rb",
 * and code (normalize.ts) does the arithmetic.
 */

export const ENTRY_KINDS = [
  "sale",
  "expense",
  "transfer_in",
  "transfer_out",
  "receivable",
  "payable",
  "settlement",
  "owner_drawing",
  "owner_capital",
] as const;

/** Category names from the default chart of accounts (packages/db). */
export const CATEGORY_NAMES = [
  "Penjualan",
  "Diskon penjualan",
  "Persediaan",
  "HPP / Bahan baku",
  "Gaji",
  "Sewa",
  "Listrik & air",
  "Transport & ongkir",
  "Iklan & marketing",
  "Biaya admin bank & marketplace",
  "Beban pajak",
  "Lain-lain",
] as const;

const Confidence = z.object({
  kind: z.number(),
  amount: z.number(),
  date: z.number(),
  counterparty: z.number(),
  payment_method: z.number(),
});

const Item = z.object({
  name: z.string(),
  qty_text: z.string().nullable(),
  unit: z.string().nullable(),
  unit_price_text: z.string().nullable(),
  line_total_text: z.string().nullable(),
});

export const Entry = z.object({
  kind: z.enum(ENTRY_KINDS),
  description: z.string(),
  amount_text: z.string().nullable(),
  items: z.array(Item),
  date_text: z.string().nullable(),
  counterparty: z.string().nullable(),
  payment_text: z.string().nullable(),
  suggested_category: z.enum(CATEGORY_NAMES).nullable(),
  confidence: Confidence,
});

export const ExtractorOutput = z.object({
  entries: z.array(Entry),
  needs_clarification: z.array(z.string()),
});
export type RawExtraction = z.infer<typeof ExtractorOutput>;
export type RawEntry = z.infer<typeof Entry>;

export const EXTRACTOR_PROMPT_VERSION = "extractor-v1";

export const EXTRACTOR_SYSTEM = `You extract bookkeeping entries from WhatsApp messages written by Indonesian small-business owners (home food sellers, fashion resellers, small shops). Messages are casual Bahasa Indonesia with slang and typos.

Your job is to COPY text spans out of the message. Never convert, compute, add up or reformat amounts, quantities or dates - code does that. Copy them exactly as written ("18rb", "1,5jt", "ceban", "175 ribu", "kemarin", "12/11").

For each money movement in the message, return one entry:
- kind:
  - sale: the owner sold something / received payment for goods or services.
  - expense: the owner paid for something for the business (ingredients, stock, salary, rent, electricity, shipping, ads, fees).
  - owner_capital: the owner put personal money into the business ("modal", "nambah modal").
  - owner_drawing: the owner took business money for personal use ("ambil buat pribadi", "prive", "buat jajan anak").
  - receivable: someone owes the owner ("Bu Sari utang 350rb", "belum bayar").
  - payable: the owner owes someone ("ngutang ke supplier", "bon dulu").
  - settlement: a debt was paid ("Bu Sari udah lunas", "bayar utang ke supplier").
  - transfer_in / transfer_out: money moved between the owner's own accounts (e.g. tarik tunai, setor ke bank).
- description: a short Bahasa Indonesia label of what it was, without the amount (e.g. "Jual nasi box", "Belanja ayam").
- amount_text: the total amount exactly as written, or null if the message only gives per-item prices or quantities x prices.
- items: one per item mentioned. qty_text = quantity as written ("25", "2", "setengah") or null; unit = unit as written ("kilo", "liter", "pcs") or null; unit_price_text = price per unit as written or null; line_total_text = the amount written for that item as a whole or null. "25 x 18rb" means qty_text "25", unit_price_text "18rb". "ayam 5 kilo 175 ribu" means qty_text "5", unit "kilo", line_total_text "175 ribu". Return an empty list if no items are named.
- date_text: the date words as written ("kemarin", "Senin", "12/11", "tgl 3"), or null if no date is mentioned.
- counterparty: the customer, supplier or person named, or null.
- payment_text: the payment words as written ("transfer BCA", "cash", "tf", "gopay", "qris"), or null if not mentioned.
- suggested_category: the best category from the list, or null if unsure. Sales are usually "Penjualan". Ingredients and goods for resale are "HPP / Bahan baku".
- confidence: 0 to 1 for each field; use low values when you are guessing.

Split a message into several entries only when it describes separate money movements. Several items bought in one shopping trip and paid together are ONE expense entry with several items.

needs_clarification: names of fields the owner should be asked about (e.g. "amount", "payment_method"), or an empty list.`;

export async function extractTransaction(
  model: StructuredModel,
  cfg: AiConfig,
  input: { text: string; today: string },
): Promise<{ extraction: RawExtraction; modelVersion: string }> {
  const r = await model.generate({
    model: cfg.extractorModel,
    effort: cfg.extractorEffort,
    system: EXTRACTOR_SYSTEM,
    user: `Today is ${input.today}.\n<message>\n${maskSensitiveIds(input.text)}\n</message>`,
    schema: ExtractorOutput,
    maxTokens: 8192,
  });
  return { extraction: r.output, modelVersion: `${r.model}/${EXTRACTOR_PROMPT_VERSION}` };
}
