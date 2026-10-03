/**
 * AC1/AC2/AC3/AC7/AC10 (+ AM6 session-generation commit leg + AB8 commit half
 * + A4-3 verified-size reuse + manifest_revision_exhausted) — ArtifactHome
 * commit (ADR-010 决策 11/12, Phase 5 Batch 1 slice 4):
 *
 *  plan (pure):   planCommitPrecheck's fixed order — receipt → expired →
 *                 config → base → exhausted → proceed.
 *  commit (real PGlite):
 *                 AC1 full replace lands pointer + manifest + success stamp;
 *                 AC2 absence-deletion and the legal empty manifest; AC3
 *                 blob_missing / storage_error keep the old view and stamp
 *                 the wire code, an in-tx failure rolls back EVERYTHING;
 *                 AC7 receipt replay (repeat, restart, no pointer regress,
 *                 survives config bumps and TTL); commit adjudication
 *                 observes the (loop, session) pair LOOP-FIRST, SESSION-
 *                 SECOND, so a same-session winner landing between the two
 *                 out-of-tx reads is replayed — never a bogus conflict
 *                 stamped over the winner's success (A4-1 Round 2); the
 *                 transaction re-observes the LIVE pair in the same order
 *                 and decides receipt-first (convergence), the pending TTL
 *                 is re-checked against a fresh clock, the loop↔session
 *                 attribution association is re-verified (A4-1); AC10
 *                 snapshot immutability and binding through the slice-2
 *                 plan/apply with REAL committed manifests; AM6
 *                 old-generation refusal incl. the generation-guarded failure
 *                 stamp; the bounded guard-retry (loop-vanish retry,
 *                 unique-violation RaceLost bound).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { ARTIFACT_SYNC_SESSION_TTL_MILLIS, type PrepareArtifactSyncRequest } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import {
  artifactBlobs,
  artifactManifests,
  artifactSyncSessions,
  loops,
  runs,
  type ArtifactManifestRow,
  type Loop,
} from "../db/schema.js";
import { REVISION_INT32_MAX } from "../schedule/transition.js";
import { FakeClock, seedLoop, seedMachine, seedRun, snapshotLoops } from "../testkit/index.js";
import type { ArtifactAttributionResolver } from "./attribution.js";
import { applyArtifactBindingPlan, planArtifactSnapshotBinding } from "./binding-plan.js";
import { createMemoryBlobStore, type MemoryBlobStoreFaults } from "./blob-store-memory.js";
import type { BlobStore } from "./blob-store.js";
import { readCurrentArtifactView, updateArtifactConfig } from "./config.js";
import {
  ArtifactSyncRaceLostError,
  commitArtifactSync,
  planCommitPrecheck,
  prepareArtifactSync,
  putArtifactBlob,
  readArtifactSnapshot,
  type ArtifactHomeDeps,
} from "./sync.js";

// ---- shared fixture helpers ----

function bytesOf(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function hashOf(content: string): string {
  return createHash("sha256").update(bytesOf(content)).digest("hex");
}

const CONTENT_A = "aaa";
const CONTENT_B = "bbb";
const HASH_A = hashOf(CONTENT_A);
const HASH_B = hashOf(CONTENT_B);

function makeRequest(overrides: Partial<PrepareArtifactSyncRequest> = {}): PrepareArtifactSyncRequest {
  return {
    requestId: "req-1",
    loopId: "loop-1",
    configRevision: 0,
    baseManifestRevision: 0,
    entries: [
      { path: "a.txt", hash: HASH_A, size: 3 },
      { path: "b.txt", hash: HASH_B, size: 3 },
    ],
    ...overrides,
  };
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

describe("planCommitPrecheck (pure)", () => {
  const session = {
    receipt: null,
    expiresAt: "2026-07-29T01:00:00.000Z",
    configRevision: 1,
    baseManifestRevision: 2,
  };
  const loop = { artifactConfigRevision: 1, artifactManifestRevision: 2 };
  const NOW = "2026-07-29T00:30:00.000Z";

  it("a stored receipt replays FIRST — past expiry and across generations", () => {
    const committed = { ...session, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 2 } };
    const drifted = { artifactConfigRevision: 9, artifactManifestRevision: 9 };
    expect(planCommitPrecheck({ session: committed, loop: drifted, nowIso: "2027-01-01T00:00:00.000Z" })).toEqual({
      kind: "receipt",
    });
  });

  it("an expired pending session rejects before the generation checks (now == expiresAt is expired)", () => {
    expect(planCommitPrecheck({ session, loop, nowIso: session.expiresAt })).toEqual({ kind: "expired" });
    const drifted = { artifactConfigRevision: 9, artifactManifestRevision: 9 };
    expect(planCommitPrecheck({ session, loop: drifted, nowIso: session.expiresAt })).toEqual({ kind: "expired" });
  });

  it("generation drift → config_conflict; base drift → manifest_conflict", () => {
    expect(
      planCommitPrecheck({ session, loop: { ...loop, artifactConfigRevision: 2 }, nowIso: NOW }),
    ).toEqual({ kind: "config_conflict" });
    expect(
      planCommitPrecheck({ session, loop: { ...loop, artifactManifestRevision: 3 }, nowIso: NOW }),
    ).toEqual({ kind: "manifest_conflict" });
  });

  it("exhaustion is checked last — only when a commit would otherwise proceed", () => {
    const atCeiling = { ...session, baseManifestRevision: REVISION_INT32_MAX };
    const loopAtCeiling = { ...loop, artifactManifestRevision: REVISION_INT32_MAX };
    expect(planCommitPrecheck({ session: atCeiling, loop: loopAtCeiling, nowIso: NOW })).toEqual({ kind: "exhausted" });
    // …but a base drift still wins over the ceiling.
    expect(planCommitPrecheck({ session, loop: loopAtCeiling, nowIso: NOW })).toEqual({ kind: "manifest_conflict" });
  });

  it("all clear → proceed", () => {
    expect(planCommitPrecheck({ session, loop, nowIso: NOW })).toEqual({ kind: "proceed" });
  });
});

describe("commit (real PGlite + memory BlobStore)", () => {
  const handles: DbHandle[] = [];
  let db: Db;
  let clock: FakeClock;
  let store: BlobStore;
  let deps: ArtifactHomeDeps;
  let syncSeq = 0;
  let manifestSeq = 0;

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  });

  function makeDeps(dbHandle: Db, options: { hooks?: ArtifactHomeDeps["hooks"]; blobStore?: BlobStore } = {}): ArtifactHomeDeps {
    return {
      db: dbHandle,
      clock,
      ids: { syncId: () => `sync-${++syncSeq}`, manifestId: () => `amf-${++manifestSeq}` },
      blobStore: options.blobStore ?? store,
      attribution: staticAttribution({ "m-1": "ns-1" }),
      hooks: options.hooks,
    };
  }

  async function fresh(
    options: { faults?: MemoryBlobStoreFaults; hooks?: ArtifactHomeDeps["hooks"] } = {},
  ): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock();
    syncSeq = 0;
    manifestSeq = 0;
    store = createMemoryBlobStore({ faults: options.faults });
    await seedMachine(db, "m-1");
    deps = makeDeps(db, options);
  }

  async function seedConfiguredLoop(overrides: Partial<typeof loops.$inferInsert> = {}): Promise<void> {
    await seedLoop(db, {
      id: "loop-1",
      machineId: "m-1",
      workdir: "/home/user/project",
      artifactDir: "/data",
      ...overrides,
    });
  }

  async function negotiate(overrides: Partial<PrepareArtifactSyncRequest> = {}): Promise<string> {
    const result = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest(overrides));
    if (!result.ok) throw new Error(`negotiate fixture must succeed: ${JSON.stringify(result)}`);
    return result.response.syncId;
  }

  async function put(syncId: string, content: string): Promise<void> {
    const bytes = bytesOf(content);
    const result = await putArtifactBlob(deps, { machineId: "m-1" }, {
      syncId,
      hash: hashOf(content),
      bytes: (async function* () {
        yield bytes;
      })(),
    });
    if (!result.ok) throw new Error(`put fixture must succeed: ${JSON.stringify(result)}`);
  }

  function commit(syncId: string) {
    return commitArtifactSync(deps, { machineId: "m-1" }, { syncId });
  }

  async function getLoop(): Promise<Loop> {
    return (await db.select().from(loops).where(eq(loops.id, "loop-1")))[0]!;
  }

  async function manifests(): Promise<ArtifactManifestRow[]> {
    return db.select().from(artifactManifests);
  }

  /** The full successful sync: negotiate (a.txt + b.txt) → PUT both → commit. */
  async function fullSync(overrides: Partial<PrepareArtifactSyncRequest> = {}) {
    const syncId = await negotiate(overrides);
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    const result = await commit(syncId);
    if (!result.ok) throw new Error(`commit fixture must succeed: ${JSON.stringify(result)}`);
    return { syncId, receipt: result.receipt };
  }

  it("AC1: a full sync commits the complete manifest — pointer, success stamp, immutable row, stored receipt", async () => {
    await fresh();
    await seedConfiguredLoop();
    const before = await getLoop();

    const { syncId, receipt } = await fullSync();
    expect(receipt).toEqual({ artifactSnapshotId: "amf-1", manifestRevision: 1 });

    const view = await readCurrentArtifactView(db, "loop-1");
    expect(view).toMatchObject({ manifestId: "amf-1", manifestRevision: 1, stale: false });
    expect(view!.manifest!.entries).toEqual([
      { path: "a.txt", hash: HASH_A, size: 3 },
      { path: "b.txt", hash: HASH_B, size: 3 },
    ]);

    const manifest = (await manifests())[0]!;
    expect(manifest).toMatchObject({
      id: "amf-1",
      namespaceId: "ns-1",
      machineId: "m-1",
      loopId: "loop-1",
      configRevision: 0,
      manifestRevision: 1,
      fileCount: 2,
      totalBytes: 6,
      committedAt: clock.iso(),
    });

    const after = await getLoop();
    expect(after.artifactManifestId).toBe("amf-1");
    expect(after.artifactManifestRevision).toBe(1);
    // The success stamp: attempt + success at the commit time, error cleared.
    expect([after.artifactSyncAttemptedAt, after.artifactSyncSucceededAt, after.artifactSyncError]).toEqual([
      clock.iso(),
      clock.iso(),
      null,
    ]);
    expect(after.revision).toBe(before.revision + 1);
    // Other domains' counters are untouched.
    expect([after.goalRevision, after.scheduleRevision]).toEqual([before.goalRevision, before.scheduleRevision]);

    const session = (await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)))[0]!;
    expect(session.receipt).toEqual(receipt);
  });

  it("AC2: absence deletes — the next manifest replaces the view wholesale; an empty manifest is legal", async () => {
    await fresh();
    await seedConfiguredLoop();
    await fullSync();

    // Second sync drops b.txt by ABSENCE. a.txt's blob is already verified —
    // needHashes is empty, nothing to upload.
    const second = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ requestId: "req-2", baseManifestRevision: 1, entries: [{ path: "a.txt", hash: HASH_A, size: 3 }] }),
    );
    expect(second).toMatchObject({ ok: true, response: { needHashes: [] } });
    if (!second.ok) throw new Error("unreachable");
    const commit2 = await commit(second.response.syncId);
    expect(commit2).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-2", manifestRevision: 2 } });
    expect((await readCurrentArtifactView(db, "loop-1"))!.manifest!.entries).toEqual([
      { path: "a.txt", hash: HASH_A, size: 3 },
    ]);

    // Third sync: the confirmed-empty directory commits an EMPTY manifest.
    const third = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ requestId: "req-3", baseManifestRevision: 2, entries: [] }),
    );
    if (!third.ok) throw new Error("unreachable");
    const commit3 = await commit(third.response.syncId);
    expect(commit3).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-3", manifestRevision: 3 } });
    const view = await readCurrentArtifactView(db, "loop-1");
    expect(view!.manifest).toMatchObject({ id: "amf-3", entries: [], fileCount: 0, totalBytes: 0 });
  });

  it("AC3/AB8: a negotiated blob never uploaded refuses the commit (blob_missing), keeps the old view, stamps the wire code — and the resume class works", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await put(syncId, CONTENT_A); // b.txt never uploaded
    const loopsBefore = await snapshotLoops(db);

    const refused = await commit(syncId);
    expect(refused).toEqual({ ok: false, failure: "blob_missing" });
    // The old view is fully preserved; the failure is stamped with the WIRE code.
    const after = await getLoop();
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual([null, 0]);
    expect(after.artifactSyncError).toBe("artifact_blob_missing");
    expect(after.artifactSyncAttemptedAt).toBe(clock.iso());
    expect(after.artifactSyncSucceededAt).toBeNull();
    expect(after.revision).toBe(loopsBefore[0]!.revision + 1); // the stamp's own bump only
    expect(await manifests()).toHaveLength(0);

    // resume: upload the missing blob, retry the SAME commit — succeeds and
    // clears the stamped error.
    await put(syncId, CONTENT_B);
    const retried = await commit(syncId);
    expect(retried).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } });
    const settled = await getLoop();
    expect([settled.artifactSyncError, settled.artifactSyncSucceededAt]).toEqual([null, clock.iso()]);
  });

  it("AB8: a metadata row whose FILE is gone refuses the commit (blob_missing), not a silent pass", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    // Row WITHOUT the store write — the out-of-band file loss shape.
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_A, size: 3, verifiedAt: clock.iso() });
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_B, size: 3, verifiedAt: clock.iso() });

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "blob_missing" });
    expect((await getLoop()).artifactSyncError).toBe("artifact_blob_missing");
    expect(await manifests()).toHaveLength(0);
  });

  it("A4-3: a negotiated size contradicting the verified blob is never reused — prepare re-demands the hash, PUT re-verifies, commit refuses (cross-session)", async () => {
    await fresh();
    await seedConfiguredLoop();
    // Session 1 uploads aaa (3 bytes, declared 3) and commits for real.
    const s1 = await negotiate({ entries: [{ path: "a.txt", hash: HASH_A, size: 3 }] });
    await put(s1, CONTENT_A);
    expect((await commit(s1)).ok).toBe(true);

    // Session 2 declares the SAME hash with a LYING size 0. The verified row
    // (size 3) does not back the negotiated entry — prepare re-demands the
    // hash instead of reporting needHashes=[] (the pre-fix shape, which let
    // the commit land totalBytes 0 over a 3-byte blob).
    const second = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ requestId: "req-2", baseManifestRevision: 1, entries: [{ path: "a.txt", hash: HASH_A, size: 0 }] }),
    );
    expect(second).toMatchObject({ ok: true, response: { needHashes: [HASH_A] } });
    if (!second.ok) throw new Error("unreachable");

    // The dedup path never launders the lie: PUT re-verifies the bytes
    // against the DECLARED size 0 (overrun → content_mismatch).
    const reupload = await putArtifactBlob(deps, { machineId: "m-1" }, {
      syncId: second.response.syncId,
      hash: HASH_A,
      bytes: (async function* () {
        yield bytesOf(CONTENT_A);
      })(),
    });
    expect(reupload).toEqual({ ok: false, failure: "content_mismatch" });

    // Commit refuses the inconsistent snapshot — the old view stands and the
    // wire code stamps (the blob AS NEGOTIATED is missing).
    const refused = await commit(second.response.syncId);
    expect(refused).toEqual({ ok: false, failure: "blob_missing" });
    const afterRefusal = await getLoop();
    expect([afterRefusal.artifactManifestId, afterRefusal.artifactManifestRevision]).toEqual(["amf-1", 1]);
    expect(afterRefusal.artifactSyncError).toBe("artifact_blob_missing");
    expect(await manifests()).toHaveLength(1); // only session 1's snapshot

    // An honest re-declaration (size 3) dedups cleanly — nothing to upload,
    // the commit lands, and the manifest's totalBytes matches verified truth.
    const third = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ requestId: "req-3", baseManifestRevision: 1, entries: [{ path: "a.txt", hash: HASH_A, size: 3 }] }),
    );
    expect(third).toMatchObject({ ok: true, response: { needHashes: [] } });
    if (!third.ok) throw new Error("unreachable");
    const c3 = await commit(third.response.syncId);
    expect(c3).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-2", manifestRevision: 2 } });
    expect(await readArtifactSnapshot(db, "amf-2")).toMatchObject({ fileCount: 1, totalBytes: 3 });
    expect((await getLoop()).artifactSyncError).toBeNull(); // the success stamp cleared the refusal
  });

  it("AC3: a failure INSIDE the commit transaction rolls back everything — no manifest, no receipt, no pointer, no stamp", async () => {
    await fresh();
    await seedConfiguredLoop();
    let txHookCalls = 0;
    deps = makeDeps(db, {
      hooks: {
        insideCommitTx: () => {
          txHookCalls += 1;
          throw new Error("boom");
        },
      },
    });
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    const loopsBefore = await snapshotLoops(db);

    await expect(commit(syncId)).rejects.toThrow("boom");
    expect(txHookCalls).toBe(1); // a plain throw is NOT a guard loss — no retry
    expect(await manifests()).toHaveLength(0);
    expect((await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)))[0]!.receipt).toBeNull();
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("AC7: a repeated commit replays the SAME receipt — no second manifest, no revision bump, no pointer touch", async () => {
    await fresh();
    await seedConfiguredLoop();
    const { syncId, receipt } = await fullSync();
    const settled = await getLoop();

    const replay = await commit(syncId);
    expect(replay).toEqual({ ok: true, receipt });
    expect(await manifests()).toHaveLength(1);
    expect(await getLoop()).toEqual(settled); // the replay writes NOTHING
  });

  it("AC7: replaying an OLD session's commit after a newer one returns the original receipt and never regresses the pointer", async () => {
    await fresh();
    await seedConfiguredLoop();
    const first = await fullSync();
    // A newer session (new requestId, same content) commits a NEW snapshot —
    // identical content still mints a fresh id (决策 12).
    const secondSyncId = await negotiate({ requestId: "req-2", baseManifestRevision: 1 });
    const commit2 = await commit(secondSyncId);
    expect(commit2).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-2", manifestRevision: 2 } });

    const replay = await commit(first.syncId);
    expect(replay).toEqual({ ok: true, receipt: first.receipt });
    const after = await getLoop();
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual(["amf-2", 2]);
    expect(await manifests()).toHaveLength(2);
  });

  it("AC7: a restart recovers the receipt — a file-backed reopen replays it WITHOUT re-checking blobs", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `loopzhb-sync-${process.pid}-`));
    clock = new FakeClock();
    syncSeq = 0;
    manifestSeq = 0;
    store = createMemoryBlobStore();

    const h1 = await openMigratedDb({ dataDir });
    handles.push(h1);
    db = h1.db;
    deps = makeDeps(db);
    await seedMachine(db, "m-1");
    await seedConfiguredLoop();
    const { syncId, receipt } = await fullSync();
    await closeDb(h1);

    // Reopen the SAME data dir with a FRESH (empty) blob store — the replay
    // must come from the stored receipt alone.
    const h2 = await openMigratedDb({ dataDir });
    handles.push(h2);
    db = h2.db;
    store = createMemoryBlobStore();
    deps = makeDeps(db);

    const replayed = await commit(syncId);
    expect(replayed).toEqual({ ok: true, receipt });
    expect(await readArtifactSnapshot(db, receipt.artifactSnapshotId)).toMatchObject({ id: "amf-1", manifestRevision: 1 });
  });

  it("AC7/决策 11: the receipt survives a config generation change and the pending TTL (attribution-gated)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const { syncId, receipt } = await fullSync();

    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS * 2);
    const replay = await commit(syncId);
    expect(replay).toEqual({ ok: true, receipt });
    // …while the current view honestly reports the old manifest as stale.
    expect((await readCurrentArtifactView(db, "loop-1"))!.stale).toBe(true);
  });

  it("manifest_revision_exhausted: a commit at the int32 ceiling is a stable zero-write rejection", async () => {
    await fresh();
    await seedConfiguredLoop({ artifactManifestRevision: REVISION_INT32_MAX });
    const syncId = await negotiate({ entries: [], baseManifestRevision: REVISION_INT32_MAX });
    const loopsBefore = await snapshotLoops(db);

    const result = await commit(syncId);
    expect(result).toEqual({ ok: false, failure: "manifest_revision_exhausted" });
    expect(await manifests()).toHaveLength(0);
    expect((await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)))[0]!.receipt).toBeNull();
    expect(await snapshotLoops(db)).toEqual(loopsBefore); // not even a stamp
  });

  it("AM6 (session-generation, commit leg): an old-generation session can never commit into the new generation", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    const loopsBefore = await snapshotLoops(db);

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "config_conflict" });
    // config_conflict never stamps: the loop carries ONLY the config change.
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
    expect(await manifests()).toHaveLength(0);
  });

  it("AM6: an old-generation FAILURE stamp never touches the new generation's state (generation-guarded, zero rows, no retry)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    // A metadata row with no file behind it → the completeness check calls
    // has(); the wrapped store bumps the generation DURING that call (the
    // mid-flight config switch) and reports the file missing.
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_A, size: 3, verifiedAt: clock.iso() });
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_B, size: 3, verifiedAt: clock.iso() });
    const inner = store;
    const bumpingStore: BlobStore = {
      ...inner,
      has: async (key) => {
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
        return inner.has(key);
      },
    };
    deps = makeDeps(db, { blobStore: bumpingStore });

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "blob_missing" });
    const after = await getLoop();
    // The loop carries ONLY the competitor's config write: generation 1, the
    // sync triple CLEARED by the config change and NOT re-stamped by the
    // old-generation failure.
    expect(after.artifactConfigRevision).toBe(1);
    expect([after.artifactSyncAttemptedAt, after.artifactSyncSucceededAt, after.artifactSyncError]).toEqual([null, null, null]);
  });

  it("base competition: the second committer gets manifest_conflict and the stamped wire code; the winner's state stands", async () => {
    await fresh();
    await seedConfiguredLoop();
    // Two sessions, same base 0, different content (different keys).
    const s1 = await negotiate({ entries: [{ path: "a.txt", hash: HASH_A, size: 3 }] });
    const s2 = await negotiate({ requestId: "req-2", entries: [{ path: "b.txt", hash: HASH_B, size: 3 }] });
    await put(s1, CONTENT_A);
    await put(s2, CONTENT_B);

    const winner = await commit(s2);
    expect(winner).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } });

    const loser = await commit(s1);
    expect(loser).toEqual({ ok: false, failure: "manifest_conflict" });
    const after = await getLoop();
    expect(after.artifactSyncError).toBe("artifact_manifest_conflict");
    expect(after.artifactSyncAttemptedAt).toBe(clock.iso());
    expect(after.artifactSyncSucceededAt).toBe(clock.iso()); // the winner's success stamp stands
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual(["amf-1", 1]);
    expect(await manifests()).toHaveLength(1);
    expect((await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, s1)))[0]!.receipt).toBeNull();
  });

  it("a storage failure during the completeness check stamps artifact_storage_error", async () => {
    const faults: MemoryBlobStoreFaults = { notRegularKeys: new Set([`ns-1/${HASH_A}`]) };
    await fresh({ faults });
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_A, size: 3, verifiedAt: clock.iso() });
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_B, size: 3, verifiedAt: clock.iso() });

    await expect(commit(syncId)).resolves.toMatchObject({ ok: false, failure: "storage_error" });
    const after = await getLoop();
    expect(after.artifactSyncError).toBe("artifact_storage_error");
    expect(after.artifactSyncSucceededAt).toBeNull();
    expect(await manifests()).toHaveLength(0);
  });

  it("an expired session rejects WITHOUT stamping (no current-generation attempt exists)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    const loopsBefore = await snapshotLoops(db);

    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS);
    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "session_expired" });
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("the bounded retry: a loop vanishing mid-flight loses the guard, re-resolves once, and surfaces loop_not_found", async () => {
    await fresh();
    await seedConfiguredLoop();
    let competitorCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "commit") return;
        competitorCalls += 1;
        if (competitorCalls > 1) return;
        await db.delete(loops).where(eq(loops.id, "loop-1"));
      },
    };
    const syncId = await negotiate(); // negotiated BEFORE the hook-bearing deps swap
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    deps = makeDeps(db, { hooks });

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "loop_not_found" });
    // The seam fired exactly ONCE: attempt 1 entered the tx and lost the
    // guard on the vanished loop; the bounded re-run's re-resolve observes
    // the deletion BEFORE the seam and surfaces loop_not_found.
    expect(competitorCalls).toBe(1);
    expect(await manifests()).toHaveLength(0); // attempt 1 rolled back fully
  });

  it("the retry bound: a persistent unique-key collision fails closed as ArtifactSyncRaceLostError after exactly two attempts", async () => {
    await fresh();
    await seedConfiguredLoop();
    let seamCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: () => {
        seamCalls += 1;
      },
    };
    const syncId = await negotiate({ entries: [] });
    deps = makeDeps(db, { hooks });
    // Out-of-band damage: an orphan manifest row already occupies
    // (loop-1, revision 1) — the in-tx insert violates the unique index on
    // BOTH attempts (defensive conversion → guard loss → bounded re-run).
    await db.insert(artifactManifests).values({
      id: "amf-orphan",
      namespaceId: "ns-1",
      machineId: "m-1",
      loopId: "loop-1",
      configRevision: 0,
      manifestRevision: 1,
      entries: [],
      fileCount: 0,
      totalBytes: 0,
      committedAt: clock.iso(),
    });

    await expect(commit(syncId)).rejects.toBeInstanceOf(ArtifactSyncRaceLostError);
    expect(seamCalls).toBe(2); // exactly the initial attempt + ONE re-run
    const after = await getLoop();
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual([null, 0]); // both attempts rolled back
    expect((await manifests()).map((m) => m.id)).toEqual(["amf-orphan"]);
  });

  it("AC7: a same-session commit landing between the precheck and the transaction converges — the loser replays the winner's receipt (A4-1)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);

    let competitorCalls = 0;
    let winnerReceipt: unknown = null;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "commit") return;
        competitorCalls += 1;
        if (competitorCalls > 1) return;
        // The winner commits the SAME session between the loser's precheck
        // and its transaction (hook-free deps — no recursion).
        const winner = await commitArtifactSync(makeDeps(db), { machineId: "m-1" }, { syncId });
        if (!winner.ok) throw new Error(`winner fixture must succeed: ${JSON.stringify(winner)}`);
        winnerReceipt = winner.receipt;
      },
    };
    deps = makeDeps(db, { hooks });

    const loser = await commit(syncId);
    // Converged: the loser's in-tx session re-verification sees the winner's
    // receipt and replays it verbatim — NOT a manifest_conflict (the pre-fix
    // shape: the base check predated the receipt guard).
    expect(loser).toEqual({ ok: true, receipt: winnerReceipt });
    expect(competitorCalls).toBe(1); // convergence needed no retry
    expect(await manifests()).toHaveLength(1); // exactly ONE snapshot
    const after = await getLoop();
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual(["amf-1", 1]);
  });

  it("AC7: a same-session commit landing BETWEEN the outer session probe and the loop read converges — the observation order closes the two-read window (A4-1 Round 2)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    const before = await getLoop();

    let winnerReceipt: unknown = null;
    let fired = 0;
    // A Db wrapper that fires a REAL same-session winner commit after the
    // loser's FIRST artifact_sync_sessions read returns its rows (unmodified —
    // the probe never fabricates rows or receipts, and the winner runs on
    // hook-free UNWRAPPED deps). The loser's loop read then observes the
    // winner's advanced base — the Round-2 window: pre-fix, the precheck
    // adjudicated on (stale session, fresh loop) and returned a bogus
    // manifest_conflict whose stamp ALSO overwrote the winner's success
    // triple; post-fix, the adjudicating session read placed AFTER the loop
    // observation sees the winner's receipt and replays it.
    let armed = true;
    const raced: Db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
        return (...args: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const select = (target.select as (...a: unknown[]) => any)(...args);
          const from = select.from.bind(select);
          select.from = (table: unknown) => {
            const query = from(table);
            if (table === artifactSyncSessions && armed) {
              const limit = query.limit.bind(query);
              query.limit = (n: number) =>
                (async () => {
                  const rows = await limit(n);
                  if (armed) {
                    armed = false;
                    fired += 1;
                    const winner = await commitArtifactSync(makeDeps(db), { machineId: "m-1" }, { syncId });
                    if (!winner.ok) throw new Error(`winner fixture must succeed: ${JSON.stringify(winner)}`);
                    winnerReceipt = winner.receipt;
                  }
                  return rows;
                })();
            }
            return query;
          };
          return select;
        };
      },
    });

    const loser = await commitArtifactSync({ ...deps, db: raced }, { machineId: "m-1" }, { syncId });

    // Converged: both sides return the SAME receipt …
    expect(loser).toEqual({ ok: true, receipt: winnerReceipt });
    expect(fired).toBe(1); // the race fired exactly once, on the probe read
    // … exactly ONE snapshot and ONE manifest-revision increment …
    expect(await manifests()).toHaveLength(1);
    const after = await getLoop();
    expect(after.artifactManifestId).toBe("amf-1");
    expect(after.artifactManifestRevision).toBe(before.artifactManifestRevision + 1);
    // … and the winner's success state was NOT overwritten by a bogus failure
    // stamp: the error field stays null (the Round-2 over-write evidence).
    expect([after.artifactSyncAttemptedAt, after.artifactSyncSucceededAt, after.artifactSyncError]).toEqual([
      clock.iso(),
      clock.iso(),
      null,
    ]);
  });

  it("the pending TTL is re-checked INSIDE the commit transaction — a clock advance past expiresAt aborts with zero writes (A4-1)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate({ entries: [] });
    const loopsBefore = await snapshotLoops(db);
    deps = makeDeps(db, {
      hooks: {
        afterResolve: (op) => {
          // now == expiresAt — the EXCLUSIVE bound makes the session expired
          // between the outer precheck and the transaction.
          if (op === "commit") clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS);
        },
      },
    });

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "session_expired" });
    expect(await snapshotLoops(db)).toEqual(loopsBefore); // expired never stamps
    expect(await manifests()).toHaveLength(0);
    expect((await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)))[0]!.receipt).toBeNull();
  });

  it("the loop↔session attribution association is re-verified INSIDE the commit transaction — a mid-flight migration is the leak-free session_not_found (A4-1)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate({ entries: [] });
    deps = makeDeps(db, {
      hooks: {
        afterResolve: async (op) => {
          if (op !== "commit") return;
          // An out-of-band machine migration lands between the outer resolve
          // (which saw m-1) and the transaction.
          await db.update(loops).set({ machineId: "m-2" }).where(eq(loops.id, "loop-1"));
        },
      },
    });

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "session_not_found" });
    // Zero commit writes: the loop carries only the competitor's migration.
    const after = await getLoop();
    expect(after.machineId).toBe("m-2");
    expect([after.artifactManifestId, after.artifactManifestRevision, after.artifactSyncAttemptedAt]).toEqual([null, 0, null]);
    expect(await manifests()).toHaveLength(0);
  });

  it("a competitor that bumps ONLY the unified OCC revision (an unrelated domain write) does NOT block the commit", async () => {
    await fresh();
    await seedConfiguredLoop();
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "commit") return;
        // The unrelated-write shape: revision bumps, artifact columns untouched.
        await db.update(loops).set({ updatedAt: clock.iso(), revision: sql`${loops.revision} + 1` }).where(eq(loops.id, "loop-1"));
      },
    };
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    deps = makeDeps(db, { hooks });

    // The in-tx re-checks are session-anchored (generation/base), so the
    // commit re-baselines on the live row and lands.
    await expect(commit(syncId)).resolves.toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } });
  });

  it("a generation bump between the precheck and the transaction aborts with zero writes (the in-tx re-check)", async () => {
    await fresh();
    await seedConfiguredLoop();
    let competitorCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "commit") return;
        competitorCalls += 1;
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
      },
    };
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    await put(syncId, CONTENT_B);
    deps = makeDeps(db, { hooks });
    const loopsBefore = await snapshotLoops(db);

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "config_conflict" });
    expect(competitorCalls).toBe(1); // an abort is a domain result — no retry
    // Zero commit writes: the loop carries only the competitor's config change.
    const after = await snapshotLoops(db);
    expect(after[0]!.artifactConfigRevision).toBe(loopsBefore[0]!.artifactConfigRevision + 1);
    expect(after[0]!.artifactSyncAttemptedAt).toBeNull();
    expect(await manifests()).toHaveLength(0);
    expect((await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)))[0]!.receipt).toBeNull();
  });

  it("AC10: committed snapshots are immutable — a later commit never touches the old manifest row", async () => {
    await fresh();
    await seedConfiguredLoop();
    const s1 = await negotiate({ entries: [{ path: "a.txt", hash: HASH_A, size: 3 }] });
    await put(s1, CONTENT_A);
    const c1 = await commit(s1);
    expect(c1).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } });
    const snapshot1 = await readArtifactSnapshot(db, "amf-1");
    expect(snapshot1).toMatchObject({ id: "amf-1", manifestRevision: 1 });

    const s2 = await negotiate({ requestId: "req-2", baseManifestRevision: 1, entries: [{ path: "b.txt", hash: HASH_B, size: 3 }] });
    await put(s2, CONTENT_B);
    const c2 = await commit(s2);
    expect(c2).toEqual({ ok: true, receipt: { artifactSnapshotId: "amf-2", manifestRevision: 2 } });

    expect(await readArtifactSnapshot(db, "amf-1")).toEqual(snapshot1);
    await expect(readArtifactSnapshot(db, "amf-ghost")).resolves.toBeNull();
  });

  it("AC10: a real committed snapshot binds to a running run; cross-resource references record the stable error and never bind", async () => {
    await fresh();
    await seedConfiguredLoop();
    const { receipt } = await fullSync();
    const loop = await getLoop();
    const manifest = await readArtifactSnapshot(db, receipt.artifactSnapshotId);
    if (!manifest) throw new Error("committed manifest must load");

    await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", phase: "running" });
    const run = (await db.select().from(runs).where(eq(runs.id, "run-1")))[0]!;

    // The binding success path — the snapshot id comes from the REAL receipt,
    // the manifest from the slice-4 loader.
    const bind = planArtifactSnapshotBinding({
      run,
      loop,
      manifest,
      snapshotId: receipt.artifactSnapshotId,
      attribution: { namespaceId: "ns-1", machineId: "m-1" },
    });
    expect(bind).toMatchObject({ kind: "bind", runWrites: { artifactSnapshotId: "amf-1" } });
    await applyArtifactBindingPlan(db, run, bind);
    const bound = (await db.select().from(runs).where(eq(runs.id, "run-1")))[0]!;
    expect([bound.artifactSnapshotId, bound.artifactSyncError]).toEqual(["amf-1", null]);

    // Cross-resource rejections record the stable error and never bind.
    const crossNamespace = planArtifactSnapshotBinding({
      run,
      loop,
      manifest,
      snapshotId: manifest.id,
      attribution: { namespaceId: "ns-other", machineId: "m-1" },
    });
    expect(crossNamespace).toMatchObject({ kind: "record_error", reason: "cross_namespace" });

    // An uncommitted / fabricated snapshot id (no committed manifest row).
    const ghost = planArtifactSnapshotBinding({
      run,
      loop,
      manifest: await readArtifactSnapshot(db, "amf-ghost"),
      snapshotId: "amf-ghost",
      attribution: { namespaceId: "ns-1", machineId: "m-1" },
    });
    expect(ghost).toMatchObject({ kind: "record_error", reason: "snapshot_not_committed" });

    // A stale config generation refuses the bind.
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    const staleLoop = await getLoop();
    const stale = planArtifactSnapshotBinding({
      run,
      loop: staleLoop,
      manifest,
      snapshotId: manifest.id,
      attribution: { namespaceId: "ns-1", machineId: "m-1" },
    });
    expect(stale).toMatchObject({ kind: "record_error", reason: "stale_config_generation" });

    // The run row still carries the ORIGINAL bind — none of the rejections
    // were applied (they would only be applied by the Batch 2 report path).
    const untouched = (await db.select().from(runs).where(eq(runs.id, "run-1")))[0]!;
    expect(untouched.artifactSnapshotId).toBe("amf-1");
  });
});
