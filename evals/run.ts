/**
 * Eval runner (spec 7.5). Scores field accuracy per golden dataset and fails on
 * a regression of more than 2 points against evals/baseline.json.
 *
 * Milestone 1 has no AI components, so there are no datasets yet; the first
 * text set (300 cases) arrives in milestone 2 together with the scorer.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./datasets", import.meta.url));
const datasets = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];

if (datasets.length === 0) {
  console.log("evals: no datasets yet (first text set lands in milestone 2) - nothing to score");
  process.exit(0);
}

console.error(`evals: found ${datasets.length} dataset(s) but no scorer is implemented yet`);
process.exit(1);
