/** Outbound message shapes the bot uses. Limits follow the Cloud API. */
export type OutboundMessage =
  /** logBody: what the messages log keeps instead of body (e.g. with a login token redacted). */
  | { kind: "text"; body: string; logBody?: string }
  | { kind: "buttons"; body: string; buttons: Array<{ id: string; title: string }> }
  | { kind: "list"; body: string; buttonText: string; rows: Array<{ id: string; title: string; description?: string }> }
  /**
   * A pre-approved template: the only kind allowed outside the 24-hour window
   * (scheduled summaries, the month-end tax notice). buttonPayloads: one per
   * approved quick-reply button, delivered back as the reply id when tapped.
   */
  | { kind: "template"; name: string; language: string; params: string[]; buttonPayloads?: string[] };

export interface TemplateDef {
  name: string;
  language: string;
  /** The body exactly as submitted to Meta for approval; {{n}} are the params. */
  body: string;
  /** Quick-reply button titles, as submitted for approval. */
  quickReplies?: string[];
}

/**
 * F9 daily/weekly summary. Submit this body to Meta (category: utility) under
 * this name before turning summaries on in production.
 */
export const SUMMARY_TEMPLATE: TemplateDef = {
  name: "ringkasan_bisnis",
  language: "id",
  body: [
    "Ringkasan {{1}} untuk {{2}} 📊",
    "",
    "💰 Pemasukan: {{3}}",
    "🧾 Pengeluaran: {{4}}",
    "📈 Laba/rugi: {{5}}",
    "🏦 Total uang (kas, bank, e-wallet): {{6}}",
    "🔥 Paling laku: {{7}}",
    "⏳ Belum dibayar pelanggan: {{8}}",
    "",
    "Balas pesan ini kalau mau tanya detailnya, misalnya \"pengeluaran kemarin apa aja?\"",
  ].join("\n"),
};

/**
 * Flow E month-end tax notice, sent on the 1st for last month. Submit to Meta
 * (category: utility) with one quick-reply button before enabling it.
 */
export const TAX_NOTICE_TEMPLATE: TemplateDef = {
  name: "pajak_bulanan",
  language: "id",
  body: [
    "Perkiraan pajak {{1}} untuk {{2}} 🧾",
    "",
    "💰 Omzet bulan itu: {{3}}",
    "📅 Omzet sejak Januari: {{4}}",
    "🧮 Perkiraan PPh final: {{5}}",
    "⏰ Batas bayar: {{6}}",
    "",
    "{{7}}",
    "",
    "Ini perkiraan, bukan nasihat pajak. Bayar dan lapor tetap kamu yang lakukan ya. Kalau sudah bayar, kirim foto bukti bayarnya ke sini.",
  ].join("\n"),
  quickReplies: ["Lihat laporan"],
};

export const TEMPLATES: Record<string, TemplateDef> = {
  [SUMMARY_TEMPLATE.name]: SUMMARY_TEMPLATE,
  [TAX_NOTICE_TEMPLATE.name]: TAX_NOTICE_TEMPLATE,
};

const paramCount = (t: TemplateDef) => new Set(t.body.match(/\{\{\d+\}\}/g) ?? []).size;

/** The text the owner sees, for the messages log and the dev chat. */
export function renderTemplate(msg: Extract<OutboundMessage, { kind: "template" }>): string {
  const t = TEMPLATES[msg.name];
  if (!t) throw new Error(`unknown template ${msg.name}`);
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => msg.params[Number(n) - 1] ?? "");
}

const LIMITS = { body: 1024, buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, listButton: 20 };

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`invalid WhatsApp message: ${msg}`);
}

/** Build the Cloud API /messages request body. Throws if a limit is exceeded. */
export function toCloudApiPayload(to: string, msg: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (msg.kind) {
    case "text":
      check(msg.body.length > 0 && msg.body.length <= 4096, "text body length");
      return { ...base, type: "text", text: { body: msg.body, preview_url: false } };
    case "buttons":
      check(msg.body.length <= LIMITS.body, "body too long");
      check(msg.buttons.length >= 1 && msg.buttons.length <= LIMITS.buttons, "1-3 buttons");
      for (const b of msg.buttons) check(b.title.length <= LIMITS.buttonTitle, `button title "${b.title}" too long`);
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: msg.body },
          action: { buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
    case "list":
      check(msg.body.length <= LIMITS.body, "body too long");
      check(msg.buttonText.length <= LIMITS.listButton, "list button text too long");
      check(msg.rows.length >= 1 && msg.rows.length <= LIMITS.rows, "1-10 rows");
      for (const r of msg.rows) check(r.title.length <= LIMITS.rowTitle, `row title "${r.title}" too long`);
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: msg.body },
          action: { button: msg.buttonText, sections: [{ title: "Pilihan", rows: msg.rows }] },
        },
      };
    case "template": {
      const t = TEMPLATES[msg.name];
      check(t !== undefined, `unknown template ${msg.name}`);
      check(msg.params.length === paramCount(t!), `${msg.name} takes ${paramCount(t!)} parameters`);
      for (const p of msg.params) {
        check(p.trim().length > 0, "template parameter is empty");
        // Cloud API rejects these in body parameters.
        check(!/[\n\t]| {5,}/.test(p), "template parameter has a newline, tab or 5+ spaces");
        check(p.length <= 1024, "template parameter too long");
      }
      const buttons = t!.quickReplies ?? [];
      const payloads = msg.buttonPayloads ?? [];
      check(payloads.length === buttons.length, `${msg.name} takes ${buttons.length} button payload(s)`);
      for (const p of payloads) check(p.length > 0 && p.length <= 256, "button payload length");
      return {
        ...base,
        type: "template",
        template: {
          name: msg.name,
          language: { code: msg.language },
          components: [
            { type: "body", parameters: msg.params.map((text) => ({ type: "text", text })) },
            ...payloads.map((payload, i) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }] })),
          ],
        },
      };
    }
  }
}

/** The main text the owner reads: the body, or a template's rendered body. */
export function messageText(msg: OutboundMessage): string {
  return msg.kind === "template" ? renderTemplate(msg) : msg.body;
}

/** Plain-text rendering for the messages log. */
export function messageLogBody(msg: OutboundMessage): string {
  if (msg.kind === "text") return msg.logBody ?? msg.body;
  if (msg.kind === "template") {
    const buttons = TEMPLATES[msg.name]?.quickReplies ?? [];
    return `[template ${msg.name}]\n${renderTemplate(msg)}${buttons.length ? `\n[${buttons.join(" | ")}]` : ""}`;
  }
  const opts = msg.kind === "buttons" ? msg.buttons : msg.rows;
  return `${msg.body}\n[${opts.map((o) => o.title).join(" | ")}]`;
}

/** What the user said: typed text, or the id + title of the button/list row they tapped. */
export interface InboundInput {
  text?: string;
  replyId?: string;
}

export function inboundInput(raw: Record<string, unknown>): InboundInput {
  const m = raw as {
    type?: string;
    text?: { body?: string };
    interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
    button?: { payload?: string; text?: string };
  };
  if (m.type === "text") return { text: m.text?.body ?? "" };
  if (m.type === "interactive") {
    const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
    return r ? { replyId: r.id, text: r.title } : {};
  }
  if (m.type === "button") return { replyId: m.button?.payload, text: m.button?.text };
  return {};
}

/** pg-boss queue the webhook fills and the worker drains; payload { waMessageId }. */
export const WA_INBOUND_QUEUE = "wa.inbound";
