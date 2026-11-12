import { maskSensitiveIds } from "@bukuwa/idn";

/*
 * Speech-to-text for voice notes (F4). The provider is still to be chosen by
 * benchmark (spec 7.4: 2-3 providers on 100 real Indonesian voice notes; see
 * evals/stt-bench.ts). Providers plug in behind this interface.
 */

export interface Transcript {
  /** Masked: identity/tax numbers replaced with [ID]. */
  text: string;
  /** "<provider>/<model>", stored on the capture. */
  model: string;
}

export interface SpeechToText {
  transcribe(audio: { bytes: Uint8Array; mimeType: string }): Promise<Transcript>;
}

export class SttUnavailableError extends Error {
  constructor() {
    super("no speech-to-text provider is configured");
    this.name = "SttUnavailableError";
  }
}

/** Used until a provider is chosen: voice notes get a friendly "not yet" reply. */
export const noSpeechToText: SpeechToText = {
  async transcribe() {
    throw new SttUnavailableError();
  },
};

/** Wrap a provider so whatever it returns is masked before anyone else sees it. */
export function masked(stt: SpeechToText): SpeechToText {
  return {
    async transcribe(audio) {
      const t = await stt.transcribe(audio);
      return { ...t, text: maskSensitiveIds(t.text.trim()) };
    },
  };
}
