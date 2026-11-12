import { aiConfigFromEnv, ROUTER_SYSTEM, type RawEntry, type StructuredModel } from "@bukuwa/ai";

export interface Script {
  intent: string;
  entries?: Array<Partial<RawEntry>>;
}

const sure = { kind: 0.95, amount: 0.95, date: 0.95, counterparty: 0.95, payment_method: 0.95 };

/** Test double: returns scripted router/extractor outputs keyed by message text, and records every prompt. */
export class ScriptedModel implements StructuredModel {
  calls: Array<{ system: string; user: string }> = [];
  failWith?: Error;
  constructor(private scripts: Record<string, Script> = {}) {}

  set(text: string, script: Script) {
    this.scripts[text] = script;
  }

  async generate<T>(req: { system: string; user: string; schema: { parse(v: unknown): T } }) {
    this.calls.push({ system: req.system, user: req.user });
    if (this.failWith) throw this.failWith;
    const text = /<message>\n([\s\S]*)\n<\/message>/.exec(req.user)?.[1] ?? "";
    const script = this.scripts[text];
    if (!script) throw new Error(`no script for ${JSON.stringify(text)}`);
    const output =
      req.system === ROUTER_SYSTEM
        ? { intent: script.intent }
        : {
            entries: (script.entries ?? []).map((e) => ({
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
            })),
            needs_clarification: [],
          };
    return { output: req.schema.parse(output), model: "claude-haiku-5-5" };
  }
}

export const aiConfig = aiConfigFromEnv({});
