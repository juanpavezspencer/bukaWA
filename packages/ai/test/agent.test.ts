import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { agentTool, anthropicChatModel, runAgent, type ChatModel, type ChatRequest, type ChatResponse } from "../src/index.js";

/** Replays scripted responses and records each request. */
class ScriptedChat implements ChatModel {
  requests: ChatRequest[] = [];
  constructor(private steps: Array<Partial<ChatResponse> & { content: ChatResponse["content"] }>) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const s = this.steps.shift();
    if (!s) throw new Error("no more scripted steps");
    return { stopReason: "end_turn", model: "claude-sonnet-5-5", ...s };
  }
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input, caller: undefined }) as unknown as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;

const pl = agentTool({
  name: "get_profit_and_loss",
  description: "Profit and loss for a period",
  input: z.object({ period: z.enum(["this_week", "last_week"]) }),
  async run(i: { period: string }) {
    return { output: { period: i.period, profit: "Rp 725.000" } };
  },
});

const base = { model: "claude-sonnet-5-5", effort: "low" as const, system: "sys", tools: [pl], fallback: "FALLBACK" };

describe("runAgent", () => {
  it("runs tools and returns an answer grounded in their results", async () => {
    const chat = new ScriptedChat([
      { stopReason: "tool_use", content: [toolUse("t1", "get_profit_and_loss", { period: "this_week" })] },
      { content: [text("Untung minggu ini *Rp 725.000*.")] },
    ]);
    const r = await runAgent(chat, { ...base, user: "untung minggu ini?", question: "untung minggu ini?" });
    expect(r).toMatchObject({ text: "Untung minggu ini *Rp 725.000*.", outcome: "answer" });
    expect(r.toolCalls).toEqual([{ name: "get_profit_and_loss", input: { period: "this_week" }, output: { period: "this_week", profit: "Rp 725.000" } }]);
    const second = chat.requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] });
    expect(chat.requests[0]!.tools[0]).toMatchObject({ name: "get_profit_and_loss", input_schema: { type: "object" } });
  });

  it("gives the model one chance to drop made-up numbers, then falls back", async () => {
    const fixed = new ScriptedChat([
      { stopReason: "tool_use", content: [toolUse("t1", "get_profit_and_loss", { period: "this_week" })] },
      { content: [text("Untung Rp 725.000, rata-rata Rp 103.571 per hari.")] },
      { content: [text("Untung minggu ini Rp 725.000.")] },
    ]);
    const r1 = await runAgent(fixed, { ...base, user: "q", question: "q" });
    expect(r1).toMatchObject({ text: "Untung minggu ini Rp 725.000.", outcome: "answer" });
    expect(JSON.stringify(fixed.requests[2]!.messages.at(-1))).toContain("103.571");

    const stubborn = new ScriptedChat([{ content: [text("Untung Rp 999.000")] }, { content: [text("Untung Rp 999.000")] }]);
    const r2 = await runAgent(stubborn, { ...base, user: "q", question: "q" });
    expect(r2).toMatchObject({ text: "FALLBACK", outcome: "fallback:ungrounded_numbers" });
  });

  it("returns invalid tool input to the model as an error instead of throwing", async () => {
    const chat = new ScriptedChat([
      { stopReason: "tool_use", content: [toolUse("t1", "get_profit_and_loss", { period: "forever" })] },
      { content: [text("Maaf, periodenya nggak dikenal.")] },
    ]);
    await runAgent(chat, { ...base, user: "q", question: "q" });
    expect(chat.requests[1]!.messages.at(-1)).toMatchObject({ content: [{ type: "tool_result", is_error: true }] });
  });

  it("stops when a tool says so (a draft card replaces the text answer)", async () => {
    const propose = agentTool({
      name: "propose_correction",
      description: "draft",
      input: z.object({ ref: z.string() }),
      async run() {
        return { output: { status: "card_will_be_sent" }, stop: true };
      },
    });
    const chat = new ScriptedChat([{ stopReason: "tool_use", content: [toolUse("t1", "propose_correction", { ref: "abc" })] }]);
    const r = await runAgent(chat, { ...base, tools: [propose], user: "q", question: "q" });
    expect(r).toMatchObject({ text: null, outcome: "tool_stop" });
  });

  it("masks identity numbers and falls back on refusal or too many turns", async () => {
    const chat = new ScriptedChat([{ stopReason: "refusal", content: [] }]);
    const r = await runAgent(chat, { ...base, user: "npwp 012345678901234", question: "x" });
    expect(r.outcome).toBe("fallback:refusal");
    expect(JSON.stringify(chat.requests[0]!.messages)).not.toContain("012345678901234");

    const loop = new ScriptedChat(Array.from({ length: 3 }, (_, i) => ({ stopReason: "tool_use", content: [toolUse(`t${i}`, "get_profit_and_loss", { period: "this_week" })] })));
    expect((await runAgent(loop, { ...base, user: "q", question: "q", maxTurns: 3 })).outcome).toBe("fallback:max_turns");
  });
});

describe("anthropicChatModel", () => {
  it("sends tools, caches the system prompt and sets effort", async () => {
    const seen: unknown[] = [];
    const client = {
      messages: {
        create: async (args: unknown) => {
          seen.push(args);
          return { content: [], stop_reason: "end_turn", model: "claude-sonnet-5-5" };
        },
      },
    } as unknown as Anthropic;
    await anthropicChatModel(client).create({ model: "m", effort: "low", system: "s", messages: [], tools: [], maxTokens: 10 });
    expect(seen[0]).toMatchObject({ system: [{ cache_control: { type: "ephemeral" } }], output_config: { effort: "low" }, tools: [] });
  });
});
