/** Model names and thresholds live in config, never in code (CLAUDE.md). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiConfig {
  routerModel: string;
  routerEffort: Effort;
  extractorModel: string;
  extractorEffort: Effort;
  /** Fields with model confidence below this are flagged on the confirm card. */
  lowConfidenceThreshold: number;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function effort(v: string | undefined, fallback: Effort): Effort {
  return v && (EFFORTS as string[]).includes(v) ? (v as Effort) : fallback;
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const threshold = Number(env.AI_LOW_CONFIDENCE_THRESHOLD ?? "0.7");
  return {
    routerModel: env.AI_ROUTER_MODEL ?? "claude-haiku-5-5",
    routerEffort: effort(env.AI_ROUTER_EFFORT, "low"),
    extractorModel: env.AI_EXTRACTOR_MODEL ?? "claude-haiku-5-5",
    extractorEffort: effort(env.AI_EXTRACTOR_EFFORT, "low"),
    lowConfidenceThreshold: Number.isFinite(threshold) ? threshold : 0.7,
  };
}
