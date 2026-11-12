import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Verify Meta's X-Hub-Signature-256 header: "sha256=" + hex HMAC-SHA256 of the
 * raw request body keyed with the app secret. Must be computed over the exact
 * bytes received, before any JSON parsing.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  header: string | undefined | null,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith(PREFIX)) return false;
  const given = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

export function signWebhookBody(rawBody: Uint8Array | string, appSecret: string): string {
  return PREFIX + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
