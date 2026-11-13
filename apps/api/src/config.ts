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
  /** Public base URL of this API, used in report download links from the dashboard. */
  PUBLIC_BASE_URL: z.string().url(),
  REPORT_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  EVIDENCE_LINK_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /** The dashboard's origin (e.g. https://app.bukuwa.id); other origins can't change data. */
  WEB_ORIGIN: z.string().url(),
  DASHBOARD_SESSION_DAYS: z.coerce.number().int().positive().default(7),
  ADMIN_SESSION_HOURS: z.coerce.number().int().positive().default(12),
  /** "false" only for plain-http local development. */
  COOKIE_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  TAX_DEFAULT_REGIME: z.string().min(1).default("umkm_final_individual"),
  /** Captures below this extraction confidence go to the admin review queue. */
  REVIEW_CONFIDENCE_BELOW: z.coerce.number().min(0).max(1).default(0.7),
  /** Most chart buckets one P&L request may return. */
  PNL_MAX_BUCKETS: z.coerce.number().int().positive().default(120),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return EnvSchema.parse(env);
}
