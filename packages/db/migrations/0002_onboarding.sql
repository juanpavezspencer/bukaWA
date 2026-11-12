CREATE TABLE "onboarding_sessions" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"step" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_inbound" ADD COLUMN "processed_at" timestamp with time zone;