import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Where original photos, PDFs and voice notes are kept as evidence (F3:
 * "original image stored"). Keys are deterministic per message so a retried
 * job overwrites the same object instead of creating a duplicate.
 *
 * Production target is Cloud Storage in the Jakarta region; a GCS-backed
 * implementation plugs in behind this interface.
 */
export interface MediaStore {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<string>;
  get(uri: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

export function mediaKey(businessId: string, waMessageId: string, mimeType: string): string {
  const safe = waMessageId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${businessId}/${safe}.${EXT[mimeType] ?? "bin"}`;
}

function mimeOf(path: string): string {
  return MIME[path.split(".").pop() ?? ""] ?? "application/octet-stream";
}

/** Local disk, for a single-host deployment or development. */
export function fsMediaStore(root: string): MediaStore {
  const base = resolve(root);
  const pathFor = (key: string) => {
    const p = resolve(base, key);
    if (!p.startsWith(base + sep)) throw new Error("media key escapes the store root");
    return p;
  };
  return {
    async put(key, bytes) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
      return `file://${p}`;
    },
    async get(uri) {
      if (!uri.startsWith("file://")) throw new Error(`not a file media uri: ${uri}`);
      const p = pathFor(uri.slice("file://".length).slice(base.length + 1));
      return { bytes: new Uint8Array(await readFile(p)), mimeType: mimeOf(p) };
    },
  };
}

/** In memory, for tests and the chat simulator. */
export function memoryMediaStore(): MediaStore & { objects: Map<string, { bytes: Uint8Array; mimeType: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  return {
    objects,
    async put(key, bytes, mimeType) {
      objects.set(key, { bytes, mimeType });
      return `mem://${key}`;
    },
    async get(uri) {
      const o = objects.get(uri.replace(/^mem:\/\//, ""));
      if (!o) throw new Error(`no media at ${uri}`);
      return o;
    },
  };
}

