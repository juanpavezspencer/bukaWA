import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TextCase } from "./types.js";

export function loadTextCases(): TextCase[] {
  const path = fileURLToPath(new URL("../datasets/text.jsonl", import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TextCase);
}
