import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { aiConfigFromEnv, anthropicModel, extractTransaction, ModelOutputError, ModelRefusalError, routeMessage } from "../src/index.js";

type ParseArgs = Parameters<Anthropic["messages"]["parse"]>[0];

function stubClient(response: Record<string, unknown>, seen: ParseArgs[] = []) {
  return {
    messages: {
      parse: async (args: ParseArgs) => {
        seen.push(args);
        return { model: "claude-haiku-5-5", stop_reason: "end_turn", stop_details: null, ...response };
      },
    },
  } as unknown as Anthropic;
}

const cfg = aiConfigFromEnv({});

describe("config", () => {
  it("defaults to Haiku-class models and low effort, overridable by env", () => {
    expect(cfg).toMatchObject({ routerModel: "claude-haiku-5-5", extractorModel: "claude-haiku-5-5", routerEffort: "low" });
    expect(aiConfigFromEnv({ AI_EXTRACTOR_MODEL: "claude-sonnet-5-5", AI_EXTRACTOR_EFFORT: "medium" })).toMatchObject({
      extractorModel: "claude-sonnet-5-5",
      extractorEffort: "medium",
    });
  });
});

describe("anthropicModel", () => {
  it("masks NIK/NPWP before sending and caches the system prompt", async () => {
    const seen: ParseArgs[] = [];
    const model = anthropicModel(stubClient({ parsed_output: { intent: "transaction" } }, seen));
    const r = await routeMessage(model, cfg, "bayar pajak npwp 01.234.567.8-901.000 nik 3174012345678901 500rb");
    expect(r.intent).toBe("transaction");
    expect(r.modelVersion).toBe("claude-haiku-5-5/router-v1");
    const args = seen[0]!;
    const sent = JSON.stringify(args.messages);
    expect(sent).not.toMatch(/3174012345678901|01\.234\.567/);
    expect(sent).toContain("[ID]");
    expect(args.model).toBe("claude-haiku-5-5");
    expect(args.system).toMatchObject([{ cache_control: { type: "ephemeral" } }]);
    expect(args.output_config).toMatchObject({ effort: "low" });
  });

  it("keeps per-request data out of the system prompt", async () => {
    const seen: ParseArgs[] = [];
    const model = anthropicModel(stubClient({ parsed_output: { entries: [], needs_clarification: [] } }, seen));
    await extractTransaction(model, cfg, { text: "jual 10rb cash", today: "2026-11-12" });
    expect(JSON.stringify(seen[0]!.system)).not.toContain("2026-11-12");
    expect(JSON.stringify(seen[0]!.messages)).toContain("Today is 2026-11-12");
  });

  it("raises on refusals and on unparseable output", async () => {
    await expect(
      routeMessage(anthropicModel(stubClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null })), cfg, "x"),
    ).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(
      routeMessage(anthropicModel(stubClient({ stop_reason: "max_tokens", parsed_output: null })), cfg, "x"),
    ).rejects.toBeInstanceOf(ModelOutputError);
  });
});
