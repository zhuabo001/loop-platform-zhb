/**
 * The frozen Batch 2 (0000–0005) world builder — TEST-ONLY (excluded from the
 * build with the rest of `src/testkit/**`).
 *
 * Two callers need the same old database:
 *
 *  - `db/phase5-batch3-migration.test.ts` (LM1/LM2) upgrades it in place and
 *    compares every old column before and after;
 *  - `phase5-batch3-slice7-e2e.test.ts` (BI1–BI6) boots the production server
 *    over it, logs in, claims it offline, restarts and runs the daemon.
 *
 * Rows are written with RAW SQL on purpose: only old column names may appear.
 * Naming `machines.team_id` here would fail loudly against the old DDL, which
 * is exactly the proof that the fixture is a genuine Batch 2 database.
 *
 * Defaults reproduce the LM fixture byte-for-byte, including the ACTIVE
 * `'0 3 * * *'` schedule on `loop-old`. Callers that need a runnable world (a
 * real workdir, content-addressed blobs, a pending Run, no active lease) pass
 * options — and `cron: null` when the claimed Loop must not be caught up by the
 * scheduler. Nothing here is allowed to touch the live `drizzle/` migrations —
 * `LM1-freeze` pins the fixture against them separately.
 */
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";

import { machineIdFromToken, sha256 } from "@loopzhb/protocol/node";

import { artifactBlobRoot } from "../artifact/production.js";
import { createLocalBlobStore } from "../artifact/blob-store-local.js";
import { closeDb, createDb, type DbHandle } from "../db/index.js";

export const BATCH2_FIXTURE_DIR = path.resolve("test-fixtures/phase5-migrations");

export const BATCH2_DEFAULT_MACHINE_TOKEN = "dk_batch2_machine";
export const BATCH2_DEFAULT_LOOP_ID = "loop-old";
export const BATCH2_DEFAULT_MANIFEST_ID = "amf-1";

const DEFAULT_HASH_A = "a".repeat(64);
const DEFAULT_HASH_B = "b".repeat(64);

export type Batch2RunMode = "legacy" | "pending" | "none";

export interface Batch2ArtifactSpec {
  /** Manifest path, e.g. `dist/app.js`. */
  path: string;
  /** File content; the hash and size are derived from it. */
  text: string;
}

export interface Batch2WorldSpec {
  machineToken?: string;
  loopId?: string;
  /** Real absolute workdir. Defaults to the LM fixture's `/home/user/project`. */
  workdir?: string;
  /** `loops.artifact_dir` — relative to the workdir. Defaults to `dist`. */
  artifactDir?: string;
  /**
   * `loops.cron` for the requested Loop. Defaults to the LM fixture's ACTIVE
   * schedule `'0 3 * * *'`; pass `null` for a runnable world whose Loop must
   * stay out of the scheduler after it is claimed.
   */
  cron?: string | null;
  /** `loops.task_file`; null for a manual loop. Defaults to the LM fixture path. */
  taskFile?: string | null;
  taskFileContent?: string | null;
  /** `machines.roots` — the server-side subset the daemon intersects with its
   *  own roots. Defaults to the LM fixture's ["/home/user"]. A runnable world
   *  must state the SAME canonical root the test daemon uses. */
  machineRoots?: readonly string[];
  /**
   * Content-addressed Artifact history. When omitted, the LM fixture's
   * metadata-only fake hashes are used and NO blob file is written (the
   * migration test never reads bytes). When present, files are written through
   * the production LocalBlobStore under `<dataDir>/blobs/<machineId>/`.
   */
  artifacts?: readonly Batch2ArtifactSpec[];
  /** `legacy` = terminal + running Run + active lease (LM fixture);
   *  `pending` = terminal + one pending exec Run, no lease (BI);
   *  `none` = terminal Run only. */
  runMode?: Batch2RunMode;
  /** Keep the fixture's second, unconfigured `loop-plain` row. Default true. */
  includePlainLoop?: boolean;
}

export interface Batch2World {
  machineId: string;
  loopId: string;
  manifestId: string;
  committedSessionId: string;
  pendingSessionId: string;
  terminalRunId: string;
  pendingRunId: string | null;
  runningRunId: string | null;
  artifacts: { path: string; hash: string; size: number }[];
  runMode: Batch2RunMode;
}

/** Build the OLD (Batch 2, 0000–0005) database at a caller-owned dataDir. */
export async function openBatch2Db(dataDir: string): Promise<DbHandle> {
  const handle = await createDb({ dataDir });
  await migrate(handle.db, { migrationsFolder: BATCH2_FIXTURE_DIR });
  return handle;
}

/** Open, seed, and close in one step — the slice-7 boot path. */
export async function buildBatch2World(
  dataDir: string,
  spec: Batch2WorldSpec = {},
): Promise<Batch2World> {
  const handle = await openBatch2Db(dataDir);
  try {
    return await seedBatch2Data(handle, spec);
  } finally {
    await closeDb(handle);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function artifactRow(spec: Batch2ArtifactSpec): { path: string; hash: string; size: number } {
  return { path: spec.path, hash: sha256(spec.text), size: Buffer.byteLength(spec.text) };
}

/**
 * Representative Batch 2 rows. The default call reproduces the LM1 world:
 * two Loops, one terminal Run bound to `amf-1`, one running Run with an active
 * lease, a committed and a pending sync session, two metadata-only blob rows.
 */
export async function seedBatch2Data(handle: DbHandle, spec: Batch2WorldSpec = {}): Promise<Batch2World> {
  const machineToken = spec.machineToken ?? BATCH2_DEFAULT_MACHINE_TOKEN;
  const machineId = machineIdFromToken(machineToken);
  const loopId = spec.loopId ?? BATCH2_DEFAULT_LOOP_ID;
  const workdir = spec.workdir ?? "/home/user/project";
  const artifactDir = spec.artifactDir ?? "dist";
  const cron = spec.cron === undefined ? "0 3 * * *" : spec.cron;
  const taskFile = spec.taskFile === undefined ? "/home/user/project/TASK.md" : spec.taskFile;
  const taskFileContent = spec.taskFileContent === undefined ? "# TASK\nspec v1" : spec.taskFileContent;
  const machineRoots = spec.machineRoots ?? ["/home/user"];
  const runMode = spec.runMode ?? "legacy";
  const manifestId = BATCH2_DEFAULT_MANIFEST_ID;
  const pendingRunId = runMode === "pending" ? "run-pending" : null;
  const runningRunId = runMode === "legacy" ? "run-running" : null;

  const artifacts =
    spec.artifacts === undefined
      ? [
          { path: "dist/app.js", hash: DEFAULT_HASH_A, size: 1200 },
          { path: "docs/readme.md", hash: DEFAULT_HASH_B, size: 40 },
        ]
      : spec.artifacts.map(artifactRow);
  const entriesJson = JSON.stringify(artifacts);
  const blobRows = artifacts
    .map((a, i) => `(${quote(machineId)}, ${quote(a.hash)}, ${a.size}, '2026-10-06T03:00:0${i + 2}.000Z')`)
    .join(",\n      ");

  const taskFileSql = taskFile === null ? "NULL" : quote(taskFile);
  const taskContentSql = taskFileContent === null ? "NULL" : quote(taskFileContent);
  const cronSql = cron === null ? "NULL" : quote(cron);

  const plainLoopSql = spec.includePlainLoop === false
    ? ""
    : `,
      (
        'loop-plain', ${quote(machineId)}, 'manual', NULL, NULL,
        NULL, NULL,
        NULL, NULL, true, 'claude-code', false, NULL,
        NULL, 'UTC', NULL, 0, NULL, NULL,
        NULL, 0, NULL, NULL,
        NULL, NULL,
        NULL, 0, 0, NULL,
        NULL, NULL, NULL,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0
      )`;

  const leaseSql =
    runningRunId === null
      ? ""
      : `
    INSERT INTO run_leases (
      token_hash, run_id, loop_id, machine_id, role,
      allow_control, can_set_ui, can_set_schema, can_set_workflow, can_finish,
      state, expires_at, terminal_protocol_version, goal_revision, created_at
    ) VALUES (
      ${quote(sha256("rk_batch2_legacy"))}, ${quote(runningRunId)}, ${quote(loopId)}, ${quote(machineId)}, 'exec',
      false, false, false, false, false,
      'active', NULL, 0, 0, '2026-10-07T00:00:00.000Z'
    );`;

  const runningRunSql =
    runningRunId === null
      ? ""
      : `,
      (
        ${quote(runningRunId)}, ${quote(loopId)}, ${quote(machineId)}, 'running', 'exec', '2026-10-07T00:00:00.000Z',
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '{"step":2,"label":"working","at":"2026-10-07T00:00:01.000Z"}'::jsonb,
        NULL, NULL
      )`;

  const pendingRunSql =
    pendingRunId === null
      ? ""
      : `,
      (
        ${quote(pendingRunId)}, ${quote(loopId)}, ${quote(machineId)}, 'pending', 'exec', '2026-10-07T00:00:00.000Z',
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL
      )`;

  await handle.client.exec(`
    INSERT INTO machines (
      id, name, hostname, platform, arch, daemon_version, token_hash, roots, last_seen, capabilities, created_at
    ) VALUES (
      ${quote(machineId)}, 'mbp', 'mbp.local', 'darwin', 'arm64', '0.1.0',
      ${quote(sha256(machineToken))}, ${quote(JSON.stringify(machineRoots))}::jsonb, '2026-10-06T00:00:00.000Z',
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
        ${quote(loopId)}, ${quote(machineId)}, 'nightly', ${quote(workdir)}, ${taskFileSql},
        ${taskContentSql}, '2026-10-06T00:00:00.000Z',
        NULL, NULL, true, 'claude-code', true, '{"cursor":3}'::jsonb,
        ${cronSql}, 'Asia/Shanghai', NULL, 7, '2026-08-20T00:00:00.000Z', '2026-10-06T03:00:00.000Z',
        'triage the queue', 2, NULL, NULL,
        '2026-10-06T00:00:01.000Z', NULL,
        ${quote(artifactDir)}, 2, 1, ${quote(manifestId)},
        '2026-10-06T03:00:04.000Z', '2026-10-06T03:00:04.500Z', NULL,
        '2026-07-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 5
      )${plainLoopSql};

    INSERT INTO runs (
      id, loop_id, machine_id, phase, role, ts, outcome, status, message, duration_ms,
      error, state, session_id, cost_usd, usage, artifacts, transcript, progress,
      artifact_snapshot_id, artifact_sync_error
    ) VALUES
      (
        'run-done', ${quote(loopId)}, ${quote(machineId)}, 'done', 'exec', '2026-10-06T03:00:05.000Z',
        'exec', 'new', 'found 2 issues', 42000,
        NULL, '{"seen":2}'::jsonb, 'sess_1', 0.42, '{"inputTokens":12000}'::jsonb,
        '[{"path":"a.ts","kind":"edited"}]'::jsonb, '[{"kind":"text","text":"hi"}]'::jsonb, NULL,
        ${quote(manifestId)}, NULL
      )${runningRunSql}${pendingRunSql};
${leaseSql}
    INSERT INTO artifact_manifests (
      id, namespace_id, machine_id, loop_id, config_revision, manifest_revision,
      entries, file_count, total_bytes, committed_at
    ) VALUES (
      ${quote(manifestId)}, ${quote(machineId)}, ${quote(machineId)}, ${quote(loopId)}, 2, 1,
      ${quote(entriesJson)}::jsonb,
      ${artifacts.length}, ${artifacts.reduce((sum, a) => sum + a.size, 0)}, '2026-10-06T03:00:04.500Z'
    );

    INSERT INTO artifact_sync_sessions (
      id, namespace_id, machine_id, loop_id, request_id, config_revision, base_manifest_revision,
      normalized_manifest, payload_fingerprint, negotiated_hashes, created_at, expires_at, receipt
    ) VALUES
      (
        'sync-committed', ${quote(machineId)}, ${quote(machineId)}, ${quote(loopId)}, 'req-1', 2, 0,
        ${quote(entriesJson)}::jsonb,
        ${quote("f".repeat(64))}, ${quote(JSON.stringify(artifacts.map((a) => a.hash)))}::jsonb,
        '2026-10-06T03:00:00.000Z', '2026-10-06T04:00:00.000Z',
        ${quote(`{"artifactSnapshotId":"${manifestId}","manifestRevision":1}`)}::jsonb
      ),
      (
        'sync-pending', ${quote(machineId)}, ${quote(machineId)}, ${quote(loopId)}, 'req-2', 2, 1,
        '[]'::jsonb,
        ${quote("e".repeat(64))}, '[]'::jsonb,
        '2026-10-07T00:30:00.000Z', '2026-10-07T01:30:00.000Z', NULL
      );

    INSERT INTO artifact_blobs (namespace_id, hash, size, verified_at) VALUES
      ${blobRows};
  `);

  if (spec.artifacts !== undefined) {
    const store = createLocalBlobStore({ rootDir: artifactBlobRoot(handle.dataDir!) });
    for (const artifact of spec.artifacts) {
      const bytes = new TextEncoder().encode(artifact.text);
      const row = artifactRow(artifact);
      const written = await store.writeVerified({
        namespaceId: machineId,
        hash: row.hash,
        expectedSize: row.size,
        bytes: (async function* () {
          yield bytes;
        })(),
      });
      if (!written.ok) throw new Error(`seedBatch2Data: blob write failed (${written.failure})`);
    }
  }

  return {
    machineId,
    loopId,
    manifestId,
    committedSessionId: "sync-committed",
    pendingSessionId: "sync-pending",
    terminalRunId: "run-done",
    pendingRunId,
    runningRunId,
    artifacts,
    runMode,
  };
}

/** The full Batch 2 (0000–0005) column sets — everything the old DB knows.
 *  The Batch 3 identity columns/tables are deliberately NOT here. */
export const BATCH2_MACHINE_COLUMNS = [
  "id", "name", "hostname", "platform", "arch", "daemon_version", "token_hash", "roots",
  "last_seen", "capabilities", "created_at",
] as const;

export const BATCH2_LOOP_COLUMNS = [
  "id", "machine_id", "name", "workdir", "task_file", "task_file_content", "task_file_synced_at",
  "workflow", "model", "allow_control", "agent", "enabled", "state",
  "cron", "timezone", "next_run_at", "schedule_revision", "schedule_activated_at", "last_scheduled_at",
  "goal", "goal_revision", "completed_at", "completion_reason",
  "task_file_sync_attempted_at", "task_file_sync_error",
  "artifact_dir", "artifact_config_revision", "artifact_manifest_revision", "artifact_manifest_id",
  "artifact_sync_attempted_at", "artifact_sync_succeeded_at", "artifact_sync_error",
  "created_at", "updated_at", "revision",
] as const;

export const BATCH2_RUN_COLUMNS = [
  "id", "loop_id", "machine_id", "phase", "role", "ts", "outcome", "status", "message",
  "duration_ms", "error", "state", "session_id", "cost_usd", "usage", "artifacts", "transcript", "progress",
  "artifact_snapshot_id", "artifact_sync_error",
] as const;

export const BATCH2_LEASE_COLUMNS = [
  "token_hash", "run_id", "loop_id", "machine_id", "role",
  "allow_control", "can_set_ui", "can_set_schema", "can_set_workflow", "can_finish",
  "state", "expires_at", "terminal_protocol_version", "goal_revision", "created_at",
] as const;

export const BATCH2_SESSION_COLUMNS = [
  "id", "namespace_id", "machine_id", "loop_id", "request_id", "config_revision", "base_manifest_revision",
  "normalized_manifest", "payload_fingerprint", "negotiated_hashes", "created_at", "expires_at", "receipt",
] as const;

export const BATCH2_MANIFEST_COLUMNS = [
  "id", "namespace_id", "machine_id", "loop_id", "config_revision", "manifest_revision",
  "entries", "file_count", "total_bytes", "committed_at",
] as const;

export const BATCH2_BLOB_COLUMNS = ["namespace_id", "hash", "size", "verified_at"] as const;

export const BATCH2_TABLES = {
  machines: BATCH2_MACHINE_COLUMNS,
  loops: BATCH2_LOOP_COLUMNS,
  runs: BATCH2_RUN_COLUMNS,
  run_leases: BATCH2_LEASE_COLUMNS,
  artifact_sync_sessions: BATCH2_SESSION_COLUMNS,
  artifact_manifests: BATCH2_MANIFEST_COLUMNS,
  artifact_blobs: BATCH2_BLOB_COLUMNS,
} as const;

export async function selectBatch2Columns(
  handle: DbHandle,
  table: keyof typeof BATCH2_TABLES,
): Promise<unknown[]> {
  const columns = BATCH2_TABLES[table];
  const result = await handle.client.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1, 2`);
  return result.rows;
}
