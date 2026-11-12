import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  WA_PHONE_NUMBER_ID: z.string().min(1),
  WA_ACCESS_TOKEN: z.string().min(1),
  WA_GRAPH_API_VERSION: z.string().default("v21.0"),
  /** base64, >= 32 bytes */
  PII_HMAC_KEY: z.string().min(1),
  /** base64, exactly 32 bytes */
  PII_ENC_KEY: z.string().min(1),
  PRIVACY_POLICY_URL: z.string().url(),
  /** Version of the privacy notice the owner consents to; stored on users.consent_version. */
  CONSENT_VERSION: z.string().min(1),
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  DEFAULT_TIMEZONE: z.string().default("Asia/Jakarta"),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return EnvSchema.parse(env);
}
