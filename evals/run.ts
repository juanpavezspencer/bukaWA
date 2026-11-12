/**
 * Eval runner (spec 7.5). Runs the real text pipeline (router -> extractor ->
 * code normalizer) on evals/datasets/text.jsonl and scores intent and field
 * accuracy (kind, amount, payment method, date).
 *
 *   pnpm evals                      score; fail on a >2 point drop vs baseline
 *   pnpm evals -- --update-baseline write the current scores as the baseline
 *   pnpm evals -- --limit 20        quick smoke run on the first N cases
 *
 * Calls the Anthropic API: needs credentials (ANTHROPIC_API_KEY or an
 * `ant auth login` profile) and costs money (~600 Haiku calls per full run).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  aiConfigFromEnv,
  anthropicModel,
  extractTransaction,
  ModelOutputError,
  ModelRefusalError,
  normalizeExtraction,
  routeMessage,
  type NormalizedEntry,
} from "@bukuwa/ai";
import { loadTextCases } from "./src/dataset.js";
import { regressions, scoreCase, summarize, type CaseResult, type Summary } from "./src/score.js";

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 8);

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const BASELINE = here("./baseline.json");

const cfg = aiConfigFromEnv();
const model = anthropicModel();
const cases = loadTextCases().slice(0, limit);

async function runCase(c: (typeof cases)[number]): Promise<CaseResult> {
  let intent = "error";
  let entries: NormalizedEntry[] = [];
  try {
    intent = (await routeMessage(model, cfg, c.text)).intent;
    if (intent === "transaction") {
      const { extraction } = await extractTransaction(model, cfg, { text: c.text, today: c.today });
      entries = normalizeExtraction(extraction, c.text, c.today, cfg.lowConfidenceThreshold);
    }
  } catch (err) {
    if (!(err instanceof ModelRefusalError || err instanceof ModelOutputError)) throw err;
    intent = `error:${(err as Error).name}`;
  }
  return scoreCase(c, intent, entries);
}

async function main() {
  console.log(`text eval: ${cases.length} cases, router=${cfg.routerModel}/${cfg.routerEffort}, extractor=${cfg.extractorModel}/${cfg.extractorEffort}`);
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < cases.length) {
        const i = next++;
        results[i] = await runCase(cases[i]!);
        if (++done % 25 === 0) console.log(`  ${done}/${cases.length}`);
      }
    }),
  );

  const summary = summarize(results);
  console.log(`\nintent accuracy: ${summary.intentAccuracy}%`);
  for (const [f, v] of Object.entries(summary.fieldAccuracy)) console.log(`${f.padEnd(15)} ${v}%`);

  mkdirSync(here("./reports"), { recursive: true });
  const report = here(`./reports/text-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const failures = results.filter((r) => !r.intentOk || r.fields.some((f) => Object.values(f).includes(false)));
  writeFileSync(report, JSON.stringify({ config: cfg, summary, failures }, null, 2));
  console.log(`\n${failures.length} failing cases written to ${report}`);

  if (updateBaseline) {
    writeFileSync(BASELINE, JSON.stringify({ text: summary }, null, 2) + "\n");
    console.log(`baseline updated: ${BASELINE}`);
    return;
  }
  if (limit !== undefined) return; // partial runs don't gate
  if (!existsSync(BASELINE)) {
    console.log("no baseline yet; run with --update-baseline to record one");
    return;
  }
  const baseline = (JSON.parse(readFileSync(BASELINE, "utf8")) as { text: Summary }).text;
  const drops = regressions(summary, baseline);
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
