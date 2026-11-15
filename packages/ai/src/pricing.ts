import type { Usage } from "./model.js";

/*
 * Model prices live in config (CLAUDE.md), as integer milli-USD per million
 * tokens: $0.10/MTok = 100. The exchange rate is integer rupiah per USD.
 * Costs come out as integer micro-rupiah (Rp 1 = 1,000,000) so a single cheap
 * call does not round to zero; sums are converted to rupiah for display.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Pricing {
  /** Keyed by model id; "default" prices any model not listed. */
  models: Record<string, ModelPrice>;
  idrPerUsd: number;
}

/**
 * Defaults: Anthropic list prices for the configured models (Haiku 5.5:
 * $0.10 in / $0.50 out; Sonnet 5.5: $2 / $10, cache reads $0.20). Cache
 * writes at 1.25x input and Haiku cache reads at 0.1x input are the usual
 * multipliers; override with AI_PRICES_JSON when the rate card changes.
 * Unknown models are priced as Sonnet so cost is never understated.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
  "claude-sonnet-5-5": { input: 2000, output: 10000, cacheRead: 200, cacheWrite: 2500 },
  default: { input: 2000, output: 10000, cacheRead: 200, cacheWrite: 2500 },
};

const PRICE_KEYS: Array<keyof ModelPrice> = ["input", "output", "cacheRead", "cacheWrite"];

function isPrice(v: unknown): v is ModelPrice {
  return !!v && typeof v === "object" && PRICE_KEYS.every((k) => Number.isSafeInteger((v as Record<string, unknown>)[k]) && ((v as Record<string, number>)[k] ?? -1) >= 0);
}

export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): Pricing {
  let models = DEFAULT_PRICES;
  if (env.AI_PRICES_JSON) {
    const parsed: unknown = JSON.parse(env.AI_PRICES_JSON);
    if (!parsed || typeof parsed !== "object" || !Object.values(parsed).every(isPrice)) {
      throw new Error("AI_PRICES_JSON must map model ids to {input, output, cacheRead, cacheWrite} in integer milli-USD per million tokens");
    }
    models = { ...DEFAULT_PRICES, ...(parsed as Record<string, ModelPrice>) };
  }
  const idrPerUsd = Number(env.IDR_PER_USD ?? "16500");
  if (!Number.isSafeInteger(idrPerUsd) || idrPerUsd <= 0) throw new Error("IDR_PER_USD must be a positive integer");
  return { models, idrPerUsd };
}

/** Price one call. Model ids may come back with a suffix; the longest matching prefix wins. */
export function priceFor(pricing: Pricing, model: string): ModelPrice {
  if (pricing.models[model]) return pricing.models[model]!;
  const key = Object.keys(pricing.models)
    .filter((k) => k !== "default" && model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return pricing.models[key ?? "default"] ?? DEFAULT_PRICES.default!;
}

/**
 * tokens * (milliUSD / 1e6 tokens) * (IDR / USD) * 1e6 micro-IDR / 1000 milliUSD
 *   = tokens * milliUSD * IDR / 1000 micro-IDR. Rounded up.
 */
export function costMicroIdr(pricing: Pricing, model: string, u: Usage): bigint {
  const p = priceFor(pricing, model);
  const milli =
    BigInt(u.inputTokens) * BigInt(p.input) +
    BigInt(u.outputTokens) * BigInt(p.output) +
    BigInt(u.cacheReadTokens) * BigInt(p.cacheRead) +
    BigInt(u.cacheWriteTokens) * BigInt(p.cacheWrite);
  const scaled = milli * BigInt(pricing.idrPerUsd);
  return (scaled + 999n) / 1000n;
}

/** Micro-rupiah to whole rupiah, rounded half up. */
export function microToRupiah(micro: bigint): bigint {
  return (micro + 500_000n) / 1_000_000n;
}
