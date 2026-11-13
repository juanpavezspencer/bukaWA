CREATE TYPE "public"."summary_frequency" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TABLE "summary_schedules" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"frequency" "summary_frequency" NOT NULL,
	"local_time" text NOT NULL,
	"weekday" smallint,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_period_key" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_schedules_time_format" CHECK ("summary_schedules"."local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "summary_schedules_weekday" CHECK (("summary_schedules"."frequency" = 'daily' and "summary_schedules"."weekday" is null) or ("summary_schedules"."frequency" = 'weekly' and "summary_schedules"."weekday" between 0 and 6))
);
--> statement-breakpoint
ALTER TABLE "summary_schedules" ADD CONSTRAINT "summary_schedules_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "summary_schedules_due_idx" ON "summary_schedules" USING btree ("next_run_at") WHERE "summary_schedules"."enabled";