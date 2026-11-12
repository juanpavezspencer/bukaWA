import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "../src/whatsapp/signature.js";

const secret = "test-app-secret-0123456789";
const body = new TextEncoder().encode('{"hello":"dunia"}');

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(body, signWebhookBody(body, secret), secret)).toBe(true);
  });

  it("rejects missing, malformed or wrong signatures", () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, "", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abcd", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifyWebhookSignature(body, signWebhookBody(body, "another-secret-xxxxxxxx"), secret)).toBe(false);
  });

  it("rejects a valid signature for a different body", () => {
    const tampered = new TextEncoder().encode('{"hello":"world"}');
    expect(verifyWebhookSignature(tampered, signWebhookBody(body, secret), secret)).toBe(false);
  });
});
