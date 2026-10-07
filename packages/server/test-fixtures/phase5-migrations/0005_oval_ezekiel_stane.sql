CREATE TABLE "artifact_blobs" (
	"namespace_id" text NOT NULL,
	"hash" text NOT NULL,
	"size" integer NOT NULL,
	"verified_at" text NOT NULL,
	CONSTRAINT "artifact_blobs_pkey" PRIMARY KEY("namespace_id","hash")
);
--> statement-breakpoint
CREATE TABLE "artifact_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"config_revision" integer NOT NULL,
	"manifest_revision" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"committed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_sync_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"request_id" text NOT NULL,
	"config_revision" integer NOT NULL,
	"base_manifest_revision" integer NOT NULL,
	"normalized_manifest" jsonb NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"negotiated_hashes" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"receipt" jsonb
);
--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_dir" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_config_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_manifest_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_manifest_id" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_sync_attempted_at" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_sync_succeeded_at" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "artifact_sync_error" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "artifact_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "artifact_sync_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_manifests_loop_revision_idx" ON "artifact_manifests" USING btree ("loop_id","manifest_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_sync_sessions_request_idx" ON "artifact_sync_sessions" USING btree ("namespace_id","machine_id","request_id");