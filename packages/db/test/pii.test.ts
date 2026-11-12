import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPii, encryptPii, hashPii, piiKeysFromBase64, toE164 } from "../src/pii.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));

describe("pii", () => {
  it("round-trips encryption and never stores plaintext", () => {
    const blob = encryptPii(keys, "+6281234567890");
    expect(blob.includes(Buffer.from("6281234567890"))).toBe(false);
    expect(decryptPii(keys, blob)).toBe("+6281234567890");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptPii(keys, "x").equals(encryptPii(keys, "x"))).toBe(false);
  });

  it("detects tampering", () => {
    const blob = encryptPii(keys, "+6281234567890");
    blob[blob.length - 1]! ^= 1;
    expect(() => decryptPii(keys, blob)).toThrow();
  });

  it("hashes deterministically per key", () => {
    expect(hashPii(keys, "+62811")).toBe(hashPii(keys, "+62811"));
    const other = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
    expect(hashPii(other, "+62811")).not.toBe(hashPii(keys, "+62811"));
  });

  it("normalizes WhatsApp ids to E.164 and rejects junk", () => {
    expect(toE164("6281234567890")).toBe("+6281234567890");
    expect(() => toE164("123")).toThrow();
  });

  it("rejects short keys", () => {
    expect(() => piiKeysFromBase64(randomBytes(8).toString("base64"), randomBytes(32).toString("base64"))).toThrow();
  });
});
