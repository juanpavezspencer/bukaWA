import type { SpeechToText } from "@bukuwa/ai";

/**
 * Speech-to-text candidates for the benchmark (spec 7.4). Add an adapter per
 * provider here (and the same adapter in packages/ai once one is chosen).
 * Each entry builds the provider from environment variables.
 */
export const STT_PROVIDERS: Record<string, () => SpeechToText> = {};
