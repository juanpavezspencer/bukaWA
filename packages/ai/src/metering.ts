import { AsyncLocalStorage } from "node:async_hooks";
import type { Usage } from "./model.js";

/*
 * Per-business cost metering (spec 5, 7.4: under Rp 3.000 per active business
 * a month). The Anthropic adapters report every response's token counts here;
 * the worker opens a meter around each job and writes what it collected to
 * usage_events for that business. Outside a meter (evals, scripts) nothing is
 * recorded.
 */

export interface MeteredCall extends Usage {
  kind: "llm" | "stt";
  model: string;
}

const meter = new AsyncLocalStorage<MeteredCall[]>();

/** Run `fn` and return its result with every model call it made. */
export async function withUsageMeter<T>(fn: () => Promise<T>): Promise<{ result: T; calls: MeteredCall[] }> {
  const calls: MeteredCall[] = [];
  const result = await meter.run(calls, fn);
  return { result, calls };
}

/** Called by model adapters. A missing usage block counts as zero tokens. */
export function recordUsage(model: string, usage: Usage | undefined, kind: MeteredCall["kind"] = "llm"): void {
  const calls = meter.getStore();
  if (!calls) return;
  calls.push({
    kind,
    model,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  });
}
