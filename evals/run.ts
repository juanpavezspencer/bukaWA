/**
 * Eval runner (spec 7.5). Runs the real pipelines on the golden sets and scores
 * them against evals/baseline.json:
 *   text   router -> extractor -> normalizer on typed messages (F2)
 *   voice  the same path on voice-note transcripts (F4, after speech-to-text)
 *   image  vision extractor -> normalizer on photos and PDFs (F3)
 *   questions  router -> agent tool loop on fixture books: answers and corrections (F7, Flow D)
 *
 *   pnpm evals                          all sets; fail on a >2 point drop vs baseline
 *   pnpm evals -- --set text,voice      only some sets
 *   pnpm evals -- --update-baseline     record the current scores as the baseline
 *   pnpm evals -- --limit 20            quick smoke run on the first N cases per set
 *
 * Calls the Anthropic API: needs credentials (ANTHROPIC_API_KEY or an
 * `ant auth login` profile) and costs money. A full run is about 800 Haiku
 * calls (text + voice), 60 Sonnet vision calls and about 100 agent conversations
 * (2-4 Sonnet calls each).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Resvg } from "@resvg/resvg-js";
import {
  aiConfigFromEnv,
  anthropicChatModel,
  anthropicModel,
  extractFromDocument,
  extractTransaction,
  ModelOutputError,
  ModelRefusalError,
  normalizeExtraction,
  routeMessage,
  type NormalizedEntry,
} from "@bukuwa/ai";
import { askBooks } from "@bukuwa/worker/agent";
import { seedFixtureBooks, type FixtureBooks } from "./src/books-db.js";
import { FIXTURE_BUSINESS } from "./src/books-fixture.js";
import { imagePath, loadImageCases, loadQuestionCases, loadTextCases, loadVoiceCases } from "./src/dataset.js";
import {
  FIELDS,
  IMAGE_FIELDS,
  QUESTION_FIELDS,
  regressions,
  scoreCase,
  scoreImageCase,
  scoreQuestionCase,
  summarize,
  type CaseResult,
  type QuestionOutcome,
  type Summary,
} from "./src/score.js";
import type { ImageCase, QuestionCase, TextCase } from "./src/types.js";

const SETS = ["text", "voice", "image", "questions"] as const;
type SetName = (typeof SETS)[number];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const updateBaseline = args.includes("--update-baseline");
const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
const only = (flag("--set")?.split(",") ?? SETS) as SetName[];
for (const s of only) if (!SETS.includes(s)) throw new Error(`unknown set "${s}"; use ${SETS.join(", ")}`);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 8);

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const BASELINE = here("./baseline.json");

const cfg = aiConfigFromEnv();
const model = anthropicModel();
const chat = anthropicChatModel();

function isModelError(err: unknown): err is Error {
  return err instanceof ModelRefusalError || err instanceof ModelOutputError;
}

async function runText(c: TextCase): Promise<CaseResult> {
  let intent = "error";
  let entries: NormalizedEntry[] = [];
  try {
    intent = (await routeMessage(model, cfg, c.text)).intent;
    if (intent === "transaction") {
      const { extraction } = await extractTransaction(model, cfg, { text: c.text, today: c.today });
      entries = normalizeExtraction(extraction, c.text, c.today, cfg.lowConfidenceThreshold);
    }
  } catch (err) {
    if (!isModelError(err)) throw err;
    intent = `error:${err.name}`;
  }
  return scoreCase(c, intent, entries);
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

function loadImage(c: ImageCase): { mediaType: string; data: Uint8Array } {
  const path = imagePath(c);
  const ext = path.split(".").pop()!.toLowerCase();
  if (ext === "svg") {
    const png = new Resvg(readFileSync(path, "utf8"), { font: { loadSystemFonts: true }, fitTo: { mode: "zoom", value: 2 } }).render().asPng();
    return { mediaType: "image/png", data: new Uint8Array(png) };
  }
  const mediaType = MIME[ext];
  if (!mediaType) throw new Error(`${c.id}: unsupported file type .${ext}`);
  return { mediaType, data: new Uint8Array(readFileSync(path)) };
}

async function runImage(c: ImageCase): Promise<CaseResult> {
  try {
    const read = await extractFromDocument(model, cfg, {
      attachment: loadImage(c),
      caption: c.caption,
      today: c.today,
      businessName: c.business_name,
    });
    const isDoc = read.documentType !== "not_a_document" && read.extraction.entries.length > 0;
    const entries = normalizeExtraction(read.extraction, read.sourceText, c.today, cfg.lowConfidenceThreshold);
    return scoreImageCase(c, isDoc, entries);
  } catch (err) {
    if (!isModelError(err)) throw err;
    return { ...scoreImageCase(c, !c.expected.is_document, []), got: { intent: `error:${err.name}`, entries: [] } };
  }
}

async function runQuestion(books: FixtureBooks, c: QuestionCase): Promise<CaseResult> {
  let out: QuestionOutcome;
  try {
    const { intent } = await routeMessage(model, cfg, c.text);
    if (intent !== "question" && intent !== "correction") {
      out = { kind: "not_routed", intent };
    } else {
      const r = await askBooks(chat, cfg, { db: books.db, businessId: books.businessId, businessName: FIXTURE_BUSINESS, today: c.today, text: c.text });
      out =
        r.kind === "answer"
          ? { kind: "answer", text: r.text }
          : { kind: "proposal", journalId: r.proposal.journalId, action: r.proposal.action, amountIdr: r.proposal.amountIdr, paymentCode: r.proposal.paymentCode };
    }
  } catch (err) {
    if (!isModelError(err)) throw err;
    out = { kind: "not_routed", intent: `error:${err.name}` };
  }
  return scoreQuestionCase(c, out, books.journalIds);
}

async function pool<T>(items: T[], fn: (x: T) => Promise<CaseResult>, label: string): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
        if (++done % 25 === 0) console.log(`  ${label} ${done}/${items.length}`);
      }
    }),
  );
  return results;
}

async function runSet(name: SetName): Promise<{ summary: Summary; failures: CaseResult[] }> {
  let results: CaseResult[];
  let fields: readonly string[];
  if (name === "image") {
    results = await pool(loadImageCases().slice(0, limit), runImage, name);
    fields = IMAGE_FIELDS;
  } else if (name === "questions") {
    const books = await seedFixtureBooks();
    results = await pool(loadQuestionCases().slice(0, limit), (c) => runQuestion(books, c), name);
    fields = QUESTION_FIELDS;
  } else {
    const cases = (name === "text" ? loadTextCases() : loadVoiceCases()).slice(0, limit);
    results = await pool(cases, runText, name);
    fields = FIELDS;
  }
  const summary = summarize(results, fields);
  const failures = results.filter((r) => !r.intentOk || r.fields.some((f) => Object.values(f).includes(false)));
  return { summary, failures };
}

async function main() {
  console.log(
    `evals: ${only.join(", ")}${limit ? ` (first ${limit})` : ""}; router=${cfg.routerModel}/${cfg.routerEffort}, ` +
      `extractor=${cfg.extractorModel}/${cfg.extractorEffort}, vision=${cfg.visionModel}/${cfg.visionEffort}, ` +
      `agent=${cfg.agentModel}/${cfg.agentEffort}`,
  );
  const summaries: Partial<Record<SetName, Summary>> = {};
  const failures: Partial<Record<SetName, CaseResult[]>> = {};
  for (const name of only) {
    const r = await runSet(name);
    summaries[name] = r.summary;
    failures[name] = r.failures;
    const label = name === "image" ? "document detection" : name === "questions" ? "routed to the agent" : "intent accuracy";
    console.log(`\n[${name}] ${r.summary.cases} cases, ${label}: ${r.summary.intentAccuracy}%`);
    for (const [f, v] of Object.entries(r.summary.fieldAccuracy)) console.log(`  ${f.padEnd(15)} ${v}%`);
  }

  mkdirSync(here("./reports"), { recursive: true });
  const report = here(`./reports/evals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(report, JSON.stringify({ config: cfg, summaries, failures }, null, 2));
  console.log(`\nfailing cases written to ${report}`);

  const baseline: Partial<Record<SetName, Summary>> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  if (updateBaseline) {
    if (limit !== undefined) throw new Error("refusing to record a baseline from a --limit run");
    writeFileSync(BASELINE, JSON.stringify({ ...baseline, ...summaries }, null, 2) + "\n");
    console.log(`baseline updated for ${only.join(", ")}: ${BASELINE}`);
    return;
  }
  if (limit !== undefined) return; // partial runs don't gate

  const drops: string[] = [];
  for (const name of only) {
    const base = baseline[name];
    if (!base) {
      console.log(`[${name}] no baseline yet; run with --update-baseline to record one`);
      continue;
    }
    drops.push(...regressions(summaries[name]!, base).map((d) => `${name}: ${d}`));
  }
  if (drops.length) {
    console.error(`\nREGRESSION (> 2 points): ${drops.join("; ")}`);
    process.exit(1);
  }
  console.log("no regression vs baseline");
}

/** No credentials at all fails before any HTTP call, as a plain Error from the SDK's header check. */
function isMissingCredentials(err: unknown): boolean {
  return (
    err instanceof Anthropic.AuthenticationError ||
    (err instanceof Error && !(err instanceof Anthropic.APIError) && /resolve authentication method/.test(err.message))
  );
}

main().catch((err) => {
  if (isMissingCredentials(err)) {
    console.error("evals: no valid Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) and retry.");
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
