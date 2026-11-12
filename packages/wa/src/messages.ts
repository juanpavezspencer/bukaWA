/** Outbound message shapes the bot uses. Limits follow the Cloud API. */
export type OutboundMessage =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: Array<{ id: string; title: string }> }
  | { kind: "list"; body: string; buttonText: string; rows: Array<{ id: string; title: string; description?: string }> };

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
  }
}

/** Plain-text rendering for the messages log. */
export function messageLogBody(msg: OutboundMessage): string {
  if (msg.kind === "text") return msg.body;
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
