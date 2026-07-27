import { defineConfig } from "drizzle-kit";

// `db:generate` only diffs the schema → SQL (no DB needed), so this config needs
// no dbCredentials: the embedded pglite tier migrates IN-PROCESS at boot
// (src/db/index.ts `runMigrations`), and there is no hosted Postgres tier yet —
// when one lands (postgres-js over DATABASE_URL, ADR-003), add credentials here
// the way the reference does (direct/session URL only, never a txn pooler).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts"],
  out: "./drizzle",
});
