import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { maskSensitiveIds } from "@bukuwa/idn";
import type { Effort } from "./config.js";
import { unsupportedNumbers } from "./guard.js";

/*
 * Tool-calling loop for questions and corrections (F7, Flow D). Tools are
 * read-only or produce drafts; the loop itself never touches the ledger.
 * The final answer passes the number guard: every number in it must appear in
 * a tool result, or the model gets one chance to fix it before a safe fallback.
 */

export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Returns JSON-able data for the model. `stop` ends the loop (e.g. a draft card was prepared). */
  run(input: I): Promise<{ output: unknown; stop?: boolean }>;
}

/** Helper that keeps the input type tied to the schema. */
export function agentTool<I>(t: AgentTool<I>): AgentTool<unknown> {
  return t as AgentTool<unknown>;
}

export interface ChatRequest {
  model: string;
  effort: Effort;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
}

export interface ChatResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  model: string;
}

/** The model side of the loop; a fake in tests. */
export interface ChatModel {
  create(req: ChatRequest): Promise<ChatResponse>;
}

export function anthropicChatModel(client: Anthropic = new Anthropic()): ChatModel {
  return {
    async create(req) {
      const r = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        output_config: { effort: req.effort },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: req.messages,
      });
      return { content: r.content, stopReason: r.stop_reason, model: r.model };
    },
  };
}

export interface AgentRun {
  /** Final text for the owner (guarded), or null if a tool stopped the loop. */
  text: string | null;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  /** "answer" | "tool_stop" | "fallback:<reason>" */
  outcome: string;
  model: string;
}

export interface AgentOptions {
  model: string;
  effort: Effort;
  system: string;
  /** The owner's message plus context (date, business). Masked before sending. */
  user: string;
  /** The owner's own words, for the number guard. */
  question: string;
  tools: Array<AgentTool<unknown>>;
  maxTurns?: number;
  /** Shown when the model can't produce a grounded answer. */
  fallback: string;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function runAgent(chat: ChatModel, o: AgentOptions): Promise<AgentRun> {
  const tools: Anthropic.Tool[] = o.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.input) as Anthropic.Tool.InputSchema,
  }));
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: maskSensitiveIds(o.user) }];
  const toolCalls: AgentRun["toolCalls"] = [];
  const sources: string[] = [];
  let guardRetried = false;
  let model = o.model;

  for (let turn = 0; turn < (o.maxTurns ?? 8); turn++) {
    const r = await chat.create({ model: o.model, effort: o.effort, system: o.system, messages, tools, maxTokens: 8192 });
    model = r.model;
    if (r.stopReason === "refusal") return { text: o.fallback, toolCalls, outcome: "fallback:refusal", model };
    // Thinking and tool_use blocks go back unchanged.
    messages.push({ role: "assistant", content: r.content as Anthropic.ContentBlockParam[] });

    const uses = r.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (r.stopReason === "tool_use" && uses.length) {
      const results: Anthropic.ToolResultBlockParam[] = [];
      let stop = false;
      for (const u of uses) {
        const tool = byName.get(u.name);
        let output: unknown;
        let isError = false;
        if (!tool) {
          output = { error: `unknown tool ${u.name}` };
          isError = true;
        } else {
          const parsed = tool.input.safeParse(u.input);
          if (!parsed.success) {
            output = { error: "invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
            isError = true;
          } else {
            const res = await tool.run(parsed.data);
            output = res.output;
            stop ||= Boolean(res.stop);
            isError = typeof output === "object" && output !== null && "error" in output;
          }
        }
        const text = json(output);
        sources.push(text);
        toolCalls.push({ name: u.name, input: u.input, output });
        results.push({ type: "tool_result", tool_use_id: u.id, content: text, ...(isError ? { is_error: true } : {}) });
      }
      if (stop) return { text: null, toolCalls, outcome: "tool_stop", model };
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return { text: o.fallback, toolCalls, outcome: "fallback:empty", model };
    const bad = unsupportedNumbers(text, sources, o.question);
    if (!bad.length) return { text, toolCalls, outcome: "answer", model };
    if (guardRetried) return { text: o.fallback, toolCalls, outcome: "fallback:ungrounded_numbers", model };
    guardRetried = true;
    messages.push({
      role: "user",
      content:
        `These numbers in your answer are not in any tool result: ${bad.join(", ")}. ` +
        "Never compute or estimate. Rewrite the answer using only numbers copied exactly from tool results, or call a tool that returns them.",
    });
  }
  return { text: o.fallback, toolCalls, outcome: "fallback:max_turns", model };
}
