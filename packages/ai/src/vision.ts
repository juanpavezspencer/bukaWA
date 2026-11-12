import { z } from "zod/v4";
import { maskSensitiveIds } from "@bukuwa/idn";
import type { AiConfig } from "./config.js";
import { Entry, type RawExtraction } from "./extractor.js";
import type { Attachment, StructuredModel } from "./model.js";

/*
 * Photos and PDFs: the vision model first transcribes the document, then
 * copies spans for each entry out of that transcription. Code checks every
 * span against the transcription (same hallucination guard as text) and does
 * all arithmetic.
 *
 * Privacy: pixels can't be masked before sending. The model is told to write
 * [ID] for identity and tax numbers, and the transcription is masked again in
 * code before it is stored or logged.
 */

export const DOCUMENT_TYPES = [
  "transfer_receipt",
  "qris_receipt",
  "ewallet_receipt",
  "store_receipt",
  "handwritten_nota",
  "supplier_invoice",
  "chat_screenshot",
  "other",
  "not_a_document",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const VisionOutput = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
  visible_text: z.string(),
  entries: z.array(Entry),
  needs_clarification: z.array(z.string()),
});

export const VISION_PROMPT_VERSION = "vision-v1";

export const VISION_SYSTEM = `You read photos, screenshots and PDFs that Indonesian small-business owners (home food sellers, fashion resellers, small shops) send to their bookkeeping assistant on WhatsApp: m-banking transfer receipts, QRIS and e-wallet payment receipts, store receipts (struk), handwritten nota, supplier invoices, and screenshots of chats with customers.

Step 1 - visible_text: transcribe the text you can read, line by line, exactly as printed (keep "Rp", dots, commas, dates and names as they appear). Write [ID] instead of any identity or tax number (NIK, NPWP, KTP number); never transcribe those digits. Skip decorative text and long legal footers.

Step 2 - entries: describe the money movement from the OWNER's point of view. COPY spans out of visible_text (or the owner's caption); never convert, compute, add up or reformat amounts, quantities or dates.
- kind:
  - sale: money came IN to the owner for goods or services (a customer's transfer to the owner, a QRIS payment received, the owner's own sales nota).
  - expense: the owner PAID for something for the business (a store receipt for supplies, a supplier invoice, a transfer the owner sent to a supplier).
  - The owner's business name is given. Money sent FROM that name (or the owner's own account) is usually an expense; money sent TO it is usually a sale.
  - Use the caption, the direction words ("Transfer Masuk", "Dana Masuk", "Diterima", "Uang Keluar", "Pembayaran"), who is sender and who is recipient, and the document type to decide. A customer usually sends the owner a screenshot of a transfer from their own app as proof of payment, so the owner forwarding it is a sale. If you cannot tell the direction, pick the more likely one and give kind confidence 0.5 or lower.
  - owner_capital, owner_drawing, receivable, payable, settlement, transfer_in, transfer_out: as their names say; rare for documents.
- description: a short Bahasa Indonesia label without the amount ("Transfer masuk dari Sari W", "Belanja bahan di Toko Makmur").
- amount_text: the TOTAL paid, exactly as printed ("Rp 450.000", "450.000,00", "Total 1.250.000"). For a store receipt use the grand total (after discount, before change / kembalian), not the cash handed over.
- items: for receipts and invoices, one per purchased line: name as printed, qty_text, unit, unit_price_text and line_total_text as printed. Leave empty for transfer and payment receipts. At most 30 items.
- date_text: the transaction date as printed ("12 Nov 2026 14:03", "12/11/2026"), or null.
- counterparty: for an incoming transfer, the sender name; for an outgoing payment or receipt, the recipient, store or supplier name; null if none.
- payment_text: the payment method words as printed ("BCA", "Transfer", "QRIS", "GoPay", "TUNAI", "Debit BRI"), or null.
- suggested_category: the best category, or null. Ingredients and goods for resale are "HPP / Bahan baku".
- confidence: 0 to 1 per field. Use low values for blurry, cut-off or handwritten numbers.

One document is normally one entry. If the image is not a financial document (a selfie, a meme, a product photo), set document_type "not_a_document" and return no entries.

needs_clarification: fields the owner should be asked about, or an empty list.`;

export interface VisionExtraction {
  documentType: DocumentType;
  /** Transcription with identity/tax numbers masked; safe to store. */
  visibleText: string;
  /** What spans are checked against: caption + transcription. */
  sourceText: string;
  extraction: RawExtraction;
  modelVersion: string;
}

export async function extractFromDocument(
  model: StructuredModel,
  cfg: AiConfig,
  input: { attachment: Attachment; caption?: string; today: string; businessName?: string },
): Promise<VisionExtraction> {
  const caption = input.caption?.trim() ? maskSensitiveIds(input.caption.trim()) : "";
  const r = await model.generate({
    model: cfg.visionModel,
    effort: cfg.visionEffort,
    system: VISION_SYSTEM,
    user: [
      `Today is ${input.today}.`,
      input.businessName ? `Owner's business: ${input.businessName}` : null,
      caption ? `<caption>\n${caption}\n</caption>` : "No caption.",
    ]
      .filter(Boolean)
      .join("\n"),
    attachments: [input.attachment],
    schema: VisionOutput,
    maxTokens: 16000,
  });
  const visibleText = maskSensitiveIds(r.output.visible_text);
  return {
    documentType: r.output.document_type,
    visibleText,
    sourceText: caption ? `${caption}\n${visibleText}` : visibleText,
    extraction: { entries: r.output.entries, needs_clarification: r.output.needs_clarification },
    modelVersion: `${r.model}/${VISION_PROMPT_VERSION}`,
  };
}
