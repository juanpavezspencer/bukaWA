import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * App-level protection for phone numbers and NPWP/NIK (spec 8.2).
 * - hash: keyed HMAC-SHA256, deterministic, used for lookups and unique indexes.
 * - encrypt: AES-256-GCM, random IV. Layout: version(1) | iv(12) | tag(16) | ciphertext.
 * Keys come from the secret store via config; never hard-coded.
 */
export interface PiiKeys {
  hmacKey: Buffer;
  encKey: Buffer; // 32 bytes
}

const VERSION = 1;

export function piiKeysFromBase64(hmacKeyB64: string, encKeyB64: string): PiiKeys {
  const hmacKey = Buffer.from(hmacKeyB64, "base64");
  const encKey = Buffer.from(encKeyB64, "base64");
  if (hmacKey.length < 32) throw new Error("PII HMAC key must be at least 32 bytes");
  if (encKey.length !== 32) throw new Error("PII encryption key must be exactly 32 bytes");
  return { hmacKey, encKey };
}

/** WhatsApp sends "6281234567890"; store and hash the canonical E.164 form. */
export function toE164(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("invalid phone number");
  return `+${digits}`;
}

export function hashPii(keys: PiiKeys, value: string): string {
  return createHmac("sha256", keys.hmacKey).update(value).digest("hex");
}

export function encryptPii(keys: PiiKeys, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptPii(keys: PiiKeys, blob: Buffer): string {
  if (blob[0] !== VERSION) throw new Error(`unsupported PII ciphertext version ${blob[0]}`);
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", keys.encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8");
}
