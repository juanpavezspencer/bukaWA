import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fsMediaStore, mediaKey, memoryMediaStore } from "../src/media/store.js";

const BIZ = "00000000-0000-4000-8000-000000000001";

describe("mediaKey", () => {
  it("is deterministic per message and safe as a path", () => {
    expect(mediaKey(BIZ, "wamid.HBg/../x==", "image/jpeg")).toBe(`${BIZ}/wamid.HBg_.._x__.jpg`);
    expect(mediaKey(BIZ, "w1", "audio/ogg")).toBe(`${BIZ}/w1.ogg`);
    expect(mediaKey(BIZ, "w1", "application/x-unknown")).toBe(`${BIZ}/w1.bin`);
  });
});

describe("fsMediaStore", () => {
  let dir: string;
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("round-trips bytes and type, overwriting on retry", async () => {
    dir = await mkdtemp(join(tmpdir(), "bukuwa-media-"));
    const store = fsMediaStore(dir);
    const key = mediaKey(BIZ, "w1", "image/png");
    await store.put(key, new Uint8Array([9]), "image/png");
    const uri = await store.put(key, new Uint8Array([1, 2]), "image/png");
    expect(uri.startsWith("file://")).toBe(true);
    const got = await store.get(uri);
    expect([...got.bytes]).toEqual([1, 2]);
    expect(got.mimeType).toBe("image/png");
  });

  it("refuses keys that escape the root", async () => {
    const store = fsMediaStore(dir);
    await expect(store.put("../evil.jpg", new Uint8Array([1]), "image/jpeg")).rejects.toThrow(/escapes/);
  });
});

describe("memoryMediaStore", () => {
  it("round-trips", async () => {
    const store = memoryMediaStore();
    const uri = await store.put("a/b.jpg", new Uint8Array([7]), "image/jpeg");
    expect(await store.get(uri)).toEqual({ bytes: new Uint8Array([7]), mimeType: "image/jpeg" });
  });
});
