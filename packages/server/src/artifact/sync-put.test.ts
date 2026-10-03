/**
 * AB1/AB2/AB4/AB6 (+ AC3's PUT leg + 决策 12 leftover tolerance) —
 * ArtifactHome PUT (ADR-010 决策 10, Phase 5 Batch 1 slice 4):
 *
 *  AB1  bytes whose digest ≠ the negotiated hash → content_mismatch;
 *       nothing published, no metadata row.
 *  AB2  real size ≠ the negotiated manifest size (short AND overrun — the
 *       overrun short-circuits the stream) → content_mismatch.
 *  AB4  duplicate PUT: same bytes → published:false with exactly one
 *       metadata row; WRONG bytes → content_mismatch even though the blob
 *       exists (an existing blob never laundered bad content); a PUT after
 *       a failed PUT succeeds.
 *  AB6  unnegotiated hash → hash_not_negotiated with the stream NEVER
 *       pulled; unknown OR cross-attribution session → one leak-free
 *       session_not_found.
 *  Session state: expired → session_expired; committed →
 *       session_committed; a generation bump before OR DURING the upload →
 *       config_conflict (the mid-upload case leaves a published but
 *       unreferenced blob — the 决策 12 tolerated leftover — and NO
 *       metadata row).
 *  Failure outcomes write NOTHING to the current view (AC3's PUT leg).
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { ARTIFACT_SYNC_SESSION_TTL_MILLIS, type PrepareArtifactSyncRequest } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactBlobs, artifactSyncSessions, loops, type ArtifactBlobRow } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { FakeClock, seedLoop, seedMachine, snapshotLoops } from "../testkit/index.js";
import type { ArtifactAttributionResolver } from "./attribution.js";
import { createMemoryBlobStore, type MemoryBlobStoreFaults } from "./blob-store-memory.js";
import type { BlobStore } from "./blob-store.js";
import { updateArtifactConfig } from "./config.js";
import { ArtifactSyncInvariantError, prepareArtifactSync, putArtifactBlob, type ArtifactHomeDeps } from "./sync.js";

// ---- shared fixture helpers ----

function bytesOf(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function hashOf(content: string): string {
  return createHash("sha256").update(bytesOf(content)).digest("hex");
}

const CONTENT_A = "aaa";
const HASH_A = hashOf(CONTENT_A);
const HASH_C = hashOf("ccc"); // never negotiated

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

/** A single-chunk stream that counts its pulls (the hash_not_negotiated
 *  case must never pull the source). */
function countingStream(content: string): { stream: AsyncIterable<Uint8Array>; pulled: () => number } {
  let n = 0;
  return {
    stream: (async function* () {
      n += 1;
      yield bytesOf(content);
    })(),
    pulled: () => n,
  };
}

describe("PUT (real PGlite + memory BlobStore)", () => {
  const handles: DbHandle[] = [];
  let db: Db;
  let clock: FakeClock;
  let store: BlobStore;
  let deps: ArtifactHomeDeps;
  let syncSeq = 0;

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  });

  async function fresh(
    options: { faults?: MemoryBlobStoreFaults; attributionMap?: Record<string, string> } = {},
  ): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock();
    syncSeq = 0;
    store = createMemoryBlobStore({ faults: options.faults });
    await seedMachine(db, "m-1");
    deps = {
      db,
      clock,
      ids: { syncId: () => `sync-${++syncSeq}`, manifestId: () => "amf-unused-in-put" },
      blobStore: store,
      attribution: staticAttribution(options.attributionMap ?? { "m-1": "ns-1" }),
    };
  }

  async function seedConfiguredLoop(): Promise<void> {
    await seedLoop(db, { id: "loop-1", machineId: "m-1", workdir: "/home/user/project", artifactDir: "/data" });
  }

  /** Prepare a session and return its syncId. */
  async function negotiate(): Promise<string> {
    const result = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    if (!result.ok) throw new Error("negotiate fixture must succeed");
    return result.response.syncId;
  }

  function put(syncId: string, content: string, hash = hashOf(content)) {
    const { stream } = countingStream(content);
    return putArtifactBlob(deps, { machineId: "m-1" }, { syncId, hash, bytes: stream });
  }

  async function blobRows(): Promise<ArtifactBlobRow[]> {
    return db.select().from(artifactBlobs);
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

  it("AB4: PUT publishes verified bytes and records the metadata row; an identical re-PUT is published:false with one row", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();

    const first = await put(syncId, CONTENT_A);
    expect(first).toEqual({ ok: true, size: 3, published: true });
    expect(await blobRows()).toMatchObject([{ namespaceId: "ns-1", hash: HASH_A, size: 3 }]);
    expect((await storedBytes("ns-1", HASH_A))?.equals(Buffer.from(CONTENT_A))).toBe(true);

    const again = await put(syncId, CONTENT_A);
    expect(again).toEqual({ ok: true, size: 3, published: false });
    expect(await blobRows()).toHaveLength(1);
  });

  it("AB4: a re-PUT with WRONG bytes is content_mismatch — the existing blob is never laundered", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await put(syncId, CONTENT_A);
    const loopsBefore = await snapshotLoops(db);

    const wrong = await put(syncId, "zzz", HASH_A); // size matches (3), digest does not
    expect(wrong).toEqual({ ok: false, failure: "content_mismatch" });
    expect(await blobRows()).toHaveLength(1);
    expect((await storedBytes("ns-1", HASH_A))?.equals(Buffer.from(CONTENT_A))).toBe(true);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("AB1: bytes hashing ≠ the negotiated hash → content_mismatch; nothing published, no row", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    const loopsBefore = await snapshotLoops(db);

    // Same size as negotiated (3) but different content — a pure digest miss.
    const result = await put(syncId, "xyz", HASH_A);
    expect(result).toEqual({ ok: false, failure: "content_mismatch" });
    expect(await blobRows()).toHaveLength(0);
    expect(await storedBytes("ns-1", HASH_A)).toBeNull();
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("AB2: real size ≠ the negotiated size — short AND overrun (the overrun short-circuits)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();

    const short = countingStream("aa"); // 2 < 3
    await expect(
      putArtifactBlob(deps, { machineId: "m-1" }, { syncId, hash: HASH_A, bytes: short.stream }),
    ).resolves.toEqual({ ok: false, failure: "content_mismatch" });
    expect(short.pulled()).toBe(1);

    const overrun = countingStream("aaaa"); // 4 > 3 — pulled once, then short-circuited
    await expect(
      putArtifactBlob(deps, { machineId: "m-1" }, { syncId, hash: HASH_A, bytes: overrun.stream }),
    ).resolves.toEqual({ ok: false, failure: "content_mismatch" });
    expect(overrun.pulled()).toBe(1);
    expect(await blobRows()).toHaveLength(0);

    // A failed PUT never poisons the session: the correct bytes still land.
    await expect(put(syncId, CONTENT_A)).resolves.toEqual({ ok: true, size: 3, published: true });
  });

  it("AB6: an unnegotiated hash is refused WITHOUT pulling the stream", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();

    const { stream, pulled } = countingStream("ccc");
    await expect(putArtifactBlob(deps, { machineId: "m-1" }, { syncId, hash: HASH_C, bytes: stream })).resolves.toEqual({
      ok: false,
      failure: "hash_not_negotiated",
    });
    expect(pulled()).toBe(0);
    expect(await blobRows()).toHaveLength(0);
  });

  it("AB6: an unknown session and a CROSS-attribution session are the same leak-free session_not_found", async () => {
    await fresh({ attributionMap: { "m-1": "ns-1", "m-2": "ns-2", "m-3": "ns-1" } });
    await seedConfiguredLoop();
    const syncId = await negotiate();

    // Never existed.
    await expect(put("sync-ghost", CONTENT_A)).resolves.toEqual({ ok: false, failure: "session_not_found" });
    // Another machine, another namespace.
    await expect(
      putArtifactBlob(deps, { machineId: "m-2" }, { syncId, hash: HASH_A, bytes: countingStream(CONTENT_A).stream }),
    ).resolves.toEqual({ ok: false, failure: "session_not_found" });
    // Another machine in the SAME namespace — still not found (sessions are
    // per-machine).
    await expect(
      putArtifactBlob(deps, { machineId: "m-3" }, { syncId, hash: HASH_A, bytes: countingStream(CONTENT_A).stream }),
    ).resolves.toEqual({ ok: false, failure: "session_not_found" });
    expect(await blobRows()).toHaveLength(0);
  });

  it("session state: expired → session_expired; committed → session_committed (no upload, no row)", async () => {
    await fresh();
    await seedConfiguredLoop();

    const expiredId = await negotiate();
    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS);
    await expect(put(expiredId, CONTENT_A)).resolves.toEqual({ ok: false, failure: "session_expired" });

    const committedId = await negotiate(); // requestId reuse after expiry is blocked — negotiate() reuses req-1
    await db
      .update(artifactSyncSessions)
      .set({ receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } })
      .where(eq(artifactSyncSessions.id, committedId));
    await expect(put(committedId, CONTENT_A)).resolves.toEqual({ ok: false, failure: "session_committed" });
    expect(await blobRows()).toHaveLength(0);
  });

  it("AM6 (session-generation, PUT leg): a generation bump BEFORE the upload rejects with config_conflict", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });

    await expect(put(syncId, CONTENT_A)).resolves.toEqual({ ok: false, failure: "config_conflict" });
    expect(await blobRows()).toHaveLength(0);
    expect(await storedBytes("ns-1", HASH_A)).toBeNull();
  });

  it("决策 12: a generation bump DURING the upload rejects the PUT — the published blob stays, unreferenced, no row", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    const loopsBefore = await snapshotLoops(db);

    // The byte stream IS the interleaving seam (slice 5's Blob-stream await
    // point): the competitor commits a real config change mid-upload.
    const bytes = (async function* () {
      yield bytesOf(CONTENT_A);
      await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    })();
    await expect(putArtifactBlob(deps, { machineId: "m-1" }, { syncId, hash: HASH_A, bytes })).resolves.toEqual({
      ok: false,
      failure: "config_conflict",
    });

    // The publish already happened (the stream was complete when the
    // generation check re-ran — the bump landed after the last chunk but
    // before the post-publish re-check).
    expect((await storedBytes("ns-1", HASH_A))?.equals(Buffer.from(CONTENT_A))).toBe(true);
    expect(await blobRows()).toHaveLength(0); // unreferenced: no metadata row
    // The only loops write is the competitor's config change.
    const after = await snapshotLoops(db);
    expect(after).toHaveLength(1);
    expect(after[0]!.artifactConfigRevision).toBe(loopsBefore[0]!.artifactConfigRevision + 1);
  });

  it("a deleted loop mid-session is loop_not_found", async () => {
    await fresh();
    await seedConfiguredLoop();
    const syncId = await negotiate();
    await db.delete(loops).where(eq(loops.id, "loop-1"));

    await expect(put(syncId, CONTENT_A)).resolves.toEqual({ ok: false, failure: "loop_not_found" });
    expect(await blobRows()).toHaveLength(0);
  });

  it("a store publish failure maps to storage_error (never a partial row)", async () => {
    const faults: MemoryBlobStoreFaults = { notRegularKeys: new Set([`ns-1/${HASH_A}`]) };
    await fresh({ faults });
    await seedConfiguredLoop();
    const syncId = await negotiate();

    await expect(put(syncId, CONTENT_A)).resolves.toMatchObject({ ok: false, failure: "storage_error" });
    expect(await blobRows()).toHaveLength(0);
  });

  it("invalid_key from the store is an INVARIANT violation — thrown, never a retryable domain result", async () => {
    // A broken attribution resolver hands the store an illegal namespace;
    // the negotiated hash itself is policy-valid, so invalid_key can only
    // come from this contract breach.
    await fresh({ attributionMap: { "m-1": "Bad_NS" } });
    await seedConfiguredLoop();
    const syncId = await negotiate();

    await expect(put(syncId, CONTENT_A)).rejects.toBeInstanceOf(ArtifactSyncInvariantError);
    expect(await blobRows()).toHaveLength(0);
  });
});
