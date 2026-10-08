/**
 * Phase 5 Batch 1 slice 2 — AM group: migration and dormancy tests for
 * 0005 (ADR-010 决策 16, plan §2 数据模型与迁移).
 *
 *  AM1  Frozen Phase 4 migrations (0000–0004) build the OLD database with
 *       representative rows in all four heart tables; the production
 *       migration runner upgrades it: every old column item-equal, every new
 *       column at its safe default, the artifact tables created EMPTY.
 *       (+freeze pin: the fixture is byte-identical to the committed
 *       0000–0004 migrations — "不修改历史迁移" is machine-checked.)
 *  AM2  The upgraded database behaves with Phase 4 semantics: a v0 lease
 *       finalizes through the REAL coordinator report, poll never emits
 *       watch (even when the request carries watchDigest), and the claim
 *       capability gate is unchanged. Old loops stay unconfigured.
 *  AM5  Close/reopen, repeated migration and session recovery: an
 *       artifact_sync_sessions row survives restart cycles item-equal, the
 *       journal stays at seven entries, tables/indexes are never duplicated.
 *
 * AM3 (fresh-DB round-trips) and AM4 (unique keys) live in
 * phase5-schema.test.ts; AM6 (config transaction) in artifact/config.test.ts.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, test } from "vitest";

import { machineIdFromToken, sha256 } from "@loopzhb/protocol/node";

import { createRunCoordinator } from "../coordinator/index.js";
import { closeDb, createDb, runMigrations, type DbHandle } from "../db/index.js";
import { artifactSyncSessions, loops, runLeases, runs } from "../db/schema.js";
import { FakeClock, testDeps } from "../testkit/index.js";

const FIXTURE_DIR = path.resolve("test-fixtures/phase4-migrations");
const LIVE_DIR = path.resolve("drizzle");

const MACHINE_TOKEN = "dk_phase4_machine";
const LEASE_TOKEN = "rk_phase4_legacy";
const MACHINE_ID = machineIdFromToken(MACHINE_TOKEN);

const handles: DbHandle[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Build the OLD (Phase 4) database from the frozen fixture migrations. */
async function openPhase4Db(): Promise<DbHandle> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-phase5-m-${process.pid}-`));
  tempDirs.push(dataDir);
  const handle = await createDb({ dataDir });
  handles.push(handle);
  await migrate(handle.db, { migrationsFolder: FIXTURE_DIR });
  return handle;
}

/** Representative Phase 4 rows in every heart table — written with raw SQL so
 *  only OLD columns may be named (a typo here fails loudly against the old
 *  DDL; the artifact columns must NOT exist in this schema). */
async function seedPhase4Data(handle: DbHandle): Promise<void> {
  await handle.client.exec(`
    INSERT INTO machines (
      id, name, hostname, platform, arch, daemon_version, token_hash, roots, last_seen, capabilities, created_at
    ) VALUES (
      '${MACHINE_ID}', 'mbp', 'mbp.local', 'darwin', 'arm64', '0.1.0',
      '${sha256(MACHINE_TOKEN)}', '["/home/user"]'::jsonb, '2026-09-27T00:00:00.000Z',
      '["terminal-journal-v1"]'::jsonb, '2026-07-01T00:00:00.000Z'
    );

    INSERT INTO loops (
      id, machine_id, name, workdir, task_file, task_file_content, task_file_synced_at,
      workflow, model, allow_control, agent, enabled, state,
      cron, timezone, next_run_at, schedule_revision, schedule_activated_at, last_scheduled_at,
      goal, goal_revision, completed_at, completion_reason,
      task_file_sync_attempted_at, task_file_sync_error,
      created_at, updated_at, revision
    ) VALUES
      (
        'loop-old', '${MACHINE_ID}', 'nightly', '/home/user/project', '/home/user/project/TASK.md',
        E'# TASK\\nspec v1', '2026-09-27T00:00:00.000Z',
        NULL, NULL, true, 'claude-code', true, '{"cursor":3}'::jsonb,
        '0 3 * * *', 'Asia/Shanghai', NULL, 7, '2026-08-20T00:00:00.000Z', '2026-09-27T03:00:00.000Z',
        'triage the queue', 2, NULL, NULL,
        '2026-09-27T00:00:01.000Z', NULL,
        '2026-07-01T00:00:00.000Z', '2026-09-27T00:00:00.000Z', 5
      ),
      (
        'loop-done', '${MACHINE_ID}', 'finished', NULL, NULL,
        NULL, NULL,
        NULL, NULL, true, 'claude-code', false, NULL,
        NULL, 'UTC', NULL, 0, NULL, NULL,
        'ship it', 1, '2026-09-20T00:00:00.000Z', 'goal met',
        NULL, NULL,
        '2026-07-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 3
      );

    INSERT INTO runs (
      id, loop_id, machine_id, phase, role, ts, outcome, status, message, duration_ms,
      error, state, session_id, cost_usd, usage, artifacts, transcript, progress
    ) VALUES
      (
        'run-done', 'loop-old', '${MACHINE_ID}', 'done', 'exec', '2026-09-27T03:00:05.000Z',
        'exec', 'new', 'found 2 issues', 42000,
        NULL, '{"seen":2}'::jsonb, 'sess_1', 0.42, '{"inputTokens":12000}'::jsonb,
        '[{"path":"a.ts","kind":"edited"}]'::jsonb, '[{"kind":"text","text":"hi"}]'::jsonb, NULL
      ),
      (
        'run-running', 'loop-old', '${MACHINE_ID}', 'running', 'exec', '2026-09-28T00:00:00.000Z',
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '{"step":2,"label":"working","at":"2026-09-28T00:00:01.000Z"}'::jsonb
      );

    INSERT INTO run_leases (
      token_hash, run_id, loop_id, machine_id, role,
      allow_control, can_set_ui, can_set_schema, can_set_workflow, can_finish,
      state, expires_at, terminal_protocol_version, goal_revision, created_at
    ) VALUES (
      '${sha256(LEASE_TOKEN)}', 'run-running', 'loop-old', '${MACHINE_ID}', 'exec',
      false, false, false, false, false,
      'active', NULL, 0, 0, '2026-09-28T00:00:00.000Z'
    );
  `);
}

/** The full Phase 4 (0000–0004) column sets — everything the old DB knows.
 *  The Phase 5 artifact columns are deliberately NOT here. */
const PHASE4_LOOP_COLUMNS = [
  "id", "machine_id", "name", "workdir", "task_file", "task_file_content", "task_file_synced_at",
  "workflow", "model", "allow_control", "agent", "enabled", "state",
  "cron", "timezone", "next_run_at", "schedule_revision", "schedule_activated_at", "last_scheduled_at",
  "goal", "goal_revision", "completed_at", "completion_reason",
  "task_file_sync_attempted_at", "task_file_sync_error",
  "created_at", "updated_at", "revision",
] as const;

const PHASE4_RUN_COLUMNS = [
  "id", "loop_id", "machine_id", "phase", "role", "ts", "outcome", "status", "message",
  "duration_ms", "error", "state", "session_id", "cost_usd", "usage", "artifacts", "transcript", "progress",
] as const;

const PHASE4_LEASE_COLUMNS = [
  "token_hash", "run_id", "loop_id", "machine_id", "role",
  "allow_control", "can_set_ui", "can_set_schema", "can_set_workflow", "can_finish",
  "state", "expires_at", "terminal_protocol_version", "goal_revision", "created_at",
] as const;

const PHASE4_MACHINE_COLUMNS = [
  "id", "name", "hostname", "platform", "arch", "daemon_version", "token_hash", "roots",
  "last_seen", "capabilities", "created_at",
] as const;

async function selectColumns(handle: DbHandle, table: string, columns: readonly string[]): Promise<unknown[]> {
  const result = await handle.client.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`);
  return result.rows;
}

/** Close, reopen the file database, run the production migration runner. */
async function upgradeInPlace(handle: DbHandle): Promise<DbHandle> {
  await closeDb(handle);
  handles.splice(handles.indexOf(handle), 1);
  const upgraded = await createDb({ dataDir: handle.dataDir! });
  handles.push(upgraded);
  await runMigrations(upgraded);
  return upgraded;
}

describe("AM: Phase 5 migration 0005 and dormancy", () => {
  test("AM1: a Phase 4 file database upgrades losslessly; artifact columns default; artifact tables empty", async () => {
    const handle = await openPhase4Db();
    await seedPhase4Data(handle);

    // Pre-upgrade snapshots (old columns only — the new ones don't exist yet).
    const before = {
      loops: await selectColumns(handle, "loops", PHASE4_LOOP_COLUMNS),
      runs: await selectColumns(handle, "runs", PHASE4_RUN_COLUMNS),
      leases: await selectColumns(handle, "run_leases", PHASE4_LEASE_COLUMNS),
      machines: await selectColumns(handle, "machines", PHASE4_MACHINE_COLUMNS),
    };

    const upgraded = await upgradeInPlace(handle);

    // Every Phase 4 column is item-equal after the upgrade.
    expect(await selectColumns(upgraded, "loops", PHASE4_LOOP_COLUMNS)).toEqual(before.loops);
    expect(await selectColumns(upgraded, "runs", PHASE4_RUN_COLUMNS)).toEqual(before.runs);
    expect(await selectColumns(upgraded, "run_leases", PHASE4_LEASE_COLUMNS)).toEqual(before.leases);
    expect(await selectColumns(upgraded, "machines", PHASE4_MACHINE_COLUMNS)).toEqual(before.machines);

    // New columns land on their safe defaults — old loops stay UNCONFIGURED.
    for (const id of ["loop-old", "loop-done"]) {
      const [loop] = await upgraded.db.select().from(loops).where(eq(loops.id, id));
      expect([
        loop!.artifactDir,
        loop!.artifactConfigRevision,
        loop!.artifactManifestRevision,
        loop!.artifactManifestId,
        loop!.artifactSyncAttemptedAt,
        loop!.artifactSyncSucceededAt,
        loop!.artifactSyncError,
      ]).toEqual([null, 0, 0, null, null, null, null]);
    }
    for (const id of ["run-done", "run-running"]) {
      const [run] = await upgraded.db.select().from(runs).where(eq(runs.id, id));
      expect([run!.artifactSnapshotId, run!.artifactSyncError]).toEqual([null, null]);
    }

    // The artifact tables exist and are EMPTY — the migration fabricates no
    // manifests, sessions or blobs (plan §2: 不自动配置目录、不生成 manifest).
    const tables = await upgraded.client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename like 'artifact%' order by tablename",
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      "artifact_blobs",
      "artifact_manifests",
      "artifact_sync_sessions",
    ]);
    for (const table of ["artifact_blobs", "artifact_manifests", "artifact_sync_sessions"]) {
      const { rows } = await upgraded.client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(rows[0]!.count)).toBe(0);
    }

    // Journal: 0000–0006, each applied once.
    const journal = await upgraded.client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(Number(journal.rows[0]!.count)).toBe(7);
  });

  test("AM1-freeze: the phase4 fixture is byte-identical to the committed 0000–0004 migrations", async () => {
    // The fixture must BE the committed Phase 4 migrations — a hand-edit of
    // either side breaks the "frozen old database" meaning of AM1 (the
    // phase3 fixture has no such pin; this one does).
    for (const tag of ["0000_safe_the_fallen", "0001_wooden_domino", "0002_wild_millenium_guard", "0003_wandering_susan_delgado", "0004_icy_black_crow"]) {
      const [frozen, live] = await Promise.all([
        readFile(path.join(FIXTURE_DIR, `${tag}.sql`), "utf8"),
        readFile(path.join(LIVE_DIR, `${tag}.sql`), "utf8"),
      ]);
      expect(frozen, tag).toBe(live);
    }
    const journal = JSON.parse(await readFile(path.join(FIXTURE_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4]);
  });

  test("AM2: the upgraded database behaves with Phase 4 semantics (report / poll dormancy)", async () => {
    const handle = await openPhase4Db();
    await seedPhase4Data(handle);
    const upgraded = await upgradeInPlace(handle);

    // After migration 0006, the machine row has teamId=NULL (unclaimed).
    // Set it to a valid team id so the poll gate passes (Phase 5 Batch 3
    // slice 3: auto-registration removed; unclaimed machines → 401).
    await upgraded.client.query(`UPDATE machines SET team_id = 't-0123456789abcdef' WHERE id = '${MACHINE_ID}'`);

    const coordinator = createRunCoordinator(testDeps(upgraded.db, new FakeClock()));

    // (i) The upgraded v0 lease finalizes through the REAL coordinator report
    // with Phase 4 semantics — and binds NO artifact snapshot.
    const result = await coordinator.report(LEASE_TOKEN, { ok: true, message: "wrapped up" });
    expect(result).toEqual({ ok: true });
    const [run] = await upgraded.db.select().from(runs).where(eq(runs.id, "run-running"));
    expect(run.phase).toBe("done");
    expect(run.outcome).toBe("exec");
    expect(run.artifactSnapshotId).toBeNull();
    expect(run.artifactSyncError).toBeNull();
    expect(await upgraded.db.select().from(runLeases)).toHaveLength(0);
    const [loop] = await upgraded.db.select().from(loops).where(eq(loops.id, "loop-old"));
    expect(loop.taskFileContent).toBe("# TASK\nspec v1");
    expect(loop.artifactDir).toBeNull();

    // (ii) Poll carrying watchDigest returns EXACTLY the idle shape — no
    // watch/watchDigest keys (AD2 crossover on an upgraded database).
    await expect(coordinator.poll(MACHINE_TOKEN, { watchDigest: "w-1" })).resolves.toEqual({ deliveries: [] });

    // (iii) The claim capability gate is unchanged: a pending run for a
    // capability-less machine still gets the requiredCapabilities response.
    await upgraded.client.query(`UPDATE machines SET capabilities = NULL WHERE id = '${MACHINE_ID}'`);
    await upgraded.db.insert(runs).values({
      id: "run-pending",
      loopId: "loop-old",
      machineId: MACHINE_ID,
      phase: "pending",
      role: "exec",
      ts: "2026-09-28T01:00:00.000Z",
    });
    await expect(coordinator.poll(MACHINE_TOKEN, { watchDigest: "w-1" })).resolves.toEqual({
      deliveries: [],
      requiredCapabilities: ["terminal-journal-v1"],
    });
  });

  test("AM5: close/reopen, repeated migration and session recovery keep everything stable", async () => {
    const handle = await openPhase4Db();
    await seedPhase4Data(handle);
    let upgraded = await upgradeInPlace(handle);

    // A pending session row written on the upgraded database.
    const session = {
      id: "sync-1",
      namespaceId: "ns-1",
      machineId: MACHINE_ID,
      loopId: "loop-old",
      requestId: "req-1",
      configRevision: 0,
      baseManifestRevision: 0,
      normalizedManifest: [{ path: "dist/app.js", hash: "a".repeat(64), size: 1200 }],
      payloadFingerprint: "f".repeat(64),
      negotiatedHashes: ["a".repeat(64)],
      createdAt: "2026-09-28T00:00:00.000Z",
      expiresAt: "2026-09-28T01:00:00.000Z",
    };
    await upgraded.db.insert(artifactSyncSessions).values(session);

    // Two full restart cycles, plus an extra migrate on the live handle.
    for (let i = 0; i < 2; i++) {
      upgraded = await upgradeInPlace(upgraded);
    }
    await runMigrations(upgraded);

    // The session row survived — item-equal (session recovery, AM5).
    const [back] = await upgraded.db.select().from(artifactSyncSessions);
    expect(back).toEqual({ ...session, receipt: null });

    // Journal stays at seven; artifact tables and pre-existing indexes are
    // never duplicated.
    const journal = await upgraded.client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(Number(journal.rows[0]!.count)).toBe(7);
    const tables = await upgraded.client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM pg_tables WHERE schemaname = 'public' AND tablename = 'artifact_sync_sessions'",
    );
    expect(Number(tables.rows[0]!.count)).toBe(1);
    const indexes = await upgraded.client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM pg_indexes WHERE tablename = 'loops' AND indexname = 'loops_active_schedule_idx'",
    );
    expect(Number(indexes.rows[0]!.count)).toBe(1);

    // The pre-existing heart rows survived the restart cycles untouched.
    expect(await selectColumns(upgraded, "loops", PHASE4_LOOP_COLUMNS)).toHaveLength(2);
    const [oldLoop] = await upgraded.db.select().from(loops).where(eq(loops.id, "loop-old"));
    expect(oldLoop.goal).toBe("triage the queue");
    expect(oldLoop.revision).toBe(5);
  });
});
