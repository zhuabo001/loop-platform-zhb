/**
 * Phase 5 Batch 3 slice 1 — LM group: migration 0006 (identity schema,
 * ADR-011) upgrades a Batch 2 (0005) database without touching history.
 *
 *  LM1  Frozen Batch 2 migrations (0000–0005) build the OLD database with
 *       representative rows in all SEVEN business tables — including a run
 *       bound to a committed manifest and a committed sync session receipt.
 *       The production migration runner upgrades it: every old column
 *       item-equal, machines.team_id/revoked_at land NULL (every pre-Batch-3
 *       machine becomes an Unclaimed Machine — the migration never
 *       auto-claims, ADR-011 决策 7), the four identity tables are created
 *       EMPTY, and the artifact reference chain (snapshot id, manifest
 *       entries, session receipt) survives byte-identical.
 *  LM1-freeze  The fixture is byte-identical to the committed 0000–0005
 *       migrations — "不修改历史迁移" is machine-checked.
 *  LM2  Identity rows (EVERY column, full-row snapshots) and all seven old
 *       business tables survive two close/reopen cycles plus a repeated
 *       migration item-equal; the journal stays at seven entries;
 *       tables/indexes are never duplicated.
 *
 * Fresh-DB round-trips and constraint arbitration live in
 * phase5-batch3-schema.test.ts (SC group).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, test } from "vitest";

import { machineIdFromToken, sha256 } from "@loopzhb/protocol/node";

import { closeDb, createDb, runMigrations, type DbHandle } from "../db/index.js";
import { authSessions, machines, memberships, teams, users } from "../db/schema.js";
import { seedClaimedMachine, seedPersonalIdentity, seedSession } from "../testkit/index.js";

const FIXTURE_DIR = path.resolve("test-fixtures/phase5-migrations");
const LIVE_DIR = path.resolve("drizzle");

const MACHINE_TOKEN = "dk_batch2_machine";
const LEASE_TOKEN = "rk_batch2_legacy";
const MACHINE_ID = machineIdFromToken(MACHINE_TOKEN);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const handles: DbHandle[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Build the OLD (Batch 2, 0000–0005) database from the frozen fixture. */
async function openBatch2Db(): Promise<DbHandle> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b3-m-${process.pid}-`));
  tempDirs.push(dataDir);
  const handle = await createDb({ dataDir });
  handles.push(handle);
  await migrate(handle.db, { migrationsFolder: FIXTURE_DIR });
  return handle;
}

/** Representative Batch 2 rows in every business table — written with raw SQL
 *  so only OLD columns may be named (a typo fails loudly against the old DDL;
 *  the identity tables and machines.team_id/revoked_at must NOT exist yet).
 *  The artifact reference chain is deliberately complete: a committed
 *  manifest, its blob rows, a pending and a committed sync session, and a run
 *  bound to the manifest via artifact_snapshot_id. */
async function seedBatch2Data(handle: DbHandle): Promise<void> {
  await handle.client.exec(`
    INSERT INTO machines (
      id, name, hostname, platform, arch, daemon_version, token_hash, roots, last_seen, capabilities, created_at
    ) VALUES (
      '${MACHINE_ID}', 'mbp', 'mbp.local', 'darwin', 'arm64', '0.1.0',
      '${sha256(MACHINE_TOKEN)}', '["/home/user"]'::jsonb, '2026-10-06T00:00:00.000Z',
      '["terminal-journal-v1","artifact-sync-v1"]'::jsonb, '2026-07-01T00:00:00.000Z'
    );

    INSERT INTO loops (
      id, machine_id, name, workdir, task_file, task_file_content, task_file_synced_at,
      workflow, model, allow_control, agent, enabled, state,
      cron, timezone, next_run_at, schedule_revision, schedule_activated_at, last_scheduled_at,
      goal, goal_revision, completed_at, completion_reason,
      task_file_sync_attempted_at, task_file_sync_error,
      artifact_dir, artifact_config_revision, artifact_manifest_revision, artifact_manifest_id,
      artifact_sync_attempted_at, artifact_sync_succeeded_at, artifact_sync_error,
      created_at, updated_at, revision
    ) VALUES
      (
        'loop-old', '${MACHINE_ID}', 'nightly', '/home/user/project', '/home/user/project/TASK.md',
        E'# TASK\\nspec v1', '2026-10-06T00:00:00.000Z',
        NULL, NULL, true, 'claude-code', true, '{"cursor":3}'::jsonb,
        '0 3 * * *', 'Asia/Shanghai', NULL, 7, '2026-08-20T00:00:00.000Z', '2026-10-06T03:00:00.000Z',
        'triage the queue', 2, NULL, NULL,
        '2026-10-06T00:00:01.000Z', NULL,
        'dist', 2, 1, 'amf-1',
        '2026-10-06T03:00:04.000Z', '2026-10-06T03:00:04.500Z', NULL,
        '2026-07-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 5
      ),
      (
        'loop-plain', '${MACHINE_ID}', 'manual', NULL, NULL,
        NULL, NULL,
        NULL, NULL, true, 'claude-code', false, NULL,
        NULL, 'UTC', NULL, 0, NULL, NULL,
        NULL, 0, NULL, NULL,
        NULL, NULL,
        NULL, 0, 0, NULL,
        NULL, NULL, NULL,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0
      );

    INSERT INTO runs (
      id, loop_id, machine_id, phase, role, ts, outcome, status, message, duration_ms,
      error, state, session_id, cost_usd, usage, artifacts, transcript, progress,
      artifact_snapshot_id, artifact_sync_error
    ) VALUES
      (
        'run-done', 'loop-old', '${MACHINE_ID}', 'done', 'exec', '2026-10-06T03:00:05.000Z',
        'exec', 'new', 'found 2 issues', 42000,
        NULL, '{"seen":2}'::jsonb, 'sess_1', 0.42, '{"inputTokens":12000}'::jsonb,
        '[{"path":"a.ts","kind":"edited"}]'::jsonb, '[{"kind":"text","text":"hi"}]'::jsonb, NULL,
        'amf-1', NULL
      ),
      (
        'run-running', 'loop-old', '${MACHINE_ID}', 'running', 'exec', '2026-10-07T00:00:00.000Z',
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '{"step":2,"label":"working","at":"2026-10-07T00:00:01.000Z"}'::jsonb,
        NULL, NULL
      );

    INSERT INTO run_leases (
      token_hash, run_id, loop_id, machine_id, role,
      allow_control, can_set_ui, can_set_schema, can_set_workflow, can_finish,
      state, expires_at, terminal_protocol_version, goal_revision, created_at
    ) VALUES (
      '${sha256(LEASE_TOKEN)}', 'run-running', 'loop-old', '${MACHINE_ID}', 'exec',
      false, false, false, false, false,
      'active', NULL, 0, 0, '2026-10-07T00:00:00.000Z'
    );

    INSERT INTO artifact_manifests (
      id, namespace_id, machine_id, loop_id, config_revision, manifest_revision,
      entries, file_count, total_bytes, committed_at
    ) VALUES (
      'amf-1', '${MACHINE_ID}', '${MACHINE_ID}', 'loop-old', 2, 1,
      '[{"path":"dist/app.js","hash":"${HASH_A}","size":1200},{"path":"docs/readme.md","hash":"${HASH_B}","size":40}]'::jsonb,
      2, 1240, '2026-10-06T03:00:04.500Z'
    );

    INSERT INTO artifact_sync_sessions (
      id, namespace_id, machine_id, loop_id, request_id, config_revision, base_manifest_revision,
      normalized_manifest, payload_fingerprint, negotiated_hashes, created_at, expires_at, receipt
    ) VALUES
      (
        'sync-committed', '${MACHINE_ID}', '${MACHINE_ID}', 'loop-old', 'req-1', 2, 0,
        '[{"path":"dist/app.js","hash":"${HASH_A}","size":1200},{"path":"docs/readme.md","hash":"${HASH_B}","size":40}]'::jsonb,
        '${"f".repeat(64)}', '["${HASH_A}","${HASH_B}"]'::jsonb,
        '2026-10-06T03:00:00.000Z', '2026-10-06T04:00:00.000Z',
        '{"artifactSnapshotId":"amf-1","manifestRevision":1}'::jsonb
      ),
      (
        'sync-pending', '${MACHINE_ID}', '${MACHINE_ID}', 'loop-old', 'req-2', 2, 1,
        '[]'::jsonb,
        '${"e".repeat(64)}', '[]'::jsonb,
        '2026-10-07T00:30:00.000Z', '2026-10-07T01:30:00.000Z', NULL
      );

    INSERT INTO artifact_blobs (namespace_id, hash, size, verified_at) VALUES
      ('${MACHINE_ID}', '${HASH_A}', 1200, '2026-10-06T03:00:02.000Z'),
      ('${MACHINE_ID}', '${HASH_B}', 40, '2026-10-06T03:00:03.000Z');
  `);
}

/** The full Batch 2 (0000–0005) column sets — everything the old DB knows.
 *  The Batch 3 identity columns/tables are deliberately NOT here. */
const BATCH2_MACHINE_COLUMNS = [
  "id", "name", "hostname", "platform", "arch", "daemon_version", "token_hash", "roots",
  "last_seen", "capabilities", "created_at",
] as const;

const BATCH2_LOOP_COLUMNS = [
  "id", "machine_id", "name", "workdir", "task_file", "task_file_content", "task_file_synced_at",
  "workflow", "model", "allow_control", "agent", "enabled", "state",
  "cron", "timezone", "next_run_at", "schedule_revision", "schedule_activated_at", "last_scheduled_at",
  "goal", "goal_revision", "completed_at", "completion_reason",
  "task_file_sync_attempted_at", "task_file_sync_error",
  "artifact_dir", "artifact_config_revision", "artifact_manifest_revision", "artifact_manifest_id",
  "artifact_sync_attempted_at", "artifact_sync_succeeded_at", "artifact_sync_error",
  "created_at", "updated_at", "revision",
] as const;

const BATCH2_RUN_COLUMNS = [
  "id", "loop_id", "machine_id", "phase", "role", "ts", "outcome", "status", "message",
  "duration_ms", "error", "state", "session_id", "cost_usd", "usage", "artifacts", "transcript", "progress",
  "artifact_snapshot_id", "artifact_sync_error",
] as const;

const BATCH2_LEASE_COLUMNS = [
  "token_hash", "run_id", "loop_id", "machine_id", "role",
  "allow_control", "can_set_ui", "can_set_schema", "can_set_workflow", "can_finish",
  "state", "expires_at", "terminal_protocol_version", "goal_revision", "created_at",
] as const;

const BATCH2_SESSION_COLUMNS = [
  "id", "namespace_id", "machine_id", "loop_id", "request_id", "config_revision", "base_manifest_revision",
  "normalized_manifest", "payload_fingerprint", "negotiated_hashes", "created_at", "expires_at", "receipt",
] as const;

const BATCH2_MANIFEST_COLUMNS = [
  "id", "namespace_id", "machine_id", "loop_id", "config_revision", "manifest_revision",
  "entries", "file_count", "total_bytes", "committed_at",
] as const;

const BATCH2_BLOB_COLUMNS = ["namespace_id", "hash", "size", "verified_at"] as const;

async function selectColumns(handle: DbHandle, table: string, columns: readonly string[]): Promise<unknown[]> {
  const result = await handle.client.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1, 2`);
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

describe("LM: Batch 3 migration 0006 — identity schema without touching history", () => {
  test("LM1: a Batch 2 file database upgrades losslessly; machines stay unclaimed; identity tables empty; artifact chain intact", async () => {
    const handle = await openBatch2Db();
    await seedBatch2Data(handle);

    // Pre-upgrade snapshots (old columns only — the new ones don't exist yet).
    const before = {
      machines: await selectColumns(handle, "machines", BATCH2_MACHINE_COLUMNS),
      loops: await selectColumns(handle, "loops", BATCH2_LOOP_COLUMNS),
      runs: await selectColumns(handle, "runs", BATCH2_RUN_COLUMNS),
      leases: await selectColumns(handle, "run_leases", BATCH2_LEASE_COLUMNS),
      sessions: await selectColumns(handle, "artifact_sync_sessions", BATCH2_SESSION_COLUMNS),
      manifests: await selectColumns(handle, "artifact_manifests", BATCH2_MANIFEST_COLUMNS),
      blobs: await selectColumns(handle, "artifact_blobs", BATCH2_BLOB_COLUMNS),
    };

    const upgraded = await upgradeInPlace(handle);

    // Every Batch 2 column of every business table is item-equal.
    expect(await selectColumns(upgraded, "machines", BATCH2_MACHINE_COLUMNS)).toEqual(before.machines);
    expect(await selectColumns(upgraded, "loops", BATCH2_LOOP_COLUMNS)).toEqual(before.loops);
    expect(await selectColumns(upgraded, "runs", BATCH2_RUN_COLUMNS)).toEqual(before.runs);
    expect(await selectColumns(upgraded, "run_leases", BATCH2_LEASE_COLUMNS)).toEqual(before.leases);
    expect(await selectColumns(upgraded, "artifact_sync_sessions", BATCH2_SESSION_COLUMNS)).toEqual(before.sessions);
    expect(await selectColumns(upgraded, "artifact_manifests", BATCH2_MANIFEST_COLUMNS)).toEqual(before.manifests);
    expect(await selectColumns(upgraded, "artifact_blobs", BATCH2_BLOB_COLUMNS)).toEqual(before.blobs);

    // Old machines land as UNCLAIMED and not revoked — the migration never
    // auto-claims (ADR-011 决策 7).
    const [machine] = await upgraded.db.select().from(machines);
    expect([machine!.teamId, machine!.revokedAt]).toEqual([null, null]);

    // The four identity tables exist and are EMPTY — the migration fabricates
    // no users, teams, memberships or sessions.
    for (const table of ["users", "teams", "memberships", "auth_sessions"]) {
      const { rows } = await upgraded.client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(rows[0]!.count), table).toBe(0);
    }

    // The artifact reference chain survives item-equal: the run's snapshot
    // pointer, the manifest's entries, and the committed session's receipt
    // (jsonb round-trips parsed — the pre/post snapshots above already compare
    // the same values via selectColumns).
    const { rows: runRows } = await upgraded.client.query<{ artifact_snapshot_id: string | null }>(
      "SELECT artifact_snapshot_id FROM runs WHERE id = 'run-done'",
    );
    expect(runRows[0]!.artifact_snapshot_id).toBe("amf-1");
    const { rows: manifestRows } = await upgraded.client.query<{ entries: unknown }>(
      "SELECT entries FROM artifact_manifests WHERE id = 'amf-1'",
    );
    expect(manifestRows[0]!.entries).toEqual([
      { path: "dist/app.js", hash: HASH_A, size: 1200 },
      { path: "docs/readme.md", hash: HASH_B, size: 40 },
    ]);
    const { rows: receiptRows } = await upgraded.client.query<{ receipt: unknown }>(
      "SELECT receipt FROM artifact_sync_sessions WHERE id = 'sync-committed'",
    );
    expect(receiptRows[0]!.receipt).toEqual({ artifactSnapshotId: "amf-1", manifestRevision: 1 });

    // Journal: 0000–0006, each applied once.
    const journal = await upgraded.client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(Number(journal.rows[0]!.count)).toBe(7);
  });

  test("LM1-freeze: the phase5 fixture is byte-identical to the committed 0000–0005 migrations", async () => {
    // The fixture must BE the committed Batch 2 migrations — a hand-edit of
    // either side breaks the "frozen old database" meaning of LM1.
    for (const tag of [
      "0000_safe_the_fallen",
      "0001_wooden_domino",
      "0002_wild_millenium_guard",
      "0003_wandering_susan_delgado",
      "0004_icy_black_crow",
      "0005_oval_ezekiel_stane",
    ]) {
      const [frozen, live] = await Promise.all([
        readFile(path.join(FIXTURE_DIR, `${tag}.sql`), "utf8"),
        readFile(path.join(LIVE_DIR, `${tag}.sql`), "utf8"),
      ]);
      expect(frozen, tag).toBe(live);
    }
    const journal = JSON.parse(await readFile(path.join(FIXTURE_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("LM2: identity rows and old business rows survive restart cycles and repeated migration item-equal", async () => {
    let handle = await openBatch2Db();
    await seedBatch2Data(handle);
    // Pre-upgrade snapshots of the six UNCHANGED-ROW-COUNT old tables (old
    // columns only). machines is deliberately NOT here: seeding below adds
    // the claimed machine, and its old columns — legacy row included — are
    // covered by the full-row seeded.machines comparison (a superset: every
    // old column plus team_id/revoked_at, for both machines).
    const before = {
      loops: await selectColumns(handle, "loops", BATCH2_LOOP_COLUMNS),
      runs: await selectColumns(handle, "runs", BATCH2_RUN_COLUMNS),
      leases: await selectColumns(handle, "run_leases", BATCH2_LEASE_COLUMNS),
      sessions: await selectColumns(handle, "artifact_sync_sessions", BATCH2_SESSION_COLUMNS),
      manifests: await selectColumns(handle, "artifact_manifests", BATCH2_MANIFEST_COLUMNS),
      blobs: await selectColumns(handle, "artifact_blobs", BATCH2_BLOB_COLUMNS),
    };
    let upgraded = await upgradeInPlace(handle);

    // Seed the identity chain a slice-2 login transaction will produce, plus a
    // claimed machine (slice 4's product) — via the testkit fixtures.
    const identity = await seedPersonalIdentity(upgraded.db, { githubUserId: "424242", username: "tester" });
    await seedSession(upgraded.db, { userId: identity.userId });
    await seedClaimedMachine(upgraded.db, "dk_claimed_machine", identity.teamId);

    // FULL-ROW snapshots of the seeded world (review #117): every column of
    // the four identity tables and both machines (claimed + legacy). The
    // post-restart comparison below is item-equal on EVERY field — a restart
    // or repeated migration that rewrites any column fails here.
    const seeded = {
      users: await upgraded.db.select().from(users),
      teams: await upgraded.db.select().from(teams),
      memberships: await upgraded.db.select().from(memberships),
      authSessions: await upgraded.db.select().from(authSessions),
      machines: await upgraded.db.select().from(machines).orderBy(machines.id),
    };
    // The seeded shape the snapshots imply: the claimed machine is bound to
    // the personal team; the legacy machine stays unclaimed and unrevoked.
    expect(seeded.machines.find((m) => m.id !== MACHINE_ID)!.teamId).toBe(identity.teamId);
    const legacySeeded = seeded.machines.find((m) => m.id === MACHINE_ID)!;
    expect([legacySeeded.teamId, legacySeeded.revokedAt]).toEqual([null, null]);

    // Two full restart cycles, plus an extra migrate on the live handle.
    for (let i = 0; i < 2; i++) {
      upgraded = await upgradeInPlace(upgraded);
    }
    await runMigrations(upgraded);

    // Identity rows survived item-equal — every column, not a pinned subset.
    expect(await upgraded.db.select().from(users)).toEqual(seeded.users);
    expect(await upgraded.db.select().from(teams)).toEqual(seeded.teams);
    expect(await upgraded.db.select().from(memberships)).toEqual(seeded.memberships);
    expect(await upgraded.db.select().from(authSessions)).toEqual(seeded.authSessions);
    expect(await upgraded.db.select().from(machines).orderBy(machines.id)).toEqual(seeded.machines);

    // Old business rows survived item-equal — every old column of the six
    // unchanged-row-count tables (machines covered above, row superset).
    expect(await selectColumns(upgraded, "loops", BATCH2_LOOP_COLUMNS)).toEqual(before.loops);
    expect(await selectColumns(upgraded, "runs", BATCH2_RUN_COLUMNS)).toEqual(before.runs);
    expect(await selectColumns(upgraded, "run_leases", BATCH2_LEASE_COLUMNS)).toEqual(before.leases);
    expect(await selectColumns(upgraded, "artifact_sync_sessions", BATCH2_SESSION_COLUMNS)).toEqual(before.sessions);
    expect(await selectColumns(upgraded, "artifact_manifests", BATCH2_MANIFEST_COLUMNS)).toEqual(before.manifests);
    expect(await selectColumns(upgraded, "artifact_blobs", BATCH2_BLOB_COLUMNS)).toEqual(before.blobs);

    // Journal stays at seven; tables/indexes are never duplicated.
    const journal = await upgraded.client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(Number(journal.rows[0]!.count)).toBe(7);
    for (const table of ["users", "teams", "memberships", "auth_sessions"]) {
      const { rows } = await upgraded.client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'`,
      );
      expect(Number(rows[0]!.count), table).toBe(1);
    }
    const { rows: idx } = await upgraded.client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM pg_indexes WHERE tablename = 'teams' AND indexname = 'teams_personal_owner_idx'",
    );
    expect(Number(idx[0]!.count)).toBe(1);
  });
});
