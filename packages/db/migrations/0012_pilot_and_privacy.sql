CREATE TABLE "erasure_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_counts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pilot_invites" (
	"code" text PRIMARY KEY NOT NULL,
	"cohort" text NOT NULL,
	"max_uses" integer NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_invites_code" CHECK ("pilot_invites"."code" ~ '^[A-Z0-9]{4,12}$'),
	CONSTRAINT "pilot_invites_uses" CHECK ("pilot_invites"."uses" >= 0 and "pilot_invites"."uses" <= "pilot_invites"."max_uses"),
	CONSTRAINT "pilot_invites_max" CHECK ("pilot_invites"."max_uses" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_idr" bigint NOT NULL,
	"wa_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_cost" CHECK ("usage_events"."cost_micro_idr" >= 0),
	CONSTRAINT "usage_events_kind" CHECK ("usage_events"."kind" in ('llm', 'stt'))
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cohort" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "invite_code" text;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_requests_due_idx" ON "erasure_requests" USING btree ("scheduled_for") WHERE "erasure_requests"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "usage_events_business_created_idx" ON "usage_events" USING btree ("business_id","created_at");