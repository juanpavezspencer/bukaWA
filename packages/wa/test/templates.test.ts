import { describe, expect, it } from "vitest";
import { messageLogBody, renderTemplate, SUMMARY_TEMPLATE, TAX_NOTICE_TEMPLATE, toCloudApiPayload, type OutboundMessage } from "../src/index.js";

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

describe("tax notice template", () => {
  const tparams = ["Oktober 2026", "Catering Bu Rina", "Rp 50.000.000", "Rp 530.000.000", "Rp 150.000", "16 Nov 2026", "Batas bebas pajak Rp 500.000.000 setahun sudah terpakai semua."];
  const tax: OutboundMessage = {
    kind: "template",
    name: TAX_NOTICE_TEMPLATE.name,
    language: TAX_NOTICE_TEMPLATE.language,
    params: tparams,
    buttonPayloads: ["report:2026-10:pdf"],
  };

  it("sends the quick-reply button payload with the body parameters", () => {
    expect(toCloudApiPayload("62", tax)).toMatchObject({
      template: {
        name: "pajak_bulanan",
        components: [
          { type: "body", parameters: tparams.map((text) => ({ type: "text", text })) },
          { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "report:2026-10:pdf" }] },
        ],
      },
    });
  });

  it("requires one payload per approved button, and none for templates without buttons", () => {
    expect(() => toCloudApiPayload("62", { ...tax, buttonPayloads: [] })).toThrow(/1 button payload/);
    expect(() => toCloudApiPayload("62", { ...msg, buttonPayloads: ["x"] })).toThrow(/0 button payload/);
  });

  it("carries the disclaimer in the approved body and shows the button in logs", () => {
    expect(renderTemplate(tax)).toContain("bukan nasihat pajak");
    expect(messageLogBody(tax)).toMatch(/\[Lihat laporan\]$/);
  });
});
