/**
 * Artifact management reads are Team-Scoped (Phase 5 Batch 3 slice 5,
 * ADR-011 决策 26 / MG8). The load-bearing property is ORDER: the ownership
 * comparison happens BEFORE attribution, BEFORE the snapshot row is read and
 * BEFORE any blob is opened.
 *
 * The foreign fixtures are deliberately RESOLVABLE (attribution maps them, the
 * blobs exist): if the team check were dropped, these probes would return 200
 * with another team's bytes instead of failing at an absent dependency.
 */
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { createMemoryBlobStore } from "./blob-store-memory.js";
import type { ArtifactAttributionResolver } from "./attribution.js";
import type { BlobStore } from "./blob-store.js";
import {
  diffLoopSnapshots,
  openArtifactDownload,
  readLoopArtifactsView,
  readRunArtifactsView,
  type ArtifactReadHome,
  type ReadScope,
} from "./read.js";
import { seedArtifactBlob, seedArtifactManifest, TEST_TEAM_ID } from "../testkit/index.js";
import { seedLoop, seedMachine, seedRun } from "../testkit/index.js";

const TEAM_B = "t-ffffffffffffffff";
const CONTENT_A = "own-team bytes";
const CONTENT_B = "other-team bytes";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

interface Rig {
  db: Db;
  home: ArtifactReadHome;
  attributionCalls: () => number;
  storeReads: () => number;
  hashA: string;
  hashB: string;
}

async function fresh(): Promise<Rig> {
  const handle = await openMigratedDb();
  handles.push(handle);
  const db = handle.db;
  const inner = createMemoryBlobStore();
  let reads = 0;
  const store: BlobStore = {
    ...inner,
    read: (key) => {
      reads += 1;
      return inner.read(key);
    },
  };
  let calls = 0;
  const attribution: ArtifactAttributionResolver = {
    resolve: (machine) => {
      calls += 1;
      const namespaceId = machine.machineId === "m-a" ? "ns-a" : "ns-b";
      return Promise.resolve({ ok: true, namespaceId, machineId: machine.machineId });
    },
  };

  await seedMachine(db, "m-a", { teamId: TEST_TEAM_ID });
  await seedMachine(db, "m-b", { teamId: TEAM_B });
  await seedMachine(db, "m-u"); // unclaimed
  await seedLoop(db, { id: "loop-a", machineId: "m-a" });
  await seedLoop(db, { id: "loop-b", machineId: "m-b" });
  await seedLoop(db, { id: "loop-u", machineId: "m-u" });

  const blobA = await seedArtifactBlob(db, store, { namespaceId: "ns-a", bytes: new TextEncoder().encode(CONTENT_A) });
  const blobB = await seedArtifactBlob(db, store, { namespaceId: "ns-b", bytes: new TextEncoder().encode(CONTENT_B) });
  await seedArtifactManifest(db, {
    id: "amf-a",
    namespaceId: "ns-a",
    machineId: "m-a",
    loopId: "loop-a",
    entries: [{ path: "a.txt", hash: blobA.hash, size: blobA.size }],
  });
  await seedArtifactManifest(db, {
    id: "amf-b",
    namespaceId: "ns-b",
    machineId: "m-b",
    loopId: "loop-b",
    entries: [{ path: "b.txt", hash: blobB.hash, size: blobB.size }],
  });
  await seedRun(db, { id: "run-a", loopId: "loop-a", machineId: "m-a", artifactSnapshotId: "amf-a" });
  await seedRun(db, { id: "run-b", loopId: "loop-b", machineId: "m-b", artifactSnapshotId: "amf-b" });
  await seedRun(db, { id: "run-u", loopId: "loop-u", machineId: "m-u" });

  return {
    db,
    home: { db, attribution, blobStore: store },
    attributionCalls: () => calls,
    storeReads: () => reads,
    hashA: blobA.hash,
    hashB: blobB.hash,
  };
}

const teamA: ReadScope = { kind: "team", teamId: TEST_TEAM_ID };
const teamB: ReadScope = { kind: "team", teamId: TEAM_B };

describe("MG8: cross-team and unclaimed artifact reads fold into the flat 404", () => {
  it("loop view: foreign and unclaimed are loop_not_found; attribution is never consulted", async () => {
    const rig = await fresh();
    expect(await readLoopArtifactsView(rig.home, "loop-a", teamA)).toMatchObject({ ok: true });

    for (const loopId of ["loop-b", "loop-u"]) {
      expect(await readLoopArtifactsView(rig.home, loopId, teamA)).toEqual({ ok: false, failure: "loop_not_found" });
    }
    expect(rig.attributionCalls()).toBe(1); // only the own-team read above
  });

  it("run view: a foreign run is run_not_found, never a leaked snapshot", async () => {
    const rig = await fresh();
    expect(await readRunArtifactsView(rig.home, "run-a", teamA)).toMatchObject({ ok: true, response: { state: "bound" } });
    expect(await readRunArtifactsView(rig.home, "run-b", teamA)).toEqual({ ok: false, failure: "run_not_found" });
    expect(await readRunArtifactsView(rig.home, "run-u", teamA)).toEqual({ ok: false, failure: "run_not_found" });
  });

  it("download: cross-team is refused BEFORE the blob is opened (the bytes exist!)", async () => {
    const rig = await fresh();
    // Control: the foreign blob IS openable through the unscoped arm.
    const unscoped = await openArtifactDownload(
      rig.home,
      "loop-b",
      { snapshotId: "amf-b", path: "b.txt" },
      { kind: "unscoped" },
    );
    expect(unscoped.ok).toBe(true);
    if (unscoped.ok) await unscoped.stream.close();
    const readsAfterUnscoped = rig.storeReads();
    expect(readsAfterUnscoped).toBeGreaterThan(0);

    const refused = await openArtifactDownload(rig.home, "loop-b", { snapshotId: "amf-b", path: "b.txt" }, teamA);
    expect(refused).toEqual({ ok: false, failure: "loop_not_found" });
    expect(rig.storeReads()).toBe(readsAfterUnscoped); // NOT ONE additional open
  });

  it("diff: cross-team is loop_not_found before either snapshot is read", async () => {
    const rig = await fresh();
    expect(await diffLoopSnapshots(rig.home, "loop-b", { to: "amf-b" }, teamA)).toEqual({
      ok: false,
      failure: "loop_not_found",
    });
    expect(await diffLoopSnapshots(rig.home, "loop-u", { to: "amf-b" }, teamA)).toEqual({
      ok: false,
      failure: "loop_not_found",
    });
  });

  it("the owning team reads its own view, run, diff and download", async () => {
    const rig = await fresh();
    expect(await readLoopArtifactsView(rig.home, "loop-a", teamA)).toMatchObject({ ok: true });
    expect(await readRunArtifactsView(rig.home, "run-a", teamA)).toMatchObject({ ok: true, response: { state: "bound" } });
    expect(await diffLoopSnapshots(rig.home, "loop-a", { from: "amf-a", to: "amf-a" }, teamA)).toMatchObject({ ok: true });

    const opened = await openArtifactDownload(rig.home, "loop-a", { snapshotId: "amf-a", path: "a.txt" }, teamA);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    let bytes = "";
    for await (const chunk of opened.stream.bytes) if (chunk.ok) bytes += new TextDecoder().decode(chunk.chunk);
    expect(bytes).toBe(CONTENT_A);
    await opened.stream.close();
    expect(rig.hashA).toBeTruthy();
    expect(rig.hashB).toBeTruthy();
  });

  it("the same family of probes under the OTHER team sees the mirror image", async () => {
    const rig = await fresh();
    expect(await readLoopArtifactsView(rig.home, "loop-b", teamB)).toMatchObject({ ok: true });
    expect(await readLoopArtifactsView(rig.home, "loop-a", teamB)).toEqual({ ok: false, failure: "loop_not_found" });
  });
});
