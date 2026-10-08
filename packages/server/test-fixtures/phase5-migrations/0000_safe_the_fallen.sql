CREATE TABLE "loops" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"name" text,
	"workdir" text,
	"task_file" text,
	"task_file_content" text,
	"task_file_synced_at" text,
	"workflow" text,
	"model" text,
	"allow_control" boolean DEFAULT true NOT NULL,
	"agent" text DEFAULT 'claude-code' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"platform" text,
	"arch" text,
	"daemon_version" text,
	"token_hash" text NOT NULL,
	"roots" jsonb,
	"last_seen" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_leases" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"role" text NOT NULL,
	"allow_control" boolean DEFAULT false NOT NULL,
	"can_set_ui" boolean DEFAULT false NOT NULL,
	"can_set_schema" boolean DEFAULT false NOT NULL,
	"can_set_workflow" boolean DEFAULT false NOT NULL,
	"can_finish" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"phase" text NOT NULL,
	"role" text NOT NULL,
	"ts" text NOT NULL,
	"outcome" text,
	"status" text,
	"message" text,
	"duration_ms" integer,
	"error" text,
	"state" jsonb,
	"session_id" text,
	"cost_usd" double precision,
	"usage" jsonb,
	"artifacts" jsonb,
	"transcript" jsonb,
	"progress" jsonb
);
--> statement-breakpoint
CREATE INDEX "loops_machine_idx" ON "loops" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "run_leases_run_idx" ON "run_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_leases_loop_idx" ON "run_leases" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "runs_loop_idx" ON "runs" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "runs_loop_ts_idx" ON "runs" USING btree ("loop_id","ts");--> statement-breakpoint
CREATE INDEX "runs_phase_idx" ON "runs" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "runs_pending_idx" ON "runs" USING btree ("machine_id") WHERE "runs"."phase" = 'pending';