CREATE TYPE "public"."report_format" AS ENUM('pdf', 'xlsx');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"format" "report_format" NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_period" CHECK ("reports"."period_to" >= "reports"."period_from")
);
--> statement-breakpoint
CREATE TABLE "tax_notice_schedules" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_period" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regime" text NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"annual_exempt_threshold_idr" bigint NOT NULL,
	"annual_turnover_cap_idr" bigint,
	"payment_due_day" smallint NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_profiles_rate" CHECK ("tax_profiles"."rate_bps" between 0 and 10000),
	CONSTRAINT "tax_profiles_threshold" CHECK ("tax_profiles"."annual_exempt_threshold_idr" >= 0),
	CONSTRAINT "tax_profiles_cap" CHECK ("tax_profiles"."annual_turnover_cap_idr" is null or "tax_profiles"."annual_turnover_cap_idr" > 0),
	CONSTRAINT "tax_profiles_due_day" CHECK ("tax_profiles"."payment_due_day" between 1 and 28),
	CONSTRAINT "tax_profiles_validity" CHECK ("tax_profiles"."valid_to" is null or "tax_profiles"."valid_to" >= "tax_profiles"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_notice_schedules" ADD CONSTRAINT "tax_notice_schedules_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_business_created_idx" ON "reports" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "tax_notice_schedules_due_idx" ON "tax_notice_schedules" USING btree ("next_run_at") WHERE "tax_notice_schedules"."enabled";--> statement-breakpoint
CREATE INDEX "tax_profiles_regime_idx" ON "tax_profiles" USING btree ("regime","valid_from");--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "public"."tax_profiles"("id") ON DELETE no action ON UPDATE no action;