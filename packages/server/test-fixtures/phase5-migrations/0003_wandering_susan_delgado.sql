ALTER TABLE "loops" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "goal_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "completed_at" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "completion_reason" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "task_file_sync_attempted_at" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "task_file_sync_error" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "run_leases" ADD COLUMN "terminal_protocol_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_leases" ADD COLUMN "goal_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD CONSTRAINT "loops_completion_ck" CHECK (("loops"."completed_at" IS NULL AND "loops"."completion_reason" IS NULL)
          OR ("loops"."goal" IS NOT NULL AND "loops"."completed_at" IS NOT NULL
              AND "loops"."completion_reason" IS NOT NULL AND "loops"."enabled" = false));