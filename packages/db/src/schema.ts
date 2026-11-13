import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Encrypted-at-rest values (NPWP, phone numbers) are stored as opaque bytes.
// Encryption happens in application code before insert (spec 8.2).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Money: integer rupiah, never floats. mode "bigint" keeps full precision in JS.
const rupiah = (name: string) => bigint(name, { mode: "bigint" });

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const accountType = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);
export const userRole = pgEnum("user_role", ["owner", "staff", "accountant"]);
export const contactKind = pgEnum("contact_kind", ["customer", "supplier", "other"]);
export const entrySource = pgEnum("entry_source", [
  "text",
  "photo",
  "voice",
  "manual",
  "system",
]);
export const journalStatus = pgEnum("journal_status", ["posted"]);
export const captureStatus = pgEnum("capture_status", [
  "received",
  "extracted",
  "awaiting_confirmation",
  "confirmed",
  "cancelled",
  "failed",
]);
export const summaryFrequency = pgEnum("summary_frequency", ["daily", "weekly"]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const reportFormat = pgEnum("report_format", ["pdf", "xlsx"]);

/**
 * Tax rules as data (spec 8): one row per version of a regime. Not
 * tenant-scoped; the app role can only read it. Rates and thresholds change
 * by inserting a new version (close the old one with valid_to), never in code.
 */
export const taxProfiles = pgTable(
  "tax_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regime: text("regime").notNull(),
    name: text("name").notNull(),
    /** Basis points on gross turnover: 50 = 0.5%. */
    rateBps: integer("rate_bps").notNull(),
    annualExemptThresholdIdr: rupiah("annual_exempt_threshold_idr").notNull(),
    annualTurnoverCapIdr: rupiah("annual_turnover_cap_idr"),
    paymentDueDay: smallint("payment_due_day").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("tax_profiles_regime_idx").on(t.regime, t.validFrom),
    check("tax_profiles_rate", sql`${t.rateBps} between 0 and 10000`),
    check("tax_profiles_threshold", sql`${t.annualExemptThresholdIdr} >= 0`),
    check("tax_profiles_cap", sql`${t.annualTurnoverCapIdr} is null or ${t.annualTurnoverCapIdr} > 0`),
    check("tax_profiles_due_day", sql`${t.paymentDueDay} between 1 and 28`),
    check("tax_profiles_validity", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  // HMAC of the E.164 number for lookup; the number itself is encrypted.
  ownerPhoneHash: text("owner_phone_hash").notNull().unique(),
  ownerPhoneEnc: bytea("owner_phone_enc").notNull(),
  npwpEnc: bytea("npwp_enc"),
  /** The regime this business files under (any version of it); null = the configured default regime. */
  taxProfileId: uuid("tax_profile_id").references(() => taxProfiles.id),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  plan: text("plan").notNull().default("trial"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    phoneHash: text("phone_hash").notNull().unique(),
    phoneEnc: bytea("phone_enc").notNull(),
    role: userRole("role").notNull().default("owner"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    createdAt: createdAt(),
  },
  (t) => [index("users_business_idx").on(t.businessId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("accounts_business_code_uq").on(t.businessId, t.code),
    // Target for composite FKs so lines can't reference another tenant's account.
    unique("accounts_id_business_uq").on(t.id, t.businessId),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    name: text("name").notNull(),
    phoneHash: text("phone_hash"),
    phoneEnc: bytea("phone_enc"),
    kind: contactKind("kind").notNull().default("other"),
    createdAt: createdAt(),
  },
  (t) => [
    index("contacts_business_idx").on(t.businessId),
    unique("contacts_id_business_uq").on(t.id, t.businessId),
  ],
);

export const journals = pgTable(
  "journals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    date: date("date", { mode: "string" }).notNull(),
    description: text("description").notNull(),
    source: entrySource("source").notNull(),
    status: journalStatus("status").notNull().default("posted"),
    reversesJournalId: uuid("reverses_journal_id"),
    // Caller-supplied key (e.g. capture id) so a double-tapped "OK" posts once.
    idempotencyKey: text("idempotency_key"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("journals_business_date_idx").on(t.businessId, t.date),
    unique("journals_id_business_uq").on(t.id, t.businessId),
    foreignKey({
      name: "journals_reverses_fk",
      columns: [t.reversesJournalId, t.businessId],
      foreignColumns: [t.id, t.businessId],
    }),
    // A journal can be reversed at most once.
    uniqueIndex("journals_reverses_uq")
      .on(t.reversesJournalId)
      .where(sql`${t.reversesJournalId} is not null`),
    uniqueIndex("journals_idempotency_uq")
      .on(t.businessId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check("journals_not_self_reversal", sql`${t.reversesJournalId} is distinct from ${t.id}`),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id").notNull(),
    journalId: uuid("journal_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: rupiah("debit").notNull().default(sql`0`),
    credit: rupiah("credit").notNull().default(sql`0`),
    contactId: uuid("contact_id"),
    memo: text("memo"),
  },
  (t) => [
    index("journal_lines_journal_idx").on(t.journalId),
    index("journal_lines_business_account_idx").on(t.businessId, t.accountId),
    unique("journal_lines_journal_line_uq").on(t.journalId, t.lineNo),
    foreignKey({
      name: "journal_lines_journal_fk",
      columns: [t.journalId, t.businessId],
      foreignColumns: [journals.id, journals.businessId],
    }),
    foreignKey({
      name: "journal_lines_account_fk",
      columns: [t.accountId, t.businessId],
      foreignColumns: [accounts.id, accounts.businessId],
    }),
    foreignKey({
      name: "journal_lines_contact_fk",
      columns: [t.contactId, t.businessId],
      foreignColumns: [contacts.id, contacts.businessId],
    }),
    check("journal_lines_non_negative", sql`${t.debit} >= 0 and ${t.credit} >= 0`),
    // Exactly one side is positive on every line.
    check("journal_lines_one_side", sql`(${t.debit} > 0) <> (${t.credit} > 0)`),
  ],
);

export const captures = pgTable(
  "captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    waMessageId: text("wa_message_id"),
    source: entrySource("source").notNull(),
    mediaUrl: text("media_url"),
    rawText: text("raw_text"),
    transcript: text("transcript"),
    extractionJson: jsonb("extraction_json"),
    // Model confidence score (0..1), not money.
    confidence: real("confidence"),
    status: captureStatus("status").notNull().default("received"),
    modelVersion: text("model_version"),
    journalId: uuid("journal_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("captures_business_status_idx").on(t.businessId, t.status),
    uniqueIndex("captures_wa_message_uq")
      .on(t.waMessageId)
      .where(sql`${t.waMessageId} is not null`),
    foreignKey({
      name: "captures_journal_fk",
      columns: [t.journalId, t.businessId],
      foreignColumns: [journals.id, journals.businessId],
    }),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    direction: messageDirection("direction").notNull(),
    waMessageId: text("wa_message_id"),
    type: text("type").notNull(),
    body: text("body"),
    templateName: text("template_name"),
    costIdr: rupiah("cost_idr"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_business_created_idx").on(t.businessId, t.createdAt),
    uniqueIndex("messages_wa_message_uq")
      .on(t.waMessageId)
      .where(sql`${t.waMessageId} is not null`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_business_at_idx").on(t.businessId, t.at)],
);

/**
 * Per-business learned categories ("ayam" -> HPP / Bahan baku). Written when
 * the owner confirms an entry; checked before asking the model.
 */
export const categoryRules = pgTable(
  "category_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    /** Normalized keyword, lowercase. */
    pattern: text("pattern").notNull(),
    /** Entry kind the rule applies to ("sale" or "expense"). */
    kind: text("kind").notNull(),
    accountId: uuid("account_id").notNull(),
    hits: integer("hits").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("category_rules_business_pattern_kind_uq").on(t.businessId, t.pattern, t.kind),
    foreignKey({
      name: "category_rules_account_fk",
      columns: [t.accountId, t.businessId],
      foreignColumns: [accounts.id, accounts.businessId],
    }),
  ],
);

/**
 * Daily / weekly summary push (F9), one row per business. The worker's
 * scheduler finds rows with next_run_at due, sends the summary template, and
 * moves next_run_at forward; last_period_key makes each period send once.
 */
export const summarySchedules = pgTable(
  "summary_schedules",
  {
    businessId: uuid("business_id")
      .primaryKey()
      .references(() => businesses.id),
    frequency: summaryFrequency("frequency").notNull(),
    /** "HH:MM" in the business's timezone. */
    localTime: text("local_time").notNull(),
    /** Weekly only: 0 = Sunday ... 6 = Saturday. */
    weekday: smallint("weekday"),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastPeriodKey: text("last_period_key"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("summary_schedules_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`),
    check("summary_schedules_time_format", sql`${t.localTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check(
      "summary_schedules_weekday",
      sql`(${t.frequency} = 'daily' and ${t.weekday} is null) or (${t.frequency} = 'weekly' and ${t.weekday} between 0 and 6)`,
    ),
  ],
);

/**
 * Generated monthly reports (F10). The file is kept with the row so the
 * signed download link serves exactly what was generated (and audited);
 * reports are small. Insert-only for the app.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    kind: text("kind").notNull(),
    format: reportFormat("format").notNull(),
    periodFrom: date("period_from", { mode: "string" }).notNull(),
    periodTo: date("period_to", { mode: "string" }).notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    content: bytea("content").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("reports_business_created_idx").on(t.businessId, t.createdAt),
    check("reports_period", sql`${t.periodTo} >= ${t.periodFrom}`),
  ],
);

/**
 * Month-end tax message (Flow E), one row per business. Like
 * summary_schedules: the scheduler finds due rows, sends last month's
 * estimate, and moves next_run_at to the next month; last_period makes each
 * month send once.
 */
export const taxNoticeSchedules = pgTable(
  "tax_notice_schedules",
  {
    businessId: uuid("business_id")
      .primaryKey()
      .references(() => businesses.id),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /** "YYYY-MM" of the last month a notice went out for. */
    lastPeriod: text("last_period"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tax_notice_schedules_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`)],
);

/**
 * One-time magic links for the dashboard (spec: magic-link login sent via
 * WhatsApp). Only the SHA-256 of the token is stored; the token itself is in
 * the WhatsApp message. Found before the tenant is known through the
 * login_lookup policy, like phone lookup.
 */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("login_tokens_business_idx").on(t.businessId)],
);

/** Dashboard sessions (spec 8.2: expire after 7 days). Cookie holds the token; only its hash is stored. */
export const dashboardSessions = pgTable(
  "dashboard_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sessionHash: text("session_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("dashboard_sessions_business_idx").on(t.businessId)],
);

/**
 * Staff access to the admin console. Not tenant-scoped: an admin is a phone
 * number on the ADMIN_PHONES allowlist, not a business user. Hashes only.
 */
export const adminLoginTokens = pgTable("admin_login_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  phoneHash: text("phone_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const adminSessions = pgTable("admin_sessions", {
  sessionHash: text("session_hash").primaryKey(),
  phoneHash: text("phone_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const reviewVerdict = pgEnum("review_verdict", ["correct", "wrong", "unclear"]);

/**
 * Manual review queue outcomes (admin console). Insert-only: a capture's
 * latest review is its current state. Feeds new eval cases (spec 7.5).
 */
export const captureReviews = pgTable(
  "capture_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    captureId: uuid("capture_id").notNull(),
    verdict: reviewVerdict("verdict").notNull(),
    /** Fields the model got wrong, e.g. ["amount", "counterparty"]. */
    wrongFields: jsonb("wrong_fields").notNull().default([]),
    note: text("note"),
    /** Admin phone hash. */
    reviewer: text("reviewer").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("capture_reviews_capture_idx").on(t.captureId, t.reviewedAt),
    foreignKey({ name: "capture_reviews_capture_fk", columns: [t.captureId], foreignColumns: [captures.id] }),
  ],
);

/**
 * Raw inbound WhatsApp messages, written by the webhook before the sender is
 * resolved to a business. Not tenant-scoped (sender may not be onboarded yet),
 * so it has no RLS; only the webhook/worker roles can touch it.
 * Primary key on wa_message_id is the webhook idempotency guard.
 */
export const waInbound = pgTable("wa_inbound", {
  waMessageId: text("wa_message_id").primaryKey(),
  fromPhone: text("from_phone").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
  // Set by the worker in the same transaction as the state change it caused.
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/**
 * In-progress WhatsApp onboarding (F1), keyed by phone hash. Exists before the
 * business does, so it is not tenant-scoped; deleted when the business is created.
 */
export const onboardingSessions = pgTable("onboarding_sessions", {
  phoneHash: text("phone_hash").primaryKey(),
  step: text("step").notNull(),
  data: jsonb("data").notNull().default({}),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every table that carries business_id and is protected by RLS. */
export const TENANT_TABLES = [
  "businesses",
  "users",
  "accounts",
  "contacts",
  "journals",
  "journal_lines",
  "captures",
  "messages",
  "audit_log",
  "category_rules",
  "summary_schedules",
  "reports",
  "tax_notice_schedules",
  "login_tokens",
  "dashboard_sessions",
  "capture_reviews",
] as const;
