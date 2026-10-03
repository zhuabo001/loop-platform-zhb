/**
 * Phase 5 Batch 1 internal integration acceptance (authoritative plan §4
 * slice 6, the paragraph at plan L171) — the file-backed E2E the batch's
 * completion definition names. It is NOT a new test grouping: no AM/AP/AB/AC
 * grouping ID is claimed here (plan L171: 不改变原测试编组 ID), and it does
 * not substitute for any grouping's own suite.
 *
 * The chain, exactly as the plan words it:
 *
 *   ArtifactHome prepare → PUT → commit → read the current view and the
 *   snapshot → apply the binding plan IN A TEST TRANSACTION and verify the
 *   Run reference and the file contents → CLOSE the database → REOPEN on the
 *   SAME file-backed PGlite data directory and the SAME local Blob root →
 *   the snapshot and the Run reference are still there → retry the same
 *   commit: same snapshot ID / manifest revision, no second record → commit a
 *   file change → the old snapshot is unchanged → replay the OLD commit: the
 *   current pointer never regresses.
 *
 * Infrastructure discipline:
 *   - file-backed PGlite (`openMigratedDb({ dataDir })`, `<dataDir>/pgdata`)
 *     + the REAL local BlobStore on a REAL mkdtemp root + a real temp data
 *     dir — the slice 1–5 suites all ran in-memory and this is the batch's
 *     one on-disk path;
 *   - INTERNAL MODULES ONLY: no HTTP app, no bootstrapServer, no coordinator
 *     or store write path, no watcher. `db/index.ts` (the production DB open
 *     path, precedent fault-injection.test.ts T4) is deliberately used — the
 *     file-backed database IS the evidence here.
 *   - Determinism: one FakeClock instance across the reopen, and the id
 *     counters PERSIST across the reopen (production mints randomUUIDs; a
 *     counter reset could re-mint a persisted primary key).
 *   - Honesty: exact `toEqual` for the snapshot row, the receipt replay and
 *     the zero-write snapshots; the negotiated `needHashes` drives the PUTs
 *     (never hand-derived); every stream element carries its own ok
 *     assertion; blob bytes are re-read through a NEW store instance after
 *     the reopen AND compared against the raw files on disk.
 *
 * Boundary (ADR-010 决策 16 + plan L171/L197): this path exercises no HTTP
 * route, no production Report handler and no Batch 2 watcher/coordination.
 * PGlite single-connection evidence does not stand in for the real
 * multi-physical-connection Postgres verification tracked by #11 / #72.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { PrepareArtifactSyncRequest } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./db/index.js";
import { artifactManifests, artifactSyncSessions, loops, runs, type Loop, type Run } from "./db/schema.js";
import { FakeClock, seedLoop, seedMachine, seedRun, snapshotLoops } from "./testkit/index.js";
import type { ArtifactAttributionResolver } from "./artifact/attribution.js";
import { applyArtifactBindingPlan, planArtifactSnapshotBinding } from "./artifact/binding-plan.js";
import { createLocalBlobStore } from "./artifact/blob-store-local.js";
import type { BlobKey, BlobStore } from "./artifact/blob-store.js";
import { readCurrentArtifactView, updateArtifactConfig } from "./artifact/config.js";
import {
  commitArtifactSync,
  prepareArtifactSync,
  putArtifactBlob,
  readArtifactSnapshot,
  type ArtifactHomeDeps,
} from "./artifact/sync.js";

// ---- fixture bytes ----

function bytesOf(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic non-text 4 KiB payload — the "file contents" assertions
 *  must mean more than echoing a short string. */
function patternBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 17 + 3) & 0xff;
  return bytes;
}

/** Multi-chunk source stream — the PUT path must stream, not single-shot. */
async function* chunks(bytes: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  for (let off = 0; off < bytes.byteLength; off += chunkSize) yield bytes.subarray(off, off + chunkSize);
}

function staticAttribution(map: Record<string, string>): ArtifactAttributionResolver {
  return {
    resolve: (machine) => {
      const namespaceId = map[machine.machineId];
      return Promise.resolve(
        namespaceId
          ? { ok: true as const, namespaceId, machineId: machine.machineId }
          : { ok: false as const, failure: "attribution_missing" as const },
      );
    },
  };
}

/** Consume a blob read to completion with per-element ok assertions (the
 *  iterator never throws for an I/O failure — a silent terminal element must
 *  fail the test, not truncate it) and release the read resource. */
async function readAllBytes(store: BlobStore, key: BlobKey): Promise<Buffer> {
  const read = await store.read(key);
  if (!read.ok) throw new Error(`blob read must succeed: ${JSON.stringify(read)}`);
  const parts: Uint8Array[] = [];
  for await (const element of read.bytes) {
    expect(element.ok).toBe(true);
    if (!element.ok) throw new Error(`blob stream element failed: ${JSON.stringify(element)}`);
    parts.push(element.chunk);
  }
  await read.close();
  return Buffer.concat(parts);
}

describe("Phase 5 Batch 1 internal integration acceptance (plan §4 slice 6)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  it("file-backed PGlite + local BlobStore: prepare→PUT→commit→bind, close/reopen on the same roots, replay, second commit, old snapshot immutability", async () => {
    // ---- stage 0: one REAL mkdtemp root. `dataDir` is the existing root
    // itself (PGlite creates <dataDir>/pgdata); the blob root is a sibling
    // the store creates recursively on first write.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `loopzhb-p5b1-e2e-${process.pid}-`));
    dirs.push(root);
    const dataDir = root;
    const blobRoot = path.join(root, "blobs");
    expect((await fs.stat(root)).isDirectory()).toBe(true);

    // Deterministic seam: one clock across the reopen, id counters that
    // PERSIST across it (see header).
    const clock = new FakeClock();
    let syncSeq = 0;
    let manifestSeq = 0;
    const attribution = staticAttribution({ "m-1": "ns-1" });

    // ---- stage 1: open the file-backed DB + a local store; nothing exists
    // yet ("no loop" and "no blobs" are the real starting state).
    const h1 = await openMigratedDb({ dataDir });
    handles.push(h1);
    let db: Db = h1.db;
    let store: BlobStore = createLocalBlobStore({ rootDir: blobRoot });
    const deps = (): ArtifactHomeDeps => ({
      db,
      clock,
      ids: { syncId: () => `sync-${++syncSeq}`, manifestId: () => `amf-${++manifestSeq}` },
      blobStore: store,
      attribution,
    });
    const getLoop = async (): Promise<Loop> => (await db.select().from(loops).where(eq(loops.id, "loop-1")))[0]!;
    const getRun = async (): Promise<Run> => (await db.select().from(runs).where(eq(runs.id, "run-1")))[0]!;
    expect(h1.dataDir).toBe(dataDir);
    expect(await readCurrentArtifactView(db, "loop-1")).toBeUndefined();

    // ---- stage 2: the four-party machine chain (manifest = run = loop =
    // trusted attribution, all "m-1"; the loop starts UNCONFIGURED).
    await seedMachine(db, "m-1");
    await seedLoop(db, { id: "loop-1", machineId: "m-1", workdir: "/home/user/project" });
    await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", phase: "running", role: "exec" });

    // ---- stage 3: the config WRITE path (not a hand-set column) — a real
    // "changed" outcome at generation 0 → 1. A silent noop would prove
    // nothing, so the outcome is asserted.
    const cfg = await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data" });
    expect(cfg).toMatchObject({ ok: true, outcome: "changed" });
    expect(await getLoop()).toMatchObject({
      artifactDir: "/data",
      artifactConfigRevision: 1,
      artifactManifestRevision: 0,
      artifactManifestId: null,
      artifactSyncAttemptedAt: null,
      artifactSyncSucceededAt: null,
      artifactSyncError: null,
    });

    // ---- stage 4: prepare negotiates BOTH hashes (nothing has ever been
    // uploaded).
    const contentA = bytesOf("alpha: the original a.txt payload");
    const contentA2 = bytesOf("alpha: the second-generation payload!");
    const contentB = patternBytes(4096);
    const HASH_A = hashOf(contentA);
    const HASH_A2 = hashOf(contentA2);
    const HASH_B = hashOf(contentB);
    const req1: PrepareArtifactSyncRequest = {
      requestId: "req-1",
      loopId: "loop-1",
      configRevision: 1,
      baseManifestRevision: 0,
      entries: [
        { path: "a.txt", hash: HASH_A, size: contentA.byteLength },
        { path: "b.bin", hash: HASH_B, size: contentB.byteLength },
      ],
    };
    const p1 = await prepareArtifactSync(deps(), { machineId: "m-1" }, req1);
    if (!p1.ok) throw new Error(`prepare 1 must succeed: ${JSON.stringify(p1)}`);
    expect(p1).toMatchObject({ ok: true, outcome: "created" });
    expect(p1.response.syncId).toBe("sync-1");
    expect([...p1.response.needHashes].sort()).toEqual([HASH_A, HASH_B].sort());

    // ---- stage 5: PUT the real byte streams, driven BY the negotiation.
    const putA = await putArtifactBlob(deps(), { machineId: "m-1" }, {
      syncId: "sync-1",
      hash: HASH_A,
      bytes: chunks(contentA, 7),
    });
    expect(putA).toEqual({ ok: true, size: contentA.byteLength, published: true });
    const putB = await putArtifactBlob(deps(), { machineId: "m-1" }, {
      syncId: "sync-1",
      hash: HASH_B,
      bytes: chunks(contentB, 1000),
    });
    expect(putB).toEqual({ ok: true, size: contentB.byteLength, published: true });

    // ---- stage 6: commit — the receipt and the WHOLE immutable manifest
    // row, exactly.
    const c1 = await commitArtifactSync(deps(), { machineId: "m-1" }, { syncId: "sync-1" });
    if (!c1.ok) throw new Error(`commit 1 must succeed: ${JSON.stringify(c1)}`);
    expect(c1.receipt).toEqual({ artifactSnapshotId: "amf-1", manifestRevision: 1 });
    const manifest1 = (await readArtifactSnapshot(db, "amf-1"))!;
    expect(manifest1).toEqual({
      id: "amf-1",
      namespaceId: "ns-1",
      machineId: "m-1",
      loopId: "loop-1",
      configRevision: 1,
      manifestRevision: 1,
      entries: [
        { path: "a.txt", hash: HASH_A, size: contentA.byteLength },
        { path: "b.bin", hash: HASH_B, size: contentB.byteLength },
      ],
      fileCount: 2,
      totalBytes: contentA.byteLength + contentB.byteLength,
      committedAt: clock.iso(),
    });
    expect(await getLoop()).toMatchObject({
      artifactManifestId: "amf-1",
      artifactManifestRevision: 1,
      artifactSyncAttemptedAt: clock.iso(),
      artifactSyncSucceededAt: clock.iso(),
      artifactSyncError: null,
    });

    // ---- stage 7: the current view reflects the commit.
    const view1 = await readCurrentArtifactView(db, "loop-1");
    expect(view1).toEqual({
      artifactDir: "/data",
      configRevision: 1,
      manifestRevision: 1,
      manifestId: "amf-1",
      manifest: manifest1,
      stale: false,
    });

    // ---- stage 8: bind the snapshot to the Run INSIDE A TEST TRANSACTION
    // (the slice-2 plan/apply building block), publishing the verified
    // manifest id through the guarded write.
    const runBefore = await getRun();
    const loopBefore = await getLoop();
    const plan = planArtifactSnapshotBinding({
      run: runBefore,
      loop: loopBefore,
      manifest: manifest1,
      snapshotId: "amf-1",
      attribution: { namespaceId: "ns-1", machineId: "m-1" },
    });
    expect(plan).toEqual({ kind: "bind", runWrites: { artifactSnapshotId: "amf-1" }, guardConfigRevision: 1 });
    await db.transaction(async (tx) => {
      await applyArtifactBindingPlan(tx, runBefore, plan);
    });
    expect(await getRun()).toMatchObject({ artifactSnapshotId: "amf-1", artifactSyncError: null });

    // ---- stage 9: the bytes are real — through the adapter AND on disk.
    expect(await readAllBytes(store, { namespaceId: "ns-1", hash: HASH_A })).toEqual(Buffer.from(contentA));
    expect(await readAllBytes(store, { namespaceId: "ns-1", hash: HASH_B })).toEqual(Buffer.from(contentB));
    expect(await fs.readFile(path.join(blobRoot, "ns-1", HASH_A))).toEqual(Buffer.from(contentA));
    expect(await fs.readFile(path.join(blobRoot, "ns-1", HASH_B))).toEqual(Buffer.from(contentB));

    // ---- stage 10: close the database for real.
    await closeDb(h1);
    handles.splice(handles.indexOf(h1), 1);

    // ---- stage 11: REOPEN on the same dataDir (migrations re-run must be a
    // no-op — AM5's idempotence, now across instantiations) + a NEW store
    // instance over the same blob root (the restarted process).
    const h2 = await openMigratedDb({ dataDir });
    handles.push(h2);
    db = h2.db;
    store = createLocalBlobStore({ rootDir: blobRoot });

    // ---- stage 12: everything persisted, compared EXACTLY.
    expect(await readArtifactSnapshot(db, "amf-1")).toEqual(manifest1);
    expect(await readCurrentArtifactView(db, "loop-1")).toEqual(view1);
    expect(await getRun()).toMatchObject({ artifactSnapshotId: "amf-1", artifactSyncError: null });
    expect(await readAllBytes(store, { namespaceId: "ns-1", hash: HASH_A })).toEqual(Buffer.from(contentA));
    expect(await readAllBytes(store, { namespaceId: "ns-1", hash: HASH_B })).toEqual(Buffer.from(contentB));
    const session1 = (await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, "sync-1")))[0]!;
    expect(session1.receipt).toEqual({ artifactSnapshotId: "amf-1", manifestRevision: 1 });

    // ---- stage 13: retry the SAME commit — the stored receipt verbatim, no
    // second record, and ZERO writes (the whole loops row is item-equal).
    const loopsBeforeReplay = await snapshotLoops(db);
    const replay1 = await commitArtifactSync(deps(), { machineId: "m-1" }, { syncId: "sync-1" });
    expect(replay1).toEqual(c1);
    expect(await snapshotLoops(db)).toEqual(loopsBeforeReplay);
    expect(await db.select().from(artifactManifests)).toHaveLength(1);
    expect(await db.select().from(artifactSyncSessions)).toHaveLength(1);

    // ---- stage 14: commit a file CHANGE — a new session, a new snapshot.
    // The negotiation proves incrementality across the restart: only the
    // changed path's hash is needed again (its metadata row survives AND its
    // file is really present for the real store).
    const req2: PrepareArtifactSyncRequest = {
      requestId: "req-2",
      loopId: "loop-1",
      configRevision: 1,
      baseManifestRevision: 1,
      entries: [
        { path: "a.txt", hash: HASH_A2, size: contentA2.byteLength },
        { path: "b.bin", hash: HASH_B, size: contentB.byteLength },
      ],
    };
    const p2 = await prepareArtifactSync(deps(), { machineId: "m-1" }, req2);
    if (!p2.ok) throw new Error(`prepare 2 must succeed: ${JSON.stringify(p2)}`);
    expect(p2).toMatchObject({ ok: true, outcome: "created" });
    expect(p2.response.syncId).toBe("sync-2");
    expect(p2.response.needHashes).toEqual([HASH_A2]);
    const putA2 = await putArtifactBlob(deps(), { machineId: "m-1" }, {
      syncId: "sync-2",
      hash: HASH_A2,
      bytes: chunks(contentA2, 5),
    });
    expect(putA2).toEqual({ ok: true, size: contentA2.byteLength, published: true });
    const c2 = await commitArtifactSync(deps(), { machineId: "m-1" }, { syncId: "sync-2" });
    if (!c2.ok) throw new Error(`commit 2 must succeed: ${JSON.stringify(c2)}`);
    expect(c2.receipt).toEqual({ artifactSnapshotId: "amf-2", manifestRevision: 2 });

    // ---- stage 15: the OLD snapshot is immutable, its blobs stay put, and
    // the current view moved to the new one.
    expect(await readArtifactSnapshot(db, "amf-1")).toEqual(manifest1);
    expect(await readArtifactSnapshot(db, "amf-2")).toEqual({
      id: "amf-2",
      namespaceId: "ns-1",
      machineId: "m-1",
      loopId: "loop-1",
      configRevision: 1,
      manifestRevision: 2,
      entries: [
        { path: "a.txt", hash: HASH_A2, size: contentA2.byteLength },
        { path: "b.bin", hash: HASH_B, size: contentB.byteLength },
      ],
      fileCount: 2,
      totalBytes: contentA2.byteLength + contentB.byteLength,
      committedAt: clock.iso(),
    });
    expect(await db.select().from(artifactManifests)).toHaveLength(2);
    expect(await readAllBytes(store, { namespaceId: "ns-1", hash: HASH_A })).toEqual(Buffer.from(contentA));
    const view2 = await readCurrentArtifactView(db, "loop-1");
    expect(view2).toEqual({
      artifactDir: "/data",
      configRevision: 1,
      manifestRevision: 2,
      manifestId: "amf-2",
      manifest: await readArtifactSnapshot(db, "amf-2"),
      stale: false,
    });

    // ---- stage 16: replay the OLD commit — its own receipt, and the
    // current pointer does NOT regress (again: zero writes).
    const loopsBeforeOldReplay = await snapshotLoops(db);
    const replayOld = await commitArtifactSync(deps(), { machineId: "m-1" }, { syncId: "sync-1" });
    expect(replayOld).toEqual(c1);
    expect(await getLoop()).toMatchObject({
      artifactManifestId: "amf-2",
      artifactManifestRevision: 2,
      artifactSyncSucceededAt: clock.iso(),
    });
    expect(await snapshotLoops(db)).toEqual(loopsBeforeOldReplay);
    expect(await db.select().from(artifactManifests)).toHaveLength(2);

    // ---- stage 17: the real blob root holds exactly the three published
    // blobs — no `.tmp-*` residue from any failed or completed upload.
    expect((await fs.readdir(path.join(blobRoot, "ns-1"))).sort()).toEqual([HASH_A, HASH_A2, HASH_B].sort());
  });
});
