import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8787),
  /** Meta app secret; signs every webhook POST (X-Hub-Signature-256). */
  WA_APP_SECRET: z.string().min(16),
  /** Shared token checked during Meta's GET subscription handshake. */
  WA_VERIFY_TOKEN: z.string().min(8),
  /** Max accepted webhook body, bytes. */
  WA_WEBHOOK_MAX_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** base64, >= 32 bytes; same value as the worker's. Verifies report and evidence links. */
  REPORT_LINK_KEY: z.string().min(1),
  /** Where the worker keeps original photos and voice notes (local disk until the Cloud Storage adapter lands). */
  MEDIA_DIR: z.string().min(1),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return EnvSchema.parse(env);
}
