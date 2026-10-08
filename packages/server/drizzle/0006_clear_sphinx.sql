CREATE TABLE "auth_sessions" (
	"credential_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("user_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "teams_id_namespace_ck" CHECK ("teams"."id" ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "users_id_github_numeric_ck" CHECK ("users"."id" ~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "revoked_at" text;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_team_idx" ON "memberships" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_personal_owner_idx" ON "teams" USING btree ("owner_user_id") WHERE "teams"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "machines_team_idx" ON "machines" USING btree ("team_id");