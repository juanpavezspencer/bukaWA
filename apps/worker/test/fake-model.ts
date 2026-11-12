import { aiConfigFromEnv, ROUTER_SYSTEM, VISION_SYSTEM, type RawEntry, type StructuredModel } from "@bukuwa/ai";

export interface Script {
  intent: string;
  entries?: Array<Partial<RawEntry>>;
}

const sure = { kind: 0.95, amount: 0.95, date: 0.95, counterparty: 0.95, payment_method: 0.95 };

function fill(e: Partial<RawEntry>): RawEntry {
  return {
    kind: "sale",
    description: "Transaksi",
    amount_text: null,
    items: [],
    date_text: null,
    counterparty: null,
    payment_text: null,
    suggested_category: null,
    confidence: sure,
    ...e,
  };
}

/** Test double: returns scripted router/extractor outputs keyed by message text, and records every prompt. */
export class ScriptedModel implements StructuredModel {
  calls: Array<{ system: string; user: string; attachments: number }> = [];
  failWith?: Error;
  /** What the vision model "reads" from the next photo. */
  vision?: { document_type: string; visible_text: string; entries: Array<Partial<RawEntry>> };
  constructor(private scripts: Record<string, Script> = {}) {}

  set(text: string, script: Script) {
    this.scripts[text] = script;
  }

  async generate<T>(req: { system: string; user: string; attachments?: unknown[]; schema: { parse(v: unknown): T } }) {
    this.calls.push({ system: req.system, user: req.user, attachments: req.attachments?.length ?? 0 });
    if (this.failWith) throw this.failWith;
    if (req.system === VISION_SYSTEM) {
      if (!this.vision) throw new Error("no vision script");
      const v = this.vision;
      return {
        output: req.schema.parse({ ...v, entries: v.entries.map(fill), needs_clarification: [] }),
        model: "claude-sonnet-5-5",
      };
    }
    const text = /<message>\n([\s\S]*)\n<\/message>/.exec(req.user)?.[1] ?? "";
    const script = this.scripts[text];
    if (!script) throw new Error(`no script for ${JSON.stringify(text)}`);
    const output =
      req.system === ROUTER_SYSTEM
        ? { intent: script.intent }
        : {
            entries: (script.entries ?? []).map(fill),
            needs_clarification: [],
          };
    return { output: req.schema.parse(output), model: "claude-haiku-5-5" };
  }
}

export const aiConfig = aiConfigFromEnv({});
