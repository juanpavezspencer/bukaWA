import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import { maskSensitiveIds } from "@bukuwa/idn";
import type { Effort } from "./config.js";

export interface StructuredRequest<T> {
  model: string;
  effort: Effort;
  /** Static instructions; cached. Must not contain per-request data. */
  system: string;
  /** Per-request content. NIK/NPWP are masked before sending. */
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface StructuredResult<T> {
  output: T;
  model: string;
}

/** The only door to an LLM. Implementations must send `maskedUser`, never raw text. */
export interface StructuredModel {
  generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class ModelRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`model declined the request (${category ?? "unknown"})`);
    this.name = "ModelRefusalError";
  }
}

export class ModelOutputError extends Error {
  constructor(readonly stopReason: string | null) {
    super(`model output did not match the schema (stop_reason=${stopReason})`);
    this.name = "ModelOutputError";
  }
}

export function anthropicModel(client: Anthropic = new Anthropic()): StructuredModel {
  return {
    async generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const response = await client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: maskSensitiveIds(req.user) }],
      });
      if (response.stop_reason === "refusal") {
        throw new ModelRefusalError(response.stop_details?.category ?? null);
      }
      if (response.parsed_output == null) throw new ModelOutputError(response.stop_reason);
      return { output: response.parsed_output as T, model: response.model };
    },
  };
}
