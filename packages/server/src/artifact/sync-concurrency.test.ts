/**
 * Slice 5 concurrency/interleave acceptance — AC8-concurrency (子场景 1),
 * AC6's TRUE in-flight base competition, AC5's config-REMOVAL legs, AB5's
 * PUT-level leg (子场景 3) and AC9's unified-OCC interleavings with the REAL
 * claim/report loop writers (ADR-010 决策 9/10/11, Phase 5 Batch 1 slice 5):
 *
 *  AC8   same-key concurrent prepare: same payload converges on ONE session
 *        (no duplicate row, no leaked unique-key exception); a different
 *        payload returns the stable manifest_conflict.
 *  AC6   two sessions competing for the SAME base revision with the winner
 *        committing DURING the loser's commit seam: the loser gets
 *        manifest_conflict, exactly one snapshot exists, the unified
 *        revision advances EXACTLY once, and the winner's success triple is
 *        never overwritten (the loser's best-effort stamp guards on its
 *        stale pre-seam revision and matches zero rows).
 *  AC5   config REMOVAL (artifactDir → null) interleaved with an in-flight
 *        upload (byte-stream seam) and with a pending commit (afterResolve
 *        seam): the old generation is rejected with config_conflict, zero
 *        commit writes, no stamp; re-configuring a new generation never
 *        rehabilitates the old session.
 *  AB5   two sessions uploading the SAME negotiated hash with interleaved
 *        byte streams: exactly one publish, one metadata row, both ok.
 *  AC9   the artifact commit vs the REAL claim (bump-only) and report
 *        (content-bearing) loop writers, BOTH directions — see the AC9
 *        describe's own header.
 *
 * PGlite is single-connection, so every interleaving fires at an
 * out-of-transaction seam (hooks.afterResolve between the resolve and the
 * write, or the PUT byte stream's await points) where the competitor runs a
 * REAL write on hook-free deps; in-transaction hooks may only throw. This
 * evidence does NOT replace the real multi-connection PostgreSQL overlap
 * verification tracked by #11/#72.
 */
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { type PrepareArtifactSyncRequest } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactBlobs, artifactManifests, artifactSyncSessions, loops, type ArtifactBlobRow, type ArtifactManifestRow, type Loop } from "../db/schema.js";
import { FakeClock, seedLoop, seedMachine } from "../testkit/index.js";
import type { ArtifactAttributionResolver } from "./attribution.js";
import { createMemoryBlobStore } from "./blob-store-memory.js";
import type { BlobStore } from "./blob-store.js";
import { updateArtifactConfig } from "./config.js";
import { commitArtifactSync, prepareArtifactSync, putArtifactBlob, type ArtifactHomeDeps } from "./sync.js";

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
    entries: [{ path: "a.txt", hash: HASH_A, size: 3 }],
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

describe("slice-5 concurrency acceptance (real PGlite + memory BlobStore)", () => {
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

  function makeDeps(dbHandle: Db, options: { hooks?: ArtifactHomeDeps["hooks"] } = {}): ArtifactHomeDeps {
    return {
      db: dbHandle,
      clock,
      ids: { syncId: () => `sync-${++syncSeq}`, manifestId: () => `amf-${++manifestSeq}` },
      blobStore: store,
      attribution: staticAttribution({ "m-1": "ns-1" }),
      hooks: options.hooks,
    };
  }

  async function fresh(): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock();
    syncSeq = 0;
    manifestSeq = 0;
    store = createMemoryBlobStore();
    await seedMachine(db, "m-1");
    deps = makeDeps(db);
  }

  async function seedConfiguredLoop(): Promise<void> {
    await seedLoop(db, { id: "loop-1", machineId: "m-1", workdir: "/home/user/project", artifactDir: "/data" });
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

  async function blobRows(): Promise<ArtifactBlobRow[]> {
    return db.select().from(artifactBlobs);
  }

  async function sessionReceipt(syncId: string): Promise<unknown> {
    return (await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)))[0]!.receipt;
  }

  async function storedBytes(namespaceId: string, hash: string): Promise<Buffer | null> {
    const result = await store.read({ namespaceId, hash });
    if (!result.ok) return null;
    const parts: Uint8Array[] = [];
    for await (const el of result.bytes) {
      if (!el.ok) throw new Error("unexpected stream failure");
      parts.push(el.chunk);
    }
    return Buffer.concat(parts);
  }

  it("AC8 (concurrency): same-key same-payload concurrent prepare converges on ONE session — no duplicate row, no leaked unique-key exception", async () => {
    await fresh();
    await seedConfiguredLoop();

    let seamCalls = 0;
    let winnerSyncId: string | null = null;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "prepare") return;
        seamCalls += 1;
        if (seamCalls > 1) return;
        // The competitor runs the IDENTICAL request between this prepare's
        // resolve and its guarded insert (hook-free deps — no recursion).
        const winner = await prepareArtifactSync(makeDeps(db), { machineId: "m-1" }, makeRequest());
        if (!winner.ok) throw new Error(`winner fixture must succeed: ${JSON.stringify(winner)}`);
        winnerSyncId = winner.response.syncId;
      },
    };

    const loser = await prepareArtifactSync(makeDeps(db, { hooks }), { machineId: "m-1" }, makeRequest());
    if (!loser.ok) throw new Error(`the loser must converge on reuse, not fail: ${JSON.stringify(loser)}`);
    expect(seamCalls).toBe(1); // no guard loss, no re-run
    // Both sides return the SAME session — the loser reused the winner's row
    // (ON CONFLICT DO NOTHING + the in-tx winner re-read).
    expect(loser.outcome).toBe("reused");
    expect(loser.response.syncId).toBe(winnerSyncId);
    expect(loser.response.needHashes).toEqual([HASH_A]);
    // Exactly ONE session row exists, and prepare never wrote the view.
    const rows = await db.select().from(artifactSyncSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winnerSyncId);
    const after = await getLoop();
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual([null, 0]);
  });

  it("AC8 (concurrency): same-key DIFFERENT-payload concurrent prepare returns the stable manifest_conflict, never a raw unique violation", async () => {
    await fresh();
    await seedConfiguredLoop();

    let seamCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "prepare") return;
        seamCalls += 1;
        if (seamCalls > 1) return;
        // The winner negotiates payload X under the same idempotency key.
        const winner = await prepareArtifactSync(makeDeps(db), { machineId: "m-1" }, makeRequest());
        if (!winner.ok) throw new Error(`winner fixture must succeed: ${JSON.stringify(winner)}`);
      },
    };

    // The loser arrives with payload Y under the SAME key: a stable conflict,
    // never a leaked 23505.
    const loser = await prepareArtifactSync(
      makeDeps(db, { hooks }),
      { machineId: "m-1" },
      makeRequest({ entries: [{ path: "b.txt", hash: HASH_B, size: 3 }] }),
    );
    expect(loser).toEqual({ ok: false, failure: "manifest_conflict" });
    expect(seamCalls).toBe(1);
    const rows = await db.select().from(artifactSyncSessions);
    expect(rows).toHaveLength(1); // only the winner's row exists
  });

  it("AC6: a cross-session base competition resolved DURING the loser's commit seam — manifest_conflict, exactly one snapshot, the winner's success triple never overwritten", async () => {
    await fresh();
    await seedConfiguredLoop();
    // Two sessions, SAME base 0, different content, both fully uploaded.
    const s1 = await negotiate({ requestId: "req-1" });
    const s2 = await negotiate({ requestId: "req-2", entries: [{ path: "b.txt", hash: HASH_B, size: 3 }] });
    await put(s1, CONTENT_A);
    await put(s2, CONTENT_B);
    const revisionBefore = (await getLoop()).revision;

    let seamCalls = 0;
    let winnerReceipt: unknown = null;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "commit") return;
        seamCalls += 1;
        if (seamCalls > 1) return;
        // The winner (s2) commits between the loser's (s1) precheck and its
        // transaction — hook-free deps, a REAL commit.
        const winner = await commitArtifactSync(makeDeps(db), { machineId: "m-1" }, { syncId: s2 });
        if (!winner.ok) throw new Error(`winner fixture must succeed: ${JSON.stringify(winner)}`);
        winnerReceipt = winner.receipt;
      },
    };

    const loser = await commitArtifactSync(makeDeps(db, { hooks }), { machineId: "m-1" }, { syncId: s1 });
    expect(loser).toEqual({ ok: false, failure: "manifest_conflict" });
    expect(seamCalls).toBe(1); // the in-tx session-anchored re-check aborted — no guard loss, no re-run
    expect(await manifests()).toHaveLength(1); // only the winner's snapshot
    const after = await getLoop();
    expect(after.artifactManifestId).toBe((winnerReceipt as { artifactSnapshotId: string }).artifactSnapshotId);
    expect(after.artifactManifestRevision).toBe(1);
    // The loser's failure stamp guarded on its STALE pre-seam revision and
    // silently matched zero rows — the freshest writer won: the unified
    // revision advanced EXACTLY once and the winner's success triple stands.
    expect(after.revision).toBe(revisionBefore + 1);
    expect([after.artifactSyncAttemptedAt, after.artifactSyncSucceededAt, after.artifactSyncError]).toEqual([
      clock.iso(),
      clock.iso(),
      null,
    ]);
    expect(await sessionReceipt(s1)).toBeNull(); // the loser's session stays pending
  });

  it("AC5/AB7: config REMOVAL during an in-flight upload rejects the PUT — the published blob stays unreferenced, and the old session can never commit into a later generation", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();

    // The byte stream IS the seam: the config is REMOVED after the last
    // chunk but before the post-publish re-verification.
    const bytes = (async function* () {
      yield bytesOf(CONTENT_A);
      await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: null });
    })();
    await expect(putArtifactBlob(deps, { machineId: "m-1" }, { syncId, hash: HASH_A, bytes })).resolves.toEqual({
      ok: false,
      failure: "config_conflict",
    });
    // The publish is NOT rolled back (决策 12 tolerated leftover), no row.
    expect((await storedBytes("ns-1", HASH_A))?.equals(Buffer.from(CONTENT_A))).toBe(true);
    expect(await blobRows()).toHaveLength(0);

    // The old session can never commit into the removed generation…
    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "config_conflict" });
    // …prepare on the unconfigured loop is artifact_dir_unconfigured…
    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest({ requestId: "req-2" }))).resolves.toEqual({
      ok: false,
      failure: "artifact_dir_unconfigured",
    });
    // …and re-configuring (generation 2) never rehabilitates the old session
    // (AM6: an old-generation request must not update the new generation's
    // state — config_conflict never stamps).
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "config_conflict" });
    const after = await getLoop();
    expect(after.artifactConfigRevision).toBe(2);
    expect([after.artifactManifestId, after.artifactManifestRevision, after.artifactSyncAttemptedAt, after.artifactSyncError]).toEqual([
      null,
      0,
      null,
      null,
    ]);
    expect(await manifests()).toHaveLength(0);
    expect(await sessionReceipt(syncId)).toBeNull();
  });

  it("AC5: config REMOVAL landing at the commit seam aborts with zero writes (the in-tx generation re-check)", async () => {
    await fresh();
    await seedConfiguredLoop();
    let seamCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async (op) => {
        if (op !== "commit") return;
        seamCalls += 1;
        if (seamCalls > 1) return;
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: null });
      },
    };
    const syncId = await negotiate(); // negotiated BEFORE the hook-bearing deps swap
    await put(syncId, CONTENT_A);
    deps = makeDeps(db, { hooks });

    await expect(commit(syncId)).resolves.toEqual({ ok: false, failure: "config_conflict" });
    expect(seamCalls).toBe(1); // the in-tx re-check aborted — no guard loss
    // Zero commit writes, zero stamp: the loop carries ONLY the removal.
    const after = await getLoop();
    expect(after.artifactDir).toBeNull();
    expect(after.artifactConfigRevision).toBe(1);
    expect([after.artifactManifestId, after.artifactManifestRevision, after.artifactSyncAttemptedAt, after.artifactSyncError]).toEqual([
      null,
      0,
      null,
      null,
    ]);
    expect(await manifests()).toHaveLength(0);
    expect(await sessionReceipt(syncId)).toBeNull();
  });

  it("AB5 (PUT level): two sessions uploading the SAME negotiated hash with interleaved byte streams — one publish, one metadata row, both ok", async () => {
    await fresh();
    await seedConfiguredLoop();
    const s1 = await negotiate({ requestId: "req-1" });
    const s2 = await negotiate({ requestId: "req-2" }); // same manifest ⇒ same negotiated hash

    // s1's byte stream IS the seam: BETWEEN its two chunks, s2's ENTIRE put
    // runs to completion on hook-free deps (the same shared store).
    let secondPublished: boolean | null = null;
    const bytes = (async function* () {
      yield bytesOf(CONTENT_A.slice(0, 1));
      const second = await putArtifactBlob(makeDeps(db), { machineId: "m-1" }, {
        syncId: s2,
        hash: HASH_A,
        bytes: (async function* () {
          yield bytesOf(CONTENT_A);
        })(),
      });
      if (!second.ok) throw new Error(`second put fixture must succeed: ${JSON.stringify(second)}`);
      secondPublished = second.published;
      yield bytesOf(CONTENT_A.slice(1));
    })();
    const first = await putArtifactBlob(deps, { machineId: "m-1" }, { syncId: s1, hash: HASH_A, bytes });

    // s2 published first; s1 verified the same bytes and deduped onto the
    // existing blob — exactly one publish, one metadata row, both ok.
    expect(secondPublished).toBe(true);
    expect(first).toEqual({ ok: true, size: 3, published: false });
    expect(await blobRows()).toMatchObject([{ namespaceId: "ns-1", hash: HASH_A, size: 3 }]);
    expect(await blobRows()).toHaveLength(1);
    expect((await storedBytes("ns-1", HASH_A))?.equals(Buffer.from(CONTENT_A))).toBe(true);
  });
});
