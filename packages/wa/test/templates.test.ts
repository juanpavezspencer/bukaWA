import { describe, expect, it } from "vitest";
import { messageLogBody, renderTemplate, SUMMARY_TEMPLATE, toCloudApiPayload, type OutboundMessage } from "../src/index.js";

const params = ["12 Nov", "Catering Bu Rina", "Rp 1.260.000", "Rp 878.000", "untung Rp 382.000", "Rp 6.120.000", "Jual nasi box (Rp 900.000)", "Rp 550.000 dari 2 pelanggan"];
const msg: OutboundMessage = { kind: "template", name: SUMMARY_TEMPLATE.name, language: SUMMARY_TEMPLATE.language, params };

describe("template messages", () => {
  it("builds the Cloud API template payload with positional body parameters", () => {
    expect(toCloudApiPayload("6281234567890", msg)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "6281234567890",
      type: "template",
      template: {
        name: "ringkasan_bisnis",
        language: { code: "id" },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    });
  });

  it("rejects parameters WhatsApp would refuse", () => {
    expect(() => toCloudApiPayload("62", { ...msg, params: params.map((p, i) => (i === 6 ? "a\nb" : p)) })).toThrow(/newline/);
    expect(() => toCloudApiPayload("62", { ...msg, params: params.slice(1) })).toThrow(/8 parameters/);
    expect(() => toCloudApiPayload("62", { ...msg, params: params.map((p, i) => (i === 0 ? "" : p)) })).toThrow(/empty/);
  });

  it("renders the approved body text for logs and the dev chat", () => {
    const text = renderTemplate(msg);
    expect(text).toContain("Ringkasan 12 Nov untuk Catering Bu Rina");
    expect(text).toContain("💰 Pemasukan: Rp 1.260.000");
    expect(text).toContain("⏳ Belum dibayar pelanggan: Rp 550.000 dari 2 pelanggan");
    expect(text).not.toMatch(/\{\{\d\}\}/);
    expect(messageLogBody(msg)).toBe(`[template ringkasan_bisnis]\n${text}`);
  });
});
