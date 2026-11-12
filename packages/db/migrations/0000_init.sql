CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('received', 'extracted', 'awaiting_confirmation', 'confirmed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('customer', 'supplier', 'other');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('text', 'photo', 'voice', 'manual', 'system');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('posted');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'staff', 'accountant');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_business_code_uq" UNIQUE("business_id","code"),
	CONSTRAINT "accounts_id_business_uq" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"owner_phone_hash" text NOT NULL,
	"owner_phone_enc" "bytea" NOT NULL,
	"npwp_enc" "bytea",
	"tax_profile_id" uuid,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_owner_phone_hash_unique" UNIQUE("owner_phone_hash")
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"wa_message_id" text,
	"source" "entry_source" NOT NULL,
	"media_url" text,
	"raw_text" text,
	"transcript" text,
	"extraction_json" jsonb,
	"confidence" real,
	"status" "capture_status" DEFAULT 'received' NOT NULL,
	"model_version" text,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_hash" text,
	"phone_enc" "bytea",
	"kind" "contact_kind" DEFAULT 'other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_business_uq" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"contact_id" uuid,
	"memo" text,
	CONSTRAINT "journal_lines_journal_line_uq" UNIQUE("journal_id","line_no"),
	CONSTRAINT "journal_lines_non_negative" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0),
	CONSTRAINT "journal_lines_one_side" CHECK (("journal_lines"."debit" > 0) <> ("journal_lines"."credit" > 0))
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"source" "entry_source" NOT NULL,
	"status" "journal_status" DEFAULT 'posted' NOT NULL,
	"reverses_journal_id" uuid,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_id_business_uq" UNIQUE("id","business_id"),
	CONSTRAINT "journals_not_self_reversal" CHECK ("journals"."reverses_journal_id" is distinct from "journals"."id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"wa_message_id" text,
	"type" text NOT NULL,
	"body" text,
	"template_name" text,
	"cost_idr" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_enc" "bytea" NOT NULL,
	"role" "user_role" DEFAULT 'owner' NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_hash_unique" UNIQUE("phone_hash")
);
--> statement-breakpoint
CREATE TABLE "wa_inbound" (
	"wa_message_id" text PRIMARY KEY NOT NULL,
	"from_phone" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_journal_fk" FOREIGN KEY ("journal_id","business_id") REFERENCES "public"."journals"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_fk" FOREIGN KEY ("journal_id","business_id") REFERENCES "public"."journals"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("account_id","business_id") REFERENCES "public"."accounts"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_contact_fk" FOREIGN KEY ("contact_id","business_id") REFERENCES "public"."contacts"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_reverses_fk" FOREIGN KEY ("reverses_journal_id","business_id") REFERENCES "public"."journals"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_business_at_idx" ON "audit_log" USING btree ("business_id","at");--> statement-breakpoint
CREATE INDEX "captures_business_status_idx" ON "captures" USING btree ("business_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "captures_wa_message_uq" ON "captures" USING btree ("wa_message_id") WHERE "captures"."wa_message_id" is not null;--> statement-breakpoint
CREATE INDEX "contacts_business_idx" ON "contacts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "journal_lines_journal_idx" ON "journal_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journal_lines_business_account_idx" ON "journal_lines" USING btree ("business_id","account_id");--> statement-breakpoint
CREATE INDEX "journals_business_date_idx" ON "journals" USING btree ("business_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_reverses_uq" ON "journals" USING btree ("reverses_journal_id") WHERE "journals"."reverses_journal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journals_idempotency_uq" ON "journals" USING btree ("business_id","idempotency_key") WHERE "journals"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_business_created_idx" ON "messages" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_wa_message_uq" ON "messages" USING btree ("wa_message_id") WHERE "messages"."wa_message_id" is not null;--> statement-breakpoint
CREATE INDEX "users_business_idx" ON "users" USING btree ("business_id");