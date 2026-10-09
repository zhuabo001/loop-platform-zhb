/**
 * LM3–LM10 (happy path, idempotence and history integrity): the offline claim
 * end to end on REAL temp data dirs, a real local BlobStore and a real PGlite
 * database. The CLI opens and closes the database itself, so these tests seed
 * through one handle, close it, run `runClaimLegacy`, and reopen to assert.
 *
 * What is proved here and nowhere else:
 *  - the source namespace keeps its bytes AND its metadata rows (no GC);
 *  - manifest ids, entries, revisions and session receipts survive the
 *    namespace rewrite byte for byte;
 *  - a hash shared by two machines of one team is copied ONCE;
 *  - the re-run is a true no-op;
 *  - the machine's identity (id, token hash) is untouched, so the original
 *    Daemon's credential still authenticates and syncs into the team namespace.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { createLocalBlobStore } from "../artifact/blob-store-local.js";
import type { BlobStore } from "../artifact/blob-store.js";
import { createProductionArtifactHome } from "../artifact/production.js";
import { commitArtifactSync, prepareArtifactSync, putArtifactBlob } from "../artifact/sync.js";
import { artifactBlobs, artifactManifests, artifactSyncSessions, machines } from "../db/schema.js";
import { closeDb, openMigratedDb, type DbHandle } from "../db/index.js";
import { isMachineExecutionEligible, verifyEligibleMachineCredential } from "../store/machines.js";
import {
  FakeClock,
  makeArtifactBlob,
} from "../testkit/index.js";
import {
  CLAIM_LOOP_ID,
  CLAIM_TOKEN_A,
  CLAIM_TOKEN_B,
  claimBlobRoot,
  claimWorldSnapshot,
  failingStore,
  makeClaimDataDir,
  runClaimForTest,
  seedClaimBase,
  seedClaimHistory,
} from "../testkit/claim-fixtures.js";
const dirs: string[] = [];
const handles: DbHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function openDb(dataDir: string): Promise<DbHandle> {
  const handle = await openMigratedDb({ dataDir });
  handles.push(handle);
  return handle;
}

function storeOf(dataDir: string): BlobStore {
  return createLocalBlobStore({ rootDir: claimBlobRoot(dataDir) });
}

/** A seeded world that is already closed: ready for the CLI to open it. */
async function seedClosedWorld(tokens: readonly string[] = [CLAIM_TOKEN_A]) {
  const dataDir = await makeClaimDataDir();
  dirs.push(dataDir);
  const handle = await openDb(dataDir);
  const base = await seedClaimBase(handle.db, tokens);
  const store = storeOf(dataDir);
  return { dataDir, base, db: handle.db, store };
}

describe("slice 4: dry run", () => {
  it("reports the target, the machines and the bytes to copy — and writes nothing", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    const history = await seedClaimHistory(world.db, world.store, machineId);
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds, ["--dry-run"]);

    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("DRY RUN");
    expect(result.out).toContain("account  : 424242 (tester)");
    expect(result.out).toContain(`team     : ${world.base.teamId}`);
    expect(result.out).toContain(machineId);
    expect(result.out).toContain("3 to copy");
    // Nothing was copied into the team namespace...
    expect(existsSync(path.join(claimBlobRoot(world.dataDir), world.base.teamId))).toBe(false);

    const after = await openDb(world.dataDir);
    // ...and not one row anywhere moved.
    expect(await claimWorldSnapshot(after.db)).toEqual(before);
    for (const blob of history.blobs) {
      expect(existsSync(path.join(claimBlobRoot(world.dataDir), machineId, blob.hash))).toBe(true);
    }
  });
});

describe("slice 4: the claim", () => {
  it("migrates the namespace, keeps the source, and preserves every id and receipt", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    const history = await seedClaimHistory(world.db, world.store, machineId);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("done:");

    const after = await openDb(world.dataDir);
    const db = after.db;

    const manifests = await db.select().from(artifactManifests);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.namespaceId).toBe(world.base.teamId);
    // The immutable half is untouched.
    expect(manifests[0]!.id).toBe(history.manifestId);
    expect(manifests[0]!.entries).toEqual(history.entries);
    expect(manifests[0]!.manifestRevision).toBe(1);
    expect(manifests[0]!.committedAt).toBe("2026-07-29T00:00:00.000Z");

    const sessions = await db.select().from(artifactSyncSessions).orderBy(artifactSyncSessions.id);
    expect(sessions.map((s) => s.namespaceId)).toEqual([world.base.teamId, world.base.teamId]);
    expect(sessions.find((s) => s.id === `sync-committed-${machineId}`)!.receipt).toEqual(history.receipt);

    const machine = (await db.select().from(machines).where(eq(machines.id, machineId)))[0]!;
    expect(machine.teamId).toBe(world.base.teamId);
    expect(machine.id).toBe(machineId);
    expect(machine.tokenHash).toBe(sha256(CLAIM_TOKEN_A));

    const root = claimBlobRoot(world.dataDir);
    for (const blob of history.blobs) {
      expect(existsSync(path.join(root, world.base.teamId, blob.hash))).toBe(true);
      expect(existsSync(path.join(root, machineId, blob.hash))).toBe(true);
    }

    const rows = await db.select().from(artifactBlobs);
    expect(rows.filter((r) => r.namespaceId === world.base.teamId)).toHaveLength(3);
    // The source metadata rows are KEPT (决策 21) — the source files are.
    expect(rows.filter((r) => r.namespaceId === machineId)).toHaveLength(3);
  });

  it("LM5: a second run of the same target is an idempotent no-op", async () => {
    const world = await seedClosedWorld();
    await seedClaimHistory(world.db, world.store, world.base.machineIds[0]!);
    await closeDb(handles.pop()!);

    expect((await runClaimForTest(world.dataDir, world.base.machineIds)).code).toBe(0);
    const afterFirst = await openDb(world.dataDir);
    const before = await claimWorldSnapshot(afterFirst.db);
    await closeDb(handles.pop()!);

    const second = await runClaimForTest(world.dataDir, world.base.machineIds);

    expect(second.code).toBe(0);
    expect(second.err).toBe("");
    expect(second.out).toContain("no-op");

    const afterSecond = await openDb(world.dataDir);
    expect(await claimWorldSnapshot(afterSecond.db)).toEqual(before);
  });

  it("LM10: a hash shared by two machines of one team is copied exactly once", async () => {
    const world = await seedClosedWorld([CLAIM_TOKEN_A, CLAIM_TOKEN_B]);
    const [machineA, machineB] = world.base.machineIds as [string, string];
    await seedClaimHistory(world.db, world.store, machineA);
    // Both machines carry the SAME content under their own namespaces.
    await seedClaimHistory(world.db, world.store, machineB, `${CLAIM_LOOP_ID}-1`);
    await closeDb(handles.pop()!);

    const shared = makeArtifactBlob("alpha").hash;
    const counted = failingStore(world.store, () => null);
    const result = await runClaimForTest(world.dataDir, world.base.machineIds, [], { blobStore: counted.store });

    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("copied   : 3 blob(s)");
    // Six source blob rows collapse to three copies.
    expect(counted.writes).toHaveLength(3);
    expect(counted.writes.filter((hash) => hash === shared)).toHaveLength(1);

    const after = await openDb(world.dataDir);
    for (const machineId of world.base.machineIds) {
      expect((await after.db.select().from(machines).where(eq(machines.id, machineId)))[0]!.teamId).toBe(world.base.teamId);
    }
  });

  it("LM10: a later run reuses what an earlier claim already published", async () => {
    const world = await seedClosedWorld([CLAIM_TOKEN_A, CLAIM_TOKEN_B]);
    const [machineA, machineB] = world.base.machineIds as [string, string];
    await seedClaimHistory(world.db, world.store, machineA);
    await seedClaimHistory(world.db, world.store, machineB, `${CLAIM_LOOP_ID}-1`);
    await closeDb(handles.pop()!);

    // Run 1: only machine A. Run 2: only machine B, whose identical hashes are
    // already in the team namespace and must be REUSED, not republished.
    expect((await runClaimForTest(world.dataDir, [machineA])).code).toBe(0);

    const counted = failingStore(storeOf(world.dataDir), () => null);
    const second = await runClaimForTest(world.dataDir, [machineB], [], { blobStore: counted.store });

    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    expect(second.out).toContain("copied   : 0 blob(s), 0 bytes (3 already present and verified)");
    expect(counted.writes).toHaveLength(0);

    const after = await openDb(world.dataDir);
    expect((await after.db.select().from(machines).where(eq(machines.id, machineB)))[0]!.teamId).toBe(world.base.teamId);
    // The shared rows were not duplicated.
    const rows = await after.db.select().from(artifactBlobs);
    expect(rows.filter((r) => r.namespaceId === world.base.teamId)).toHaveLength(3);
  });

  it("LM10: the credential still authenticates and the machine syncs into the team namespace", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    await seedClaimHistory(world.db, world.store, machineId);
    await closeDb(handles.pop()!);

    expect((await runClaimForTest(world.dataDir, world.base.machineIds)).code).toBe(0);

    const after = await openDb(world.dataDir);
    const db = after.db;

    // The ORIGINAL device token is unchanged and now passes the eligibility gate.
    const verified = await verifyEligibleMachineCredential(db, CLAIM_TOKEN_A);
    expect(verified?.id).toBe(machineId);
    expect(verified?.teamId).toBe(world.base.teamId);
    expect(await isMachineExecutionEligible(db, machineId)).toBe(true);

    // A fresh sync round-trips and lands in the TEAM namespace.
    const home = createProductionArtifactHome({ db, dataDir: world.dataDir, clock: new FakeClock() });
    const content = "post-claim bytes";
    const hash = sha256(content);
    const prepare = await prepareArtifactSync(
      home,
      { machineId },
      {
        requestId: "req-after-claim",
        loopId: CLAIM_LOOP_ID,
        configRevision: 1,
        baseManifestRevision: 1,
        entries: [{ path: "new.txt", hash, size: content.length }],
      },
    );
    expect(prepare.ok, JSON.stringify(prepare)).toBe(true);
    if (!prepare.ok) return;

    const put = await putArtifactBlob(home, { machineId }, {
      syncId: prepare.response.syncId,
      hash,
      bytes: (async function* () {
        yield new TextEncoder().encode(content);
      })(),
    });
    expect(put.ok).toBe(true);
    const commit = await commitArtifactSync(home, { machineId }, { syncId: prepare.response.syncId });
    expect(commit.ok).toBe(true);
    expect(existsSync(path.join(claimBlobRoot(world.dataDir), world.base.teamId, hash))).toBe(true);
  });
});
