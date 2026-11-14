import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { linkKeyFromBase64, linkSigner, signLink, verifyLink } from "../src/links.js";

const key = randomBytes(32);
const claims = { kind: "report" as const, id: randomUUID(), businessId: randomUUID(), exp: Date.UTC(2026, 10, 13, 12, 15) / 1000 };
const at = (iso: string) => new Date(iso);

describe("signed links", () => {
  it("round-trips the claims before expiry", () => {
    const t = signLink(key, claims);
    expect(verifyLink(key, t, at("2026-11-13T12:14:59Z"))).toEqual({ ok: true, claims });
  });

  it("expires at exp", () => {
    expect(verifyLink(key, signLink(key, claims), at("2026-11-13T12:15:00Z"))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed with another key", () => {
    expect(verifyLink(randomBytes(32), signLink(key, claims), at("2026-11-13T12:00:00Z"))).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects a token whose business id was swapped", () => {
    const [, sig] = signLink(key, claims).split(".");
    const forged = Buffer.from(JSON.stringify(["r", claims.id, randomUUID(), claims.exp])).toString("base64url");
    expect(verifyLink(key, `${forged}.${sig}`, at("2026-11-13T12:00:00Z"))).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects a later expiry or a different kind", () => {
    const [, sig] = signLink(key, claims).split(".");
    for (const body of [["r", claims.id, claims.businessId, claims.exp + 86_400], ["e", claims.id, claims.businessId, claims.exp]]) {
      const forged = Buffer.from(JSON.stringify(body)).toString("base64url");
      expect(verifyLink(key, `${forged}.${sig}`, at("2026-11-13T12:00:00Z"))).toMatchObject({ ok: false });
    }
  });

  it.each(["", "abc", "a.b.c", "x.y", `${Buffer.from("[]").toString("base64url")}.zz`])("treats %j as malformed or unsigned", (t) => {
    expect(verifyLink(key, t, at("2026-11-13T12:00:00Z")).ok).toBe(false);
  });

  it("refuses a short signing key", () => {
    expect(() => linkKeyFromBase64(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("builds report and evidence URLs with their own lifetimes", () => {
    const s = linkSigner({ key, baseUrl: "https://bukuwa.id/", reportTtlMinutes: 15, evidenceTtlHours: 24 });
    const now = at("2026-11-13T12:00:00Z");
    const r = s.reportUrl(claims.businessId, claims.id, now);
    expect(r).toMatch(/^https:\/\/bukuwa\.id\/r\/[\w-]+\.[\w-]+$/);
    const rc = verifyLink(key, r.split("/r/")[1]!, now);
    expect(rc.ok && rc.claims.exp).toBe(now.getTime() / 1000 + 15 * 60);
    const e = s.evidenceUrl(claims.businessId, claims.id, now);
    const ec = verifyLink(key, e.split("/e/")[1]!, now);
    expect(ec.ok && ec.claims).toMatchObject({ kind: "evidence", exp: now.getTime() / 1000 + 24 * 3600 });
  });
});
