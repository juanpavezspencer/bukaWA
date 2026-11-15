import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  aiConfigFromEnv,
  anthropicChatModel,
  anthropicModel,
  costMicroIdr,
  DEFAULT_PRICES,
  microToRupiah,
  ModelRefusalError,
  priceFor,
  pricingFromEnv,
  routeMessage,
  withUsageMeter,
} from "../src/index.js";

const cfg = aiConfigFromEnv({});
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 };

function parseClient(response: Record<string, unknown>) {
  return {
    messages: { parse: async () => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", stop_details: null, usage, ...response }) },
  } as unknown as Anthropic;
}

describe("pricing", () => {
  const pricing = pricingFromEnv({});

  it("prices tokens in integer micro-rupiah, rounding up", () => {
    // Haiku: 1200*100 + 80*500 + 3000*10 = 190,000 milli-USD-per-MTok-tokens; x16500 / 1000 = 3,135,000 micro-IDR.
    expect(costMicroIdr(pricing, "claude-haiku-5-5", { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 0 })).toBe(3_135_000n);
    expect(costMicroIdr(pricing, "claude-haiku-5-5", { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(1650n);
    expect(costMicroIdr(pricing, "claude-haiku-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0n);
  });

  it("converts to whole rupiah for display", () => {
    expect(microToRupiah(3_135_000n)).toBe(3n);
    expect(microToRupiah(3_500_000n)).toBe(4n);
    expect(microToRupiah(499_999n)).toBe(0n);
  });

  it("never understates an unknown model, and matches suffixed ids by prefix", () => {
    expect(priceFor(pricing, "claude-something-new")).toEqual(DEFAULT_PRICES.default);
    expect(priceFor(pricing, "claude-haiku-5-5-preview")).toEqual(DEFAULT_PRICES["claude-haiku-5-5"]);
  });

  it("reads prices and the exchange rate from env", () => {
    const p = pricingFromEnv({ AI_PRICES_JSON: JSON.stringify({ "claude-haiku-5-5": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }), IDR_PER_USD: "15000" });
    expect(p.models["claude-haiku-5-5"]).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(p.models["claude-sonnet-5-5"]).toEqual(DEFAULT_PRICES["claude-sonnet-5-5"]);
    expect(p.idrPerUsd).toBe(15000);
    expect(() => pricingFromEnv({ AI_PRICES_JSON: JSON.stringify({ x: { input: 0.5 } }) })).toThrow(/AI_PRICES_JSON/);
    expect(() => pricingFromEnv({ IDR_PER_USD: "abc" })).toThrow(/IDR_PER_USD/);
  });
});

describe("usage meter", () => {
  it("collects every structured call made inside it", async () => {
    const model = anthropicModel(parseClient({ parsed_output: { intent: "transaction" } }));
    const { calls } = await withUsageMeter(async () => {
      await routeMessage(model, cfg, "jual 10rb");
      await routeMessage(model, cfg, "jual 20rb");
    });
    expect(calls).toEqual([
      { kind: "llm", model: "claude-haiku-5-5", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 0 },
      { kind: "llm", model: "claude-haiku-5-5", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 0 },
    ]);
  });

  it("counts refused calls too (they are billed)", async () => {
    const model = anthropicModel(parseClient({ stop_reason: "refusal", stop_details: { category: "cyber" } }));
    const { calls } = await withUsageMeter(async () => {
      await expect(routeMessage(model, cfg, "x")).rejects.toBeInstanceOf(ModelRefusalError);
    });
    expect(calls).toHaveLength(1);
  });

  it("counts each turn of the agent loop", async () => {
    const client = {
      messages: { create: async () => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [], usage }) },
    } as unknown as Anthropic;
    const chat = anthropicChatModel(client);
    const req = { model: "claude-sonnet-5-5", effort: "low" as const, system: "s", messages: [], tools: [], maxTokens: 10 };
    const { calls } = await withUsageMeter(async () => {
      await chat.create(req);
      await chat.create(req);
    });
    expect(calls.map((c) => c.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
  });

  it("keeps concurrent jobs apart and records nothing outside a meter", async () => {
    const model = anthropicModel(parseClient({ parsed_output: { intent: "chitchat" } }));
    await routeMessage(model, cfg, "outside");
    const [a, b] = await Promise.all([
      withUsageMeter(async () => routeMessage(model, cfg, "a")),
      withUsageMeter(async () => {
        await routeMessage(model, cfg, "b1");
        await routeMessage(model, cfg, "b2");
      }),
    ]);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(2);
  });
});
