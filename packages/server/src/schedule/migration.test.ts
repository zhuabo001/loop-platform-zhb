/**
 * Phase 3 Batch 1 — M group: Migration and schema tests.
 *
 * Test suite verifies:
 *  - M1: Old database upgrade (old Loop retains values, new fields get safe defaults)
 *  - M2: New database defaults (cron=null, timezone='UTC', scheduleRevision=0)
 *  - M3: All new fields are writable and readable
 *  - M4: Partial index exists with correct predicate
 *  - M5: Idempotent migration (no errors, no duplicates, data unchanged)
 *  - M6: next_run_at remains null after migration and config changes
 *
 * All tests assert runs table remains empty (no accidental automatic execution).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, test } from "vitest";

import { closeDb, createDb, openMigratedDb, runMigrations } from "../db/index.js";
import type { Loop } from "../db/schema.js";
import { loops, runs } from "../db/schema.js";

describe("M: Migration and schema", () => {
  test("M1: old database upgrade preserves existing fields and adds safe defaults", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-phase3-m1-${process.pid}-`));
    let handle = await createDb({ dataDir });

    try {
      const fixtureDir = path.resolve("test-fixtures/old-migrations");
      await migrate(handle.db, { migrationsFolder: fixtureDir });

      // Insert a Loop with old schema (no schedule fields)
      await handle.client.exec(`
        INSERT INTO loops (
          id, machine_id, name, workdir, task_file, task_file_content,
          task_file_synced_at, workflow, model, allow_control, agent,
          enabled, state, created_at, updated_at
        ) VALUES (
          'loop-old',
          'm-test',
          'Old Loop',
          '/home/user/project',
          '/home/user/project/loop.md',
          'Old content',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          true,
          'claude-code',
          true,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `);

      // Verify old state before applying new migration
      const beforeResult = await handle.client.query<{
        id: string;
        name: string;
        workdir: string;
        enabled: boolean;
      }>("SELECT id, name, workdir, enabled FROM loops WHERE id = 'loop-old'");

      expect(beforeResult.rows).toHaveLength(1);
      expect(beforeResult.rows[0].name).toBe("Old Loop");
      expect(beforeResult.rows[0].workdir).toBe("/home/user/project");
      expect(beforeResult.rows[0].enabled).toBe(true);

      // Simulate an application upgrade: close the old process, reopen the same
      // file-backed database, then let the production migration runner apply 0002.
      await closeDb(handle);
      handle = await createDb({ dataDir });
      await runMigrations(handle);

      // Re-read using Drizzle ORM
      const [result] = await handle.db.select().from(loops).where(eq(loops.id, "loop-old"));

      expect(result).toBeDefined();
      expect(result.id).toBe("loop-old");
      expect(result.name).toBe("Old Loop");
      expect(result.workdir).toBe("/home/user/project");
      expect(result.taskFile).toBe("/home/user/project/loop.md");
      expect(result.taskFileContent).toBe("Old content");
      expect(result.enabled).toBe(true);

      // New fields have safe defaults
      expect(result.cron).toBeNull();
      expect(result.timezone).toBe("UTC");
      expect(result.scheduleRevision).toBe(0);
      expect(result.scheduleActivatedAt).toBeNull();
      expect(result.lastScheduledAt).toBeNull();
      expect(result.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("M2: new database gets correct defaults on insert", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();

      await handle.db.insert(loops).values({
        id: "loop-new",
        machineId: "m-test",
        name: "New Loop",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        // Explicitly NOT setting schedule fields to test defaults
      });

      const [result] = await handle.db.select().from(loops).where(eq(loops.id, "loop-new"));

      expect(result).toBeDefined();
      expect(result.cron).toBeNull();
      expect(result.timezone).toBe("UTC");
      expect(result.scheduleRevision).toBe(0);
      expect(result.scheduleActivatedAt).toBeNull();
      expect(result.lastScheduledAt).toBeNull();
      expect(result.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("M3: all new fields are writable and readable", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();
      const activatedAt = "2026-08-25T10:00:00.000Z";
      const lastScheduled = "2026-08-25T11:00:00.000Z";
      const nextRun = "2026-08-25T12:00:00.000Z";

      await handle.db.insert(loops).values({
        id: "loop-fields",
        machineId: "m-test",
        name: "Field Test Loop",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        scheduleRevision: 5,
        scheduleActivatedAt: activatedAt,
        lastScheduledAt: lastScheduled,
        nextRunAt: nextRun,
      });

      const [result] = await handle.db.select().from(loops).where(eq(loops.id, "loop-fields"));

      expect(result).toBeDefined();
      expect(result.cron).toBe("0 9 * * *");
      expect(result.timezone).toBe("Asia/Shanghai");
      expect(result.scheduleRevision).toBe(5);
      expect(result.scheduleActivatedAt).toBe(activatedAt);
      expect(result.lastScheduledAt).toBe(lastScheduled);
      expect(result.nextRunAt).toBe(nextRun);

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("M4: partial index exists with correct predicate", async () => {
    const handle = await openMigratedDb();

    try {
      // Query pg_indexes to verify the index exists
      const result = await handle.client.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'loops' AND indexname = 'loops_active_schedule_idx'",
      );

      expect(result.rows).toHaveLength(1);
      const index = result.rows[0];
      expect(index.indexname).toBe("loops_active_schedule_idx");

      // Verify it's a partial index with the correct WHERE clause
      expect(index.indexdef).toContain("WHERE");
      expect(index.indexdef).toContain("enabled = true");
      expect(index.indexdef).toContain("cron IS NOT NULL");

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("M5: idempotent migration (no errors, no duplicates, data unchanged)", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-phase3-m5-${process.pid}-`));
    let handle = await openMigratedDb({ dataDir });

    try {
      const now = new Date().toISOString();

      // Insert test data
      await handle.db.insert(loops).values({
        id: "loop-idempotent",
        machineId: "m-test",
        name: "Idempotent Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 10 * * *",
        timezone: "America/New_York",
        scheduleRevision: 3,
        scheduleActivatedAt: now,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      const [before] = await handle.db.select().from(loops).where(eq(loops.id, "loop-idempotent"));

      // Close and reopen the same file-backed database, as production does on
      // restart, then repeat the migration runner once more on the live handle.
      await closeDb(handle);
      handle = await openMigratedDb({ dataDir });
      await runMigrations(handle);

      const [after] = await handle.db.select().from(loops).where(eq(loops.id, "loop-idempotent"));

      // Data should be unchanged
      expect(after).toEqual(before);

      // Check no duplicate indexes were created
      const indexResult = await handle.client.query<{ count: string }>(
        "SELECT COUNT(*) as count FROM pg_indexes WHERE tablename = 'loops' AND indexname = 'loops_active_schedule_idx'",
      );
      expect(Number(indexResult.rows[0].count)).toBe(1);

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("M6: next_run_at remains null after migration and config changes", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();

      // Insert Loop with schedule configuration
      await handle.db.insert(loops).values({
        id: "loop-nextrun",
        machineId: "m-test",
        name: "Next Run Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 12 * * *",
        timezone: "UTC",
        scheduleRevision: 0,
        scheduleActivatedAt: now,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      // Modify the Loop's schedule configuration
      await handle.db
        .update(loops)
        .set({
          cron: "30 14 * * *",
          scheduleRevision: 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(loops.id, "loop-nextrun"));

      const [result] = await handle.db.select().from(loops).where(eq(loops.id, "loop-nextrun"));

      // next_run_at must remain null (write-closed in Phase 3)
      expect(result.nextRunAt).toBeNull();
      expect(result.cron).toBe("30 14 * * *");
      expect(result.scheduleRevision).toBe(1);

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });
});
