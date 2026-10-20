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

import { afterEach, describe, expect, test } from "vitest";

import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, createDb, runMigrations, type DbHandle } from "../db/index.js";
import { authSessions, machines, memberships, teams, users } from "../db/schema.js";
import {
  BATCH2_BLOB_COLUMNS,
  BATCH2_LEASE_COLUMNS,
  BATCH2_LOOP_COLUMNS,
  BATCH2_MACHINE_COLUMNS,
  BATCH2_MANIFEST_COLUMNS,
  BATCH2_RUN_COLUMNS,
  BATCH2_SESSION_COLUMNS,
  openBatch2Db as openBatch2DbAt,
  seedBatch2Data,
} from "../testkit/batch2-world.js";
import { seedClaimedMachine, seedPersonalIdentity, seedSession } from "../testkit/index.js";

const FIXTURE_DIR = path.resolve("test-fixtures/phase5-migrations");
const LIVE_DIR = path.resolve("drizzle");

const MACHINE_TOKEN = "dk_batch2_machine";
const MACHINE_ID = machineIdFromToken(MACHINE_TOKEN);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const handles: DbHandle[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function selectColumns(handle: DbHandle, table: string, columns: readonly string[]): Promise<unknown[]> {
  const result = await handle.client.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1, 2`);
  return result.rows;
}

/** Test-local lifetime: a fresh temp dataDir plus the two cleanup registries. */
async function openBatch2Db(): Promise<DbHandle> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b3-m-${process.pid}-`));
  tempDirs.push(dataDir);
  const handle = await openBatch2DbAt(dataDir);
  handles.push(handle);
  return handle;
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

    // The extracted builder's DEFAULT must still BE the LM fixture: the
    // representative Loop keeps its active schedule. Without this, a builder
    // that silently seeds a manual Loop leaves the pre/post comparison green
    // (NULL on both sides) while the schedule-migration coverage is gone
    // (review #125).
    const seededSchedule = await handle.client.query<{ cron: string | null }>(
      "SELECT cron FROM loops WHERE id = 'loop-old'",
    );
    expect(seededSchedule.rows[0]!.cron).toBe("0 3 * * *");

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
