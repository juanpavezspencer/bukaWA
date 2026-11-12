import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ImageCase, TextCase } from "./types.js";

function load<T>(name: string): T[] {
  const path = fileURLToPath(new URL(`../datasets/${name}`, import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export const loadTextCases = () => load<TextCase>("text.jsonl");
/** Voice-note transcripts; same shape as text cases. */
export const loadVoiceCases = () => load<TextCase>("voice.jsonl");
export const loadImageCases = () => load<ImageCase>("images.jsonl");

export function imagePath(c: ImageCase): string {
  return fileURLToPath(new URL(`../datasets/images/${c.file}`, import.meta.url));
}
