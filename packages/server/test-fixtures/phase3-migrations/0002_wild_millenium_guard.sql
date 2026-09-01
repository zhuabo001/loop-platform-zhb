ALTER TABLE "loops" ADD COLUMN "cron" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "next_run_at" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "schedule_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "schedule_activated_at" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "last_scheduled_at" text;--> statement-breakpoint
CREATE INDEX "loops_active_schedule_idx" ON "loops" USING btree ("id") WHERE "loops"."enabled" = true AND "loops"."cron" IS NOT NULL;