import { describe, expect, it } from "vitest";
import { cloudApiMediaFetcher, inboundMedia, MediaTooLargeError } from "../src/index.js";

describe("inboundMedia", () => {
  it("reads photos, voice notes and PDF/image documents", () => {
    expect(inboundMedia({ type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "nota ayam" } })).toEqual({
      kind: "image", id: "m1", mimeType: "image/jpeg", caption: "nota ayam",
    });
    expect(inboundMedia({ type: "audio", audio: { id: "m2", mime_type: "audio/ogg; codecs=opus", voice: true } })).toEqual({
      kind: "audio", id: "m2", mimeType: "audio/ogg",
    });
    expect(inboundMedia({ type: "document", document: { id: "m3", mime_type: "application/pdf" } })).toMatchObject({ kind: "pdf" });
    expect(inboundMedia({ type: "document", document: { id: "m4", mime_type: "image/png" } })).toMatchObject({ kind: "image" });
  });

  it("ignores other types", () => {
    expect(inboundMedia({ type: "text", text: { body: "hi" } })).toBeNull();
    expect(inboundMedia({ type: "document", document: { id: "m5", mime_type: "application/zip" } })).toBeNull();
    expect(inboundMedia({ type: "video", video: { id: "m6" } })).toBeNull();
  });
});

describe("cloudApiMediaFetcher", () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (size: number, body = new Uint8Array([1, 2, 3])) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
      if (u.startsWith("https://graph.facebook.com/")) {
        return Response.json({ url: "https://lookaside.example/media/abc", mime_type: "image/jpeg", file_size: size });
      }
      return new Response(body, { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;

  it("looks up the URL, then downloads with the bearer token", async () => {
    calls.length = 0;
    const f = cloudApiMediaFetcher({ accessToken: "tok", apiVersion: "v21.0", maxBytes: 100, fetch: fakeFetch(3) });
    const media = await f.fetch("m1");
    expect([...media.bytes]).toEqual([1, 2, 3]);
    expect(media.mimeType).toBe("image/jpeg");
    expect(calls.map((c) => c.url)).toEqual(["https://graph.facebook.com/v21.0/m1", "https://lookaside.example/media/abc"]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("refuses media over the size limit before downloading", async () => {
    calls.length = 0;
    const f = cloudApiMediaFetcher({ accessToken: "tok", apiVersion: "v21.0", maxBytes: 100, fetch: fakeFetch(5000) });
    await expect(f.fetch("m1")).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(calls).toHaveLength(1);
  });
});
