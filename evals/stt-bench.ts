/**
 * Speech-to-text benchmark (spec 7.4): run each candidate provider on real
 * Indonesian voice notes and compare word error rate and, more importantly,
 * whether the downstream pipeline still gets amount and kind right (F4 target:
 * 80%+).
 *
 * Data (not in git; personal voices): evals/datasets/voice-audio/
 *   manifest.jsonl  one line per note:
 *     {"id": "vn-001", "file": "vn-001.ogg", "reference": "<human transcript>",
 *      "today": "2026-11-12", "expected": { ...same shape as text cases... }}
 *   *.ogg / *.m4a / *.mp3  the audio files
 *
 *   pnpm --filter @bukuwa/evals stt-bench -- --providers a,b
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aiConfigFromEnv,
  anthropicModel,
  extractTransaction,
  normalizeExtraction,
  routeMessage,
  type NormalizedEntry,
} from "@bukuwa/ai";
import { scoreCase } from "./src/score.js";
import { STT_PROVIDERS } from "./src/stt-providers.js";
import type { TextCase } from "./src/types.js";
import { wer } from "./src/wer.js";

const DIR = fileURLToPath(new URL("./datasets/voice-audio/", import.meta.url));
const manifestPath = `${DIR}manifest.jsonl`;

const args = process.argv.slice(2);
const i = args.indexOf("--providers");
const wanted = i >= 0 ? args[i + 1]!.split(",") : Object.keys(STT_PROVIDERS);

if (!existsSync(manifestPath)) {
  console.error(`stt-bench: no audio set at ${manifestPath}. Collect ~100 consented voice notes with human transcripts first (see the header of this file).`);
  process.exit(2);
}
if (wanted.length === 0) {
  console.error("stt-bench: no providers registered yet. Add adapters to evals/src/stt-providers.ts.");
  process.exit(2);
}

type AudioCase = TextCase & { file: string; reference: string };
const cases = readFileSync(manifestPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AudioCase);
const MIME: Record<string, string> = { ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", amr: "audio/amr" };
const cfg = aiConfigFromEnv();
const model = anthropicModel();

for (const name of wanted) {
  const make = STT_PROVIDERS[name];
  if (!make) throw new Error(`unknown provider ${name}; registered: ${Object.keys(STT_PROVIDERS).join(", ")}`);
  const stt = make();
  let werSum = 0;
  let amountKindOk = 0;
  let scored = 0;
  const started = Date.now();
  for (const c of cases) {
    const bytes = new Uint8Array(readFileSync(`${DIR}${c.file}`));
    const t = await stt.transcribe({ bytes, mimeType: MIME[c.file.split(".").pop()!] ?? "audio/ogg" });
    werSum += wer(c.reference, t.text);
    if (!c.expected.entries?.length) continue;
    let entries: NormalizedEntry[] = [];
    const intent = (await routeMessage(model, cfg, t.text)).intent;
    if (intent === "transaction") {
      entries = normalizeExtraction((await extractTransaction(model, cfg, { text: t.text, today: c.today })).extraction, t.text, c.today, cfg.lowConfidenceThreshold);
    }
    const r = scoreCase({ ...c, text: t.text }, intent, entries);
    for (const f of r.fields) {
      scored++;
      if (f.amount && f.kind) amountKindOk++;
    }
  }
  console.log(
    `${name}: WER ${(100 * (werSum / cases.length)).toFixed(1)}%, amount+kind ${scored ? ((100 * amountKindOk) / scored).toFixed(1) : "-"}% ` +
      `(${cases.length} notes, ${((Date.now() - started) / 1000).toFixed(0)}s)`,
  );
}
