/**
 * Phase 5 Batch 1 slice 2 — AM3/AM4: the artifact-sync schema (migration
 * 0005, ADR-010, plan §2 数据模型) on a FRESH database.
 *
 *  AM3  New-model round-trips at safe defaults: every new loops/runs column
 *       lands on its DDL default when omitted; the three artifact tables
 *       round-trip verbatim (jsonb columns included); the error enum accepts
 *       every ARTIFACT_ERROR_CODES value.
 *  AM4  Unique keys arbitrate exactly their declared scope: session
 *       (namespaceId, machineId, requestId), manifest (loopId,
 *       manifestRevision), blob (namespaceId, hash); the same value under a
 *       DIFFERENT scope succeeds. Revision rules (monotonic / int32
 *       exhaustion) are write-path discipline — see artifact/config.test.ts.
 *       NO foreign keys: association is validated in the ArtifactHome write
 *       paths (the binding-plan tests carry that half), never by the DB.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { ARTIFACT_ERROR_CODES } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./index.js";
import {
  artifactBlobs,
  artifactManifests,
  artifactSyncSessions,
  loops,
  machines,
  runs,
} from "./schema.js";

const handles: DbHandle[] = [];
let db: Db;

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

const NOW = "2026-09-28T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Fresh migrated in-memory db per test, with one machine + one loop so the
 *  artifact fixtures stay honest (no FKs, but the rows reference real ids). */
async function seeded(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  await db.insert(machines).values({ id: "m-1", name: "", tokenHash: "deadbeef", createdAt: NOW });
  await db.insert(loops).values({ id: "loop-1", machineId: "m-1", createdAt: NOW, updatedAt: NOW });
}

const SESSION_FIXTURE = {
  id: "sync-1",
  namespaceId: "ns-1",
  machineId: "m-1",
  loopId: "loop-1",
  requestId: "req-1",
  configRevision: 2,
  baseManifestRevision: 1,
  normalizedManifest: [
    { path: "dist/app.js", hash: HASH_A, size: 1200 },
    { path: "docs/readme.md", hash: HASH_B, size: 40 },
  ],
  payloadFingerprint: "f".repeat(64),
  negotiatedHashes: [HASH_A, HASH_B],
  createdAt: NOW,
  expiresAt: "2026-09-28T01:00:00.000Z",
};

const MANIFEST_FIXTURE = {
  id: "amf-1",
  namespaceId: "ns-1",
  machineId: "m-1",
  loopId: "loop-1",
  configRevision: 2,
  manifestRevision: 1,
  entries: [{ path: "dist/app.js", hash: HASH_A, size: 1200 }],
  fileCount: 1,
  totalBytes: 1200,
  committedAt: NOW,
};

const BLOB_FIXTURE = {
  namespaceId: "ns-1",
  hash: HASH_A,
  size: 1200,
  verifiedAt: NOW,
};

/** drizzle wraps the driver error as "Failed query: …"; the violated
 *  constraint's name lives on the PG error down the `cause` chain. Walk it. */
async function expectUniqueViolation(promise: Promise<unknown>, constraint: string): Promise<void> {
  const err: unknown = await promise.then(
    () => {
      throw new Error(`expected a unique violation on ${constraint}, but the insert succeeded`);
    },
    (e: unknown) => e,
  );
  const messages: string[] = [];
  for (let cur: unknown = err; cur; cur = (cur as { cause?: unknown }).cause) {
    messages.push(String((cur as Error).message ?? cur));
  }
  expect(messages.join("\n")).toContain(constraint);
}

describe("AM3: new-model round-trips and safe defaults", () => {
  it("omitted artifact columns land on their DDL defaults (loops and runs)", async () => {
    await seeded();
    await db.insert(runs).values({ id: "run-1", loopId: "loop-1", machineId: "m-1", phase: "pending", role: "exec", ts: NOW });

    const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    // An unconfigured loop: no dir, generation 0, no manifest pointer, no
    // sync attempt state (旧 Loop 默认关闭 — the dormancy half is AM2's
    // upgraded-database evidence in phase5-migration.test.ts).
    expect([
      loop!.artifactDir,
      loop!.artifactConfigRevision,
      loop!.artifactManifestRevision,
      loop!.artifactManifestId,
      loop!.artifactSyncAttemptedAt,
      loop!.artifactSyncSucceededAt,
      loop!.artifactSyncError,
    ]).toEqual([null, 0, 0, null, null, null, null]);

    const [run] = await db.select().from(runs).where(eq(runs.id, "run-1"));
    expect([run!.artifactSnapshotId, run!.artifactSyncError]).toEqual([null, null]);
  });

  it("session/manifest/blob rows round-trip verbatim, jsonb columns included", async () => {
    await seeded();
    await db.insert(artifactSyncSessions).values(SESSION_FIXTURE);
    await db.insert(artifactManifests).values(MANIFEST_FIXTURE);
    await db.insert(artifactBlobs).values(BLOB_FIXTURE);

    const [session] = await db.select().from(artifactSyncSessions);
    expect(session).toEqual({ ...SESSION_FIXTURE, receipt: null });
    const [manifest] = await db.select().from(artifactManifests);
    expect(manifest).toEqual(MANIFEST_FIXTURE);
    const [blob] = await db.select().from(artifactBlobs);
    expect(blob).toEqual(BLOB_FIXTURE);

    // The commit receipt is the committed marker (决策 11): null → set, and
    // the stored receipt replays verbatim.
    const receipt = { artifactSnapshotId: "amf-1", manifestRevision: 1 };
    await db.update(artifactSyncSessions).set({ receipt }).where(eq(artifactSyncSessions.id, "sync-1"));
    const [committed] = await db.select().from(artifactSyncSessions);
    expect(committed!.receipt).toEqual(receipt);
  });

  it("every ARTIFACT_ERROR_CODES value is writable to loops.artifact_sync_error", async () => {
    await seeded();
    for (const code of ARTIFACT_ERROR_CODES) {
      await db.update(loops).set({ artifactSyncError: code }).where(eq(loops.id, "loop-1"));
      const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
      expect(loop!.artifactSyncError).toBe(code);
    }
  });
});

describe("AM4: unique keys arbitrate exactly their declared scope", () => {
  it("session (namespaceId, machineId, requestId) rejects duplicates; other scopes succeed", async () => {
    await seeded();
    await db.insert(artifactSyncSessions).values(SESSION_FIXTURE);
    // Same key triple — rejected, naming the arbitrating index.
    await expectUniqueViolation(
      db.insert(artifactSyncSessions).values({ ...SESSION_FIXTURE, id: "sync-2" }),
      "artifact_sync_sessions_request_idx",
    );
    // Same requestId under a DIFFERENT machine or namespace: a different key.
    await db.insert(artifactSyncSessions).values({ ...SESSION_FIXTURE, id: "sync-3", machineId: "m-2" });
    await db.insert(artifactSyncSessions).values({ ...SESSION_FIXTURE, id: "sync-4", namespaceId: "ns-2" });
    expect(await db.select().from(artifactSyncSessions)).toHaveLength(3);
  });

  it("manifest (loopId, manifestRevision) rejects duplicates; another loop may use the same revision", async () => {
    await seeded();
    await db.insert(loops).values({ id: "loop-2", machineId: "m-1", createdAt: NOW, updatedAt: NOW });
    await db.insert(artifactManifests).values(MANIFEST_FIXTURE);
    await expectUniqueViolation(
      db.insert(artifactManifests).values({ ...MANIFEST_FIXTURE, id: "amf-2" }),
      "artifact_manifests_loop_revision_idx",
    );
    await db.insert(artifactManifests).values({ ...MANIFEST_FIXTURE, id: "amf-3", loopId: "loop-2" });
    expect(await db.select().from(artifactManifests)).toHaveLength(2);
  });

  it("blob (namespaceId, hash) rejects duplicates; another namespace may hold the same hash", async () => {
    await seeded();
    await db.insert(artifactBlobs).values(BLOB_FIXTURE);
    await expectUniqueViolation(
      db.insert(artifactBlobs).values({ ...BLOB_FIXTURE, size: 9999 }),
      "artifact_blobs_pkey",
    );
    await db.insert(artifactBlobs).values({ ...BLOB_FIXTURE, namespaceId: "ns-2" });
    expect(await db.select().from(artifactBlobs)).toHaveLength(2);
  });

  it("NO foreign keys: artifact rows may name a nonexistent loop at the DB level", async () => {
    await seeded();
    // The no-FK convention (ADR-003, schema.ts header) is deliberate: the
    // attribution chain is validated in the ArtifactHome write paths (slice 4)
    // and the binding plan (artifact/binding-plan.test.ts), never by the DB.
    // This pins the split so a "helpful" future FK fails loudly here.
    await db.insert(artifactManifests).values({ ...MANIFEST_FIXTURE, id: "amf-orphan", loopId: "loop-ghost" });
    await db.insert(artifactSyncSessions).values({ ...SESSION_FIXTURE, id: "sync-orphan", loopId: "loop-ghost" });
    expect(await db.select().from(artifactManifests)).toHaveLength(1);
    expect(await db.select().from(artifactSyncSessions)).toHaveLength(1);
  });
});
