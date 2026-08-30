/**
 * Phase 4 Batch 1 — M group: migration and schema tests (ADR-009 决策 3/11).
 *
 *  M1  Frozen Phase 3 migrations (0000–0002) build the OLD database with
 *      representative rows in all four tables; the production migration runner
 *      upgrades it: every old column item-equal, every new column at its safe
 *      default, zero runs created/touched.
 *  M2  An upgraded database's running run + v0 lease still finalizes through
 *      the REAL coordinator report with Phase 3 semantics (the lease row's
 *      terminalProtocolVersion is the migration default 0).
 *  M3  A fresh database round-trips the new fields; omitted columns land on
 *      the same defaults the SQL DDL declares.
 *  M4  loops_completion_ck accepts every legal completion combination and
 *      rejects every half-completed one.
 *  M5  Repeating close/reopen/migrate keeps journal rows, the CHECK, data and
 *      indexes unique and unchanged.
 *  M6  The migration never fabricates lifecycle effects: run phases, lease
 *      states and loop schedule/state/task-file snapshots are untouched.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, test } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { createRunCoordinator } from "../coordinator/index.js";
import { closeDb, createDb, openMigratedDb, runMigrations, type DbHandle } from "../db/index.js";
import { loops, machines, runLeases, runs } from "../db/schema.js";
import { FakeClock, testDeps } from "../testkit/index.js";

const FIXTURE_DIR = path.resolve("test-fixtures/phase3-migrations");

const handles: DbHandle[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Build the OLD (Phase 3) database from the frozen fixture migrations. */
async function openPhase3Db(): Promise<DbHandle> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-phase4-m-${process.pid}-`));
  tempDirs.push(dataDir);
  const handle = await createDb({ dataDir });
  handles.push(handle);
  await migrate(handle.db, { migrationsFolder: FIXTURE_DIR });
  return handle;
}

/** Representative Phase 3 rows in every table — written with raw SQL so only
 *  OLD columns may be named (a typo here fails loudly against the old DDL). */
async function seedPhase3Data(handle: DbHandle): Promise<void> {
  await handle.client.exec(`
    INSERT INTO machines (
      id, name, hostname, platform, arch, daemon_version, token_hash, roots, last_seen, created_at
    ) VALUES (
      'm-0123456789abcdef', 'mbp', 'mbp.local', 'darwin', 'arm64', '0.1.0',
      'hash-machine-1', '["/home/user"]'::jsonb, '2026-08-29T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );

    INSERT INTO loops (
      id, machine_id, name, workdir, task_file, task_file_content, task_file_synced_at,
      workflow, model, allow_control, agent, enabled, state,
      cron, timezone, next_run_at, schedule_revision, schedule_activated_at, last_scheduled_at,
      created_at, updated_at
    ) VALUES (
      'loop-old', 'm-0123456789abcdef', 'nightly', '/home/user/project', '/home/user/project/TASK.md',
      E'# TASK\\nspec v1', '2026-08-28T00:00:00.000Z',
      NULL, NULL, true, 'claude-code', true, '{"cursor":3}'::jsonb,
      '0 3 * * *', 'Asia/Shanghai', NULL, 7, '2026-08-20T00:00:00.000Z', '2026-08-29T03:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
    );

    INSERT INTO runs (
      id, loop_id, machine_id, phase, role, ts, outcome, status, message, duration_ms,
      error, state, session_id, cost_usd, usage, artifacts, transcript, progress
    ) VALUES
      (
        'run-done', 'loop-old', 'm-0123456789abcdef', 'done', 'exec', '2026-08-29T03:00:05.000Z',
        'exec', 'new', 'found 2 issues', 42000,
        NULL, '{"seen":2}'::jsonb, 'sess_1', 0.42, '{"inputTokens":12000}'::jsonb,
        '[{"path":"a.ts","kind":"edited"}]'::jsonb, '[{"kind":"text","text":"hi"}]'::jsonb, NULL
      ),
      (
        'run-running', 'loop-old', 'm-0123456789abcdef', 'running', 'exec', '2026-08-30T00:00:00.000Z',
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '{"step":2,"label":"working","at":"2026-08-30T00:00:01.000Z"}'::jsonb
      );

    INSERT INTO run_leases (
      token_hash, run_id, loop_id, machine_id, role,
      allow_control, can_set_ui, can_set_schema, can_set_workflow, can_finish,
      state, expires_at, created_at
    ) VALUES (
      '${sha256("rk_phase3_legacy")}', 'run-running', 'loop-old', 'm-0123456789abcdef', 'exec',
      false, false, false, false, false,
      'active', NULL, '2026-08-30T00:00:00.000Z'
    );
  `);
}

const OLD_LOOP_COLUMNS = [
  "id", "machine_id", "name", "workdir", "task_file", "task_file_content", "task_file_synced_at",
  "workflow", "model", "allow_control", "agent", "enabled", "state",
  "cron", "timezone", "next_run_at", "schedule_revision", "schedule_activated_at", "last_scheduled_at",
  "created_at", "updated_at",
] as const;

const OLD_RUN_COLUMNS = [
  "id", "loop_id", "machine_id", "phase", "role", "ts", "outcome", "status", "message",
  "duration_ms", "error", "state", "session_id", "cost_usd", "usage", "artifacts", "transcript", "progress",
] as const;

const OLD_LEASE_COLUMNS = [
  "token_hash", "run_id", "loop_id", "machine_id", "role",
  "allow_control", "can_set_ui", "can_set_schema", "can_set_workflow", "can_finish",
  "state", "expires_at", "created_at",
] as const;

const OLD_MACHINE_COLUMNS = [
  "id", "name", "hostname", "platform", "arch", "daemon_version", "token_hash", "roots",
  "last_seen", "created_at",
] as const;

async function selectColumns(handle: DbHandle, table: string, columns: readonly string[]): Promise<unknown[]> {
  const result = await handle.client.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`);
  return result.rows;
}

describe("M: Phase 4 migration and schema", () => {
  test("M1: old database upgrades losslessly; new columns get safe defaults; no runs touched", async () => {
    const handle = await openPhase3Db();
    await seedPhase3Data(handle);

    // Pre-upgrade snapshots (old columns only — the new ones don't exist yet).
    const before = {
      loops: await selectColumns(handle, "loops", OLD_LOOP_COLUMNS),
      runs: await selectColumns(handle, "runs", OLD_RUN_COLUMNS),
      leases: await selectColumns(handle, "run_leases", OLD_LEASE_COLUMNS),
      machines: await selectColumns(handle, "machines", OLD_MACHINE_COLUMNS),
    };

    // Simulate the production upgrade: close, reopen the file database, run
    // the production migration runner (0003 applies).
    await closeDb(handle);
    handles.splice(handles.indexOf(handle), 1);
    const upgraded = await createDb({ dataDir: handle.dataDir! });
    handles.push(upgraded);
    await runMigrations(upgraded);

    // Every old column is item-equal after the upgrade.
    expect(await selectColumns(upgraded, "loops", OLD_LOOP_COLUMNS)).toEqual(before.loops);
    expect(await selectColumns(upgraded, "runs", OLD_RUN_COLUMNS)).toEqual(before.runs);
    expect(await selectColumns(upgraded, "run_leases", OLD_LEASE_COLUMNS)).toEqual(before.leases);
    expect(await selectColumns(upgraded, "machines", OLD_MACHINE_COLUMNS)).toEqual(before.machines);

    // New columns land on their safe defaults.
    const [loop] = await upgraded.db.select().from(loops).where(eq(loops.id, "loop-old"));
    expect(loop.goal).toBeNull();
    expect(loop.goalRevision).toBe(0);
    expect(loop.completedAt).toBeNull();
    expect(loop.completionReason).toBeNull();
    expect(loop.taskFileSyncAttemptedAt).toBeNull();
    expect(loop.taskFileSyncError).toBeNull();

    const [machine] = await upgraded.db.select().from(machines).where(eq(machines.id, "m-0123456789abcdef"));
    expect(machine.capabilities).toBeNull();

    const [lease] = await upgraded.db
      .select()
      .from(runLeases)
      .where(eq(runLeases.tokenHash, sha256("rk_phase3_legacy")));
    expect(lease.terminalProtocolVersion).toBe(0);
    expect(lease.goalRevision).toBe(0);

    // The migration created or finished NOTHING.
    expect(await upgraded.db.select().from(runs)).toHaveLength(2);
    expect((await upgraded.db.select().from(runs)).map((r) => r.phase).sort()).toEqual(["done", "running"]);
  });

  test("M2: an upgraded v0 lease still finalizes through the real coordinator report", async () => {
    const handle = await openPhase3Db();
    await seedPhase3Data(handle);
    await closeDb(handle);
    handles.splice(handles.indexOf(handle), 1);
    const upgraded = await createDb({ dataDir: handle.dataDir! });
    handles.push(upgraded);
    await runMigrations(upgraded);

    const coordinator = createRunCoordinator(testDeps(upgraded.db, new FakeClock()));
    const result = await coordinator.report("rk_phase3_legacy", { ok: true, message: "wrapped up" });
    expect(result).toEqual({ ok: true });

    const [run] = await upgraded.db.select().from(runs).where(eq(runs.id, "run-running"));
    expect(run.phase).toBe("done");
    expect(run.outcome).toBe("exec");
    expect(run.message).toBe("wrapped up");

    // Lease consumed; the loop's Phase 4 fields were NOT touched by a v0 report.
    expect(await upgraded.db.select().from(runLeases)).toHaveLength(0);
    const [loop] = await upgraded.db.select().from(loops).where(eq(loops.id, "loop-old"));
    expect(loop.state).toEqual({ cursor: 3 });
    expect(loop.taskFileContent).toBe("# TASK\nspec v1");
    expect(loop.taskFileSyncAttemptedAt).toBeNull();
    expect(loop.completedAt).toBeNull();
  });

  test("M3: fresh database round-trips new fields; omitted columns land on DDL defaults", async () => {
    const handle = await openMigratedDb();
    handles.push(handle);
    const now = "2026-08-30T00:00:00.000Z";

    // Defaults: omit every Phase 4 column entirely.
    await handle.db.insert(machines).values({ id: "m-1", name: "", tokenHash: "h", createdAt: now });
    await handle.db.insert(loops).values({ id: "l-1", machineId: "m-1", createdAt: now, updatedAt: now });
    await handle.db.insert(runs).values({ id: "r-1", loopId: "l-1", machineId: "m-1", phase: "pending", role: "exec", ts: now });
    await handle.db.insert(runLeases).values({
      tokenHash: "th-1", runId: "r-1", loopId: "l-1", machineId: "m-1", role: "exec", createdAt: now,
    });

    const [machine] = await handle.db.select().from(machines);
    expect(machine.capabilities).toBeNull();
    const [loop] = await handle.db.select().from(loops);
    expect([loop.goal, loop.completedAt, loop.completionReason, loop.taskFileSyncAttemptedAt, loop.taskFileSyncError])
      .toEqual([null, null, null, null, null]);
    expect(loop.goalRevision).toBe(0);
    const [lease] = await handle.db.select().from(runLeases);
    expect(lease.terminalProtocolVersion).toBe(0);
    expect(lease.goalRevision).toBe(0);

    // Drizzle's inferred insert defaults agree with the SQL DDL: omitted
    // Phase 4 columns ride the `default` placeholder, so only the explicitly
    // provided values become bound parameters (the DDL owns the 0s).
    const sql = handle.db
      .insert(runLeases)
      .values({ tokenHash: "th-2", runId: "r-1", loopId: "l-1", machineId: "m-1", role: "exec", createdAt: now })
      .toSQL();
    expect(sql.params).toHaveLength(6);

    // Round-trip: every new field writes and reads back verbatim.
    await handle.db
      .update(loops)
      .set({
        goal: "triage the queue",
        goalRevision: 3,
        completedAt: now,
        completionReason: "goal met",
        enabled: false,
        taskFileSyncAttemptedAt: now,
        taskFileSyncError: "changed",
      })
      .where(eq(loops.id, "l-1"));
    await handle.db.update(machines).set({ capabilities: ["terminal-journal-v1"] }).where(eq(machines.id, "m-1"));
    await handle.db
      .update(runLeases)
      .set({ terminalProtocolVersion: 1, goalRevision: 3 })
      .where(eq(runLeases.tokenHash, "th-1"));

    const [rtLoop] = await handle.db.select().from(loops);
    expect(rtLoop).toMatchObject({
      goal: "triage the queue",
      goalRevision: 3,
      completedAt: now,
      completionReason: "goal met",
      enabled: false,
      taskFileSyncAttemptedAt: now,
      taskFileSyncError: "changed",
    });
    const [rtMachine] = await handle.db.select().from(machines);
    expect(rtMachine.capabilities).toEqual(["terminal-journal-v1"]);
    const [rtLease] = await handle.db.select().from(runLeases).where(eq(runLeases.tokenHash, "th-1"));
    expect([rtLease.terminalProtocolVersion, rtLease.goalRevision]).toEqual([1, 3]);
  });

  test("M4: loops_completion_ck accepts legal combinations and rejects half-completed states", async () => {
    const handle = await openMigratedDb();
    handles.push(handle);
    const base = `
      INSERT INTO loops (id, machine_id, enabled, created_at, updated_at,
        goal, completed_at, completion_reason)
      VALUES ($1, 'm-1', $2, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', $3, $4, $5)
    `;
    const insert = async (
      id: string,
      enabled: boolean,
      goal: string | null,
      completedAt: string | null,
      reason: string | null,
    ) => handle.client.query(base, [id, enabled, goal, completedAt, reason]);

    // Legal: untouched (all completion fields null), any goal/enabled combo.
    await insert("ok-open", true, null, null, null);
    await insert("ok-closed", true, "g", null, null);
    await insert("ok-paused", false, "g", null, null);
    // Legal: the full completion triple with enabled=false.
    await insert("ok-completed", false, "g", "2026-08-30T01:00:00.000Z", "goal met");

    const expectCheckViolation = async (
      id: string,
      enabled: boolean,
      goal: string | null,
      completedAt: string | null,
      reason: string | null,
    ) => {
      await expect(insert(id, enabled, goal, completedAt, reason)).rejects.toThrow(/loops_completion_ck/);
    };

    // Illegal: reason without timestamp, timestamp without reason, completed
    // without a goal, completed but still enabled.
    await expectCheckViolation("bad-reason-only", true, null, null, "goal met");
    await expectCheckViolation("bad-ts-only", true, "g", "2026-08-30T01:00:00.000Z", null);
    await expectCheckViolation("bad-no-goal", false, null, "2026-08-30T01:00:00.000Z", "goal met");
    await expectCheckViolation("bad-still-enabled", true, "g", "2026-08-30T01:00:00.000Z", "goal met");

    const all = await handle.db.select({ id: loops.id }).from(loops);
    expect(all.map((r) => r.id).sort()).toEqual(["ok-closed", "ok-completed", "ok-open", "ok-paused"]);
  });

  test("M5: repeated close/reopen/migrate keeps journal, CHECK, data and indexes unchanged", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-phase4-m5-${process.pid}-`));
    tempDirs.push(dataDir);
    let handle = await openMigratedDb({ dataDir });
    handles.push(handle);

    await handle.db.insert(loops).values({
      id: "l-m5", machineId: "m-1", goal: "g", completedAt: "2026-08-30T00:00:00.000Z",
      completionReason: "goal met", enabled: false, createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
    const [before] = await handle.db.select().from(loops);

    // Two full restart cycles, plus an extra migrate on the live handle.
    for (let i = 0; i < 2; i++) {
      await closeDb(handle);
      handles.splice(handles.indexOf(handle), 1);
      handle = await openMigratedDb({ dataDir });
      handles.push(handle);
    }
    await runMigrations(handle);

    const [after] = await handle.db.select().from(loops);
    expect(after).toEqual(before);

    // Migration journal has exactly four entries (0000–0003), applied once each.
    const journal = await handle.client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(Number(journal.rows[0]!.count)).toBe(4);

    // Exactly one completion CHECK exists.
    const checks = await handle.client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM pg_constraint WHERE conname = 'loops_completion_ck'",
    );
    expect(Number(checks.rows[0]!.count)).toBe(1);

    // Pre-existing indexes were not duplicated.
    const indexes = await handle.client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM pg_indexes WHERE tablename = 'loops' AND indexname = 'loops_active_schedule_idx'",
    );
    expect(Number(indexes.rows[0]!.count)).toBe(1);
  });

  test("M6: migration fabricates no lifecycle effects (runs, leases, schedule, state intact)", async () => {
    const handle = await openPhase3Db();
    await seedPhase3Data(handle);

    const before = {
      runs: await selectColumns(handle, "runs", OLD_RUN_COLUMNS),
      leases: await selectColumns(handle, "run_leases", OLD_LEASE_COLUMNS),
      loops: await selectColumns(handle, "loops", OLD_LOOP_COLUMNS),
    };

    await closeDb(handle);
    handles.splice(handles.indexOf(handle), 1);
    const upgraded = await createDb({ dataDir: handle.dataDir! });
    handles.push(upgraded);
    await runMigrations(upgraded);

    // Same run count/phases, same lease state, same schedule/state/task-file
    // snapshot — item-equal on every old column.
    expect(await selectColumns(upgraded, "runs", OLD_RUN_COLUMNS)).toEqual(before.runs);
    expect(await selectColumns(upgraded, "run_leases", OLD_LEASE_COLUMNS)).toEqual(before.leases);
    expect(await selectColumns(upgraded, "loops", OLD_LOOP_COLUMNS)).toEqual(before.loops);
  });
});
