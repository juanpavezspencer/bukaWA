/** Model names and thresholds live in config, never in code (CLAUDE.md). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiConfig {
  routerModel: string;
  routerEffort: Effort;
  extractorModel: string;
  extractorEffort: Effort;
  /** Photos and PDFs (receipts, transfer screenshots, invoices). */
  visionModel: string;
  visionEffort: Effort;
  /** Questions and corrections: tool-calling loop (spec 7.4: Sonnet-class for multi-step Q&A). */
  agentModel: string;
  agentEffort: Effort;
  /** Largest image (bytes) sent to the vision model; the API caps images at 5 MB. */
  visionMaxImageBytes: number;
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
    visionModel: env.AI_VISION_MODEL ?? "claude-sonnet-5-5",
    visionEffort: effort(env.AI_VISION_EFFORT, "low"),
    agentModel: env.AI_AGENT_MODEL ?? "claude-sonnet-5-5",
    agentEffort: effort(env.AI_AGENT_EFFORT, "low"),
    visionMaxImageBytes: Number(env.AI_VISION_MAX_IMAGE_BYTES ?? 5 * 1024 * 1024),
    lowConfidenceThreshold: Number.isFinite(threshold) ? threshold : 0.7,
  };
}
