import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  aiConfigFromEnv,
  anthropicModel,
  extractFromDocument,
  masked,
  noSpeechToText,
  normalizeExtraction,
  SttUnavailableError,
  type RawEntry,
} from "../src/index.js";

type ParseArgs = Parameters<Anthropic["messages"]["parse"]>[0];
const cfg = aiConfigFromEnv({});
const TODAY = "2026-11-12";

const entry = (over: Partial<RawEntry>): RawEntry => ({
  kind: "sale",
  description: "Transfer masuk dari Sari W",
  amount_text: "Rp 450.000,00",
  items: [],
  date_text: "12 Nov 2026 14:03",
  counterparty: "SARI W",
  payment_text: "BCA",
  suggested_category: "Penjualan",
  confidence: { kind: 0.9, amount: 0.95, date: 0.95, counterparty: 0.9, payment_method: 0.9 },
  ...over,
});

function stub(output: Record<string, unknown>, seen: ParseArgs[]) {
  return anthropicModel({
    messages: {
      parse: async (args: ParseArgs) => {
        seen.push(args);
        return { model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_details: null, parsed_output: output };
      },
    },
  } as unknown as Anthropic);
}

const RECEIPT = "Transfer Berhasil\n12 Nov 2026 14:03 WIB\nDari SARI W\nBCA 1234567890\nNominal Rp 450.000,00\nNIK 3174012345678901";

describe("extractFromDocument", () => {
  it("sends the image before the text, to the vision model, and masks the transcription", async () => {
    const seen: ParseArgs[] = [];
    const model = stub({ document_type: "transfer_receipt", visible_text: RECEIPT, entries: [entry({})], needs_clarification: [] }, seen);
    const r = await extractFromDocument(model, cfg, {
      attachment: { mediaType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
      caption: "dp dari bu sari, nik 3174012345678901",
      today: TODAY,
      businessName: "Catering Bu Rina",
    });

    const args = seen[0]!;
    expect(args.model).toBe("claude-sonnet-5-5");
    const content = args.messages[0]!.content as Array<{ type: string; source?: { media_type: string; data: string } }>;
    expect(content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(content[0]!.source).toEqual({ type: "base64", media_type: "image/jpeg", data: "/9j/" });
    expect(JSON.stringify(content[1])).not.toContain("3174012345678901");
    expect(JSON.stringify(content[1])).toContain("Owner's business: Catering Bu Rina");

    expect(r.documentType).toBe("transfer_receipt");
    expect(r.visibleText).not.toContain("3174012345678901");
    expect(r.modelVersion).toBe("claude-sonnet-5-5/vision-v1");
  });

  it("sends PDFs as document blocks", async () => {
    const seen: ParseArgs[] = [];
    const model = stub({ document_type: "supplier_invoice", visible_text: "", entries: [], needs_clarification: [] }, seen);
    await extractFromDocument(model, cfg, { attachment: { mediaType: "application/pdf", data: new Uint8Array([1]) }, today: TODAY });
    const content = seen[0]!.messages[0]!.content as Array<{ type: string }>;
    expect(content[0]!.type).toBe("document");
  });

  it("normalizes spans against the transcription, with code doing the numbers", async () => {
    const model = stub({ document_type: "transfer_receipt", visible_text: RECEIPT, entries: [entry({})], needs_clarification: [] }, []);
    const r = await extractFromDocument(model, cfg, { attachment: { mediaType: "image/png", data: new Uint8Array([1]) }, today: TODAY });
    const [e] = normalizeExtraction(r.extraction, r.sourceText, TODAY, 0.7);
    expect(e).toMatchObject({ kind: "sale", amountIdr: 450_000n, date: "2026-11-12", counterparty: "SARI W", paymentMethod: "bank:BCA", missing: [] });
  });

  it("rejects an amount that is not in the transcription", async () => {
    const model = stub(
      { document_type: "transfer_receipt", visible_text: RECEIPT, entries: [entry({ amount_text: "Rp 540.000" })], needs_clarification: [] },
      [],
    );
    const r = await extractFromDocument(model, cfg, { attachment: { mediaType: "image/png", data: new Uint8Array([1]) }, today: TODAY });
    const [e] = normalizeExtraction(r.extraction, r.sourceText, TODAY, 0.7);
    expect(e!.amountIdr).toBeNull();
    expect(e!.missing).toContain("amount");
  });
});

describe("speech-to-text", () => {
  it("reports when no provider is configured", async () => {
    await expect(noSpeechToText.transcribe({ bytes: new Uint8Array(), mimeType: "audio/ogg" })).rejects.toBeInstanceOf(SttUnavailableError);
  });

  it("masks identity numbers in transcripts", async () => {
    const stt = masked({ transcribe: async () => ({ text: " bayar pajak npwp 012345678901234 ", model: "fake/v1" }) });
    expect(await stt.transcribe({ bytes: new Uint8Array(), mimeType: "audio/ogg" })).toEqual({ text: "bayar pajak npwp [ID]", model: "fake/v1" });
  });
});
