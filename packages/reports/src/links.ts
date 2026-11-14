import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Signed, expiring download links (spec 7.3 create_report_link, 8.2). The
 * token names what it opens (a report or an evidence file), the business it
 * belongs to and when it expires, signed with HMAC-SHA256. The server still
 * loads the row inside that business's RLS scope.
 */

export type LinkKind = "report" | "evidence";

export interface LinkClaims {
  kind: LinkKind;
  /** reports.id or captures.id */
  id: string;
  businessId: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export type VerifyResult = { ok: true; claims: LinkClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const MIN_KEY_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function linkKeyFromBase64(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length < MIN_KEY_BYTES) throw new Error(`link signing key must be at least ${MIN_KEY_BYTES} bytes`);
  return key;
}

const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

export function signLink(key: Buffer, claims: LinkClaims): string {
  const payload = Buffer.from(JSON.stringify([claims.kind === "report" ? "r" : "e", claims.id, claims.businessId, claims.exp])).toString("base64url");
  return `${payload}.${mac(key, payload)}`;
}

export function verifyLink(key: Buffer, token: string, now: Date): VerifyResult {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(mac(key, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return { ok: false, reason: "malformed" };
  const [k, id, businessId, exp] = parsed as unknown[];
  if ((k !== "r" && k !== "e") || typeof id !== "string" || typeof businessId !== "string" || typeof exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (!UUID_RE.test(id) || !UUID_RE.test(businessId)) return { ok: false, reason: "malformed" };
  if (now.getTime() >= exp * 1000) return { ok: false, reason: "expired" };
  return { ok: true, claims: { kind: k === "r" ? "report" : "evidence", id, businessId, exp } };
}

/** Builds the public URLs the bot sends. */
export interface LinkSigner {
  reportUrl(businessId: string, reportId: string, now: Date): string;
  evidenceUrl(businessId: string, captureId: string, now: Date): string;
}

export function linkSigner(cfg: { key: Buffer; baseUrl: string; reportTtlMinutes: number; evidenceTtlHours: number }): LinkSigner {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const exp = (now: Date, ms: number) => Math.floor((now.getTime() + ms) / 1000);
  return {
    reportUrl: (businessId, id, now) =>
      `${base}/r/${signLink(cfg.key, { kind: "report", id, businessId, exp: exp(now, cfg.reportTtlMinutes * 60_000) })}`,
    evidenceUrl: (businessId, id, now) =>
      `${base}/e/${signLink(cfg.key, { kind: "evidence", id, businessId, exp: exp(now, cfg.evidenceTtlHours * 3_600_000) })}`,
  };
}
