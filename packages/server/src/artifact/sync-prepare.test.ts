/**
 * AC8 (+ AB8 prepare half + AM6 session-generation prepare leg) — ArtifactHome
 * prepare (ADR-010 决策 6/9, Phase 5 Batch 1 slice 4):
 *
 *  plan (pure):   planPrepareSession's fixed order — insert / conflict (same
 *                 key + different fingerprint, even committed) /
 *                 return_committed / reuse (expiry is an EXCLUSIVE bound).
 *  prepare (real PGlite):
 *                 AC8 idempotency — create, reuse (same syncId, needHashes
 *                 recomputed from verified blob state), stable payload
 *                 conflict, expired-pending in-place renewal, committed-key
 *                 replay; unique-key arbitration via ON CONFLICT + re-read
 *                 (a concurrent same-key insert never leaks an exception).
 *                 Scope/guards — attribution_missing, leak-free
 *                 loop_not_found, artifact_dir_unconfigured, config/base
 *                 checks deciding PENDING/NEW keys only (a committed replay
 *                 precedes them — 决策 9's recovery path), AM6 prepare leg.
 *                 AB8 prepare half — a metadata row without its file still
 *                 demands re-upload; a has() failure is storage_error.
 *                 prepare writes NOTHING to the current view (loops row
 *                 item-equal across outcomes).
 */
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_SYNC_SESSION_TTL_MILLIS,
  normalizeManifestEntries,
  type PrepareArtifactSyncRequest,
} from "@loopzhb/protocol";
import { preparePayloadFingerprint } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactBlobs, artifactSyncSessions, loops, type ArtifactSyncSessionRow } from "../db/schema.js";
import { FakeClock, seedLoop, seedMachine, snapshotLoops, staticAttribution } from "../testkit/index.js";
import { createMemoryBlobStore, type MemoryBlobStoreFaults } from "./blob-store-memory.js";
import type { BlobStore } from "./blob-store.js";
import { updateArtifactConfig } from "./config.js";
import {
  commitArtifactSync,
  planPrepareSession,
  prepareArtifactSync,
  putArtifactBlob,
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
const HASH_C = hashOf("ccc");

/** Deliberately UNSORTED wire order — the stored manifest must come back
 *  path-sorted (normalization is part of the negotiation). */
function makeRequest(overrides: Partial<PrepareArtifactSyncRequest> = {}): PrepareArtifactSyncRequest {
  return {
    requestId: "req-1",
    loopId: "loop-1",
    configRevision: 0,
    baseManifestRevision: 0,
    entries: [
      { path: "b.txt", hash: HASH_B, size: 3 },
      { path: "a.txt", hash: HASH_A, size: 3 },
    ],
    ...overrides,
  };
}

describe("planPrepareSession (pure)", () => {
  const EXPIRES = "2026-07-29T01:00:00.000Z";
  const pending = { payloadFingerprint: "fp-1", receipt: null, expiresAt: EXPIRES };

  it("no existing row → insert", () => {
    expect(planPrepareSession({ existing: null, fingerprint: "fp-1", nowIso: EXPIRES })).toEqual({ kind: "insert" });
  });

  it("same key + DIFFERENT fingerprint → conflict — even when the stored session is committed", () => {
    expect(planPrepareSession({ existing: pending, fingerprint: "fp-2", nowIso: EXPIRES })).toEqual({ kind: "conflict" });
    const committed = { ...pending, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } };
    expect(planPrepareSession({ existing: committed, fingerprint: "fp-2", nowIso: EXPIRES })).toEqual({
      kind: "conflict",
    });
  });

  it("same fingerprint + receipt → return_committed (a receipt never expires)", () => {
    const committed = { ...pending, receipt: { artifactSnapshotId: "amf-1", manifestRevision: 1 } };
    expect(planPrepareSession({ existing: committed, fingerprint: "fp-1", nowIso: EXPIRES })).toEqual({
      kind: "return_committed",
    });
    // Far past the pending TTL — still the committed replay.
    expect(planPrepareSession({ existing: committed, fingerprint: "fp-1", nowIso: "2026-08-29T00:00:00.000Z" })).toEqual({
      kind: "return_committed",
    });
  });

  it("same fingerprint + live pending → reuse without a TTL refresh", () => {
    expect(planPrepareSession({ existing: pending, fingerprint: "fp-1", nowIso: "2026-07-29T00:30:00.000Z" })).toEqual({
      kind: "reuse",
      refreshTtl: false,
    });
  });

  it("expiry is an EXCLUSIVE bound: now == expiresAt refreshes, one ms earlier does not", () => {
    expect(planPrepareSession({ existing: pending, fingerprint: "fp-1", nowIso: EXPIRES })).toEqual({
      kind: "reuse",
      refreshTtl: true,
    });
    expect(planPrepareSession({ existing: pending, fingerprint: "fp-1", nowIso: "2026-07-29T00:59:59.999Z" })).toEqual({
      kind: "reuse",
      refreshTtl: false,
    });
  });
});

describe("prepare (real PGlite)", () => {
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

  async function fresh(options: { hooks?: ArtifactHomeDeps["hooks"]; faults?: MemoryBlobStoreFaults } = {}): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock();
    syncSeq = 0; // deterministic ids per test
    manifestSeq = 0;
    store = createMemoryBlobStore({ faults: options.faults });
    await seedMachine(db, "m-1");
    deps = {
      db,
      clock,
      ids: { syncId: () => `sync-${++syncSeq}`, manifestId: () => `amf-${++manifestSeq}` },
      blobStore: store,
      attribution: staticAttribution({ "m-1": "ns-1" }),
      hooks: options.hooks,
    };
  }

  async function seedConfiguredLoop(overrides: Partial<Parameters<typeof seedLoop>[1]> = {}): Promise<void> {
    await seedLoop(db, {
      id: "loop-1",
      machineId: "m-1",
      workdir: "/home/user/project",
      artifactDir: "/data",
      ...overrides,
    });
  }

  /** Out-of-band verified publish + metadata row (what PUT will do in the
   *  next commit) — prepare's needHashes must read this state. */
  async function uploadBlob(namespaceId: string, content: string): Promise<string> {
    const bytes = bytesOf(content);
    const hash = hashOf(content);
    const written = await store.writeVerified({
      namespaceId,
      hash,
      expectedSize: bytes.byteLength,
      bytes: (async function* () {
        yield bytes;
      })(),
    });
    expect(written).toEqual({ ok: true, size: bytes.byteLength, published: true });
    await db.insert(artifactBlobs).values({ namespaceId, hash, size: bytes.byteLength, verifiedAt: clock.iso() });
    return hash;
  }

  async function sessions(): Promise<ArtifactSyncSessionRow[]> {
    return db.select().from(artifactSyncSessions);
  }

  function expectedExpiry(): string {
    return new Date(clock.now().getTime() + ARTIFACT_SYNC_SESSION_TTL_MILLIS).toISOString();
  }

  it("AC8: first prepare creates the session — TTL, deduped hashes, normalized manifest, zero view writes", async () => {
    await fresh();
    await seedConfiguredLoop();
    const loopsBefore = await snapshotLoops(db);

    const result = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());

    expect(result).toEqual({
      ok: true,
      outcome: "created",
      response: { syncId: "sync-1", needHashes: [HASH_A, HASH_B], expiresAt: expectedExpiry() },
    });
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "sync-1",
      namespaceId: "ns-1",
      machineId: "m-1",
      loopId: "loop-1",
      requestId: "req-1",
      configRevision: 0,
      baseManifestRevision: 0,
      negotiatedHashes: [HASH_A, HASH_B],
      createdAt: clock.iso(),
      expiresAt: expectedExpiry(),
      receipt: null,
    });
    // The wire order was [b, a]; the stored manifest is path-sorted.
    expect(rows[0]!.normalizedManifest).toEqual([
      { path: "a.txt", hash: HASH_A, size: 3 },
      { path: "b.txt", hash: HASH_B, size: 3 },
    ]);
    // The stored fingerprint is exactly the 决策 6 composition over the
    // normalized payload sans requestId.
    expect(rows[0]!.payloadFingerprint).toBe(
      preparePayloadFingerprint({
        loopId: "loop-1",
        configRevision: 0,
        baseManifestRevision: 0,
        entries: rows[0]!.normalizedManifest,
      }),
    );
    // prepare writes NOTHING to the current view.
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("AC8: an identical re-prepare reuses the session — same syncId, no duplicate row, zero view writes", async () => {
    await fresh();
    await seedConfiguredLoop();
    const first = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    if (!first.ok) throw new Error("first prepare must succeed");
    const loopsBefore = await snapshotLoops(db);

    const second = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    expect(second).toEqual({ ok: true, outcome: "reused", response: first.response });
    expect(await sessions()).toHaveLength(1);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("AC8: re-prepare recomputes needHashes from the verified blob state", async () => {
    await fresh();
    await seedConfiguredLoop();
    await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    await uploadBlob("ns-1", CONTENT_A);

    const result = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    expect(result).toMatchObject({ ok: true, outcome: "reused", response: { needHashes: [HASH_B] } });
  });

  it("AC8: same key + a different payload is a stable manifest_conflict — never a leaked unique-key exception", async () => {
    await fresh();
    await seedConfiguredLoop();
    await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    const loopsBefore = await snapshotLoops(db);

    const conflict = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ entries: [{ path: "c.txt", hash: HASH_C, size: 3 }] }),
    );
    expect(conflict).toEqual({ ok: false, failure: "manifest_conflict" });
    expect(await sessions()).toHaveLength(1);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("AC8: an expired pending session renews in place — same syncId, same createdAt, new expiresAt", async () => {
    await fresh();
    await seedConfiguredLoop();
    const first = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    const createdAt = clock.iso();

    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS + 60_000);
    const renewed = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    expect(renewed).toEqual({
      ok: true,
      outcome: "reused",
      response: { syncId: "sync-1", needHashes: [HASH_A, HASH_B], expiresAt: expectedExpiry() },
    });
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect([rows[0]!.id, rows[0]!.createdAt]).toEqual(["sync-1", createdAt]);
    expect(first.ok && first.response.expiresAt < (renewed.ok ? renewed.response.expiresAt : "")).toBe(true);
  });

  it("AC8: an expired session key with a DIFFERENT payload is still a conflict", async () => {
    await fresh();
    await seedConfiguredLoop();
    await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());

    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS + 60_000);
    const conflict = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ entries: [{ path: "c.txt", hash: HASH_C, size: 3 }] }),
    );
    expect(conflict).toEqual({ ok: false, failure: "manifest_conflict" });
  });

  it("AC8/决策 9: re-preparing a committed key replays the original session — across the REAL base advance, a config bump, an artifactDir removal and the TTL, with the pointer untouched (S4-2)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const first = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    if (!first.ok) throw new Error("first prepare must succeed");
    const syncId = first.response.syncId;

    // A REAL commit — PUT both blobs, then commit. The loop's base advances
    // to 1, so the original request (base 0) would fail the base check if it
    // ever reached it: the stored receipt must replay BEFORE that check.
    for (const content of [CONTENT_A, CONTENT_B]) {
      const bytes = bytesOf(content);
      const uploaded = await putArtifactBlob(deps, { machineId: "m-1" }, {
        syncId,
        hash: hashOf(content),
        bytes: (async function* () {
          yield bytes;
        })(),
      });
      if (!uploaded.ok) throw new Error(`put fixture must succeed: ${JSON.stringify(uploaded)}`);
    }
    const committed = await commitArtifactSync(deps, { machineId: "m-1" }, { syncId });
    if (!committed.ok) throw new Error(`commit fixture must succeed: ${JSON.stringify(committed)}`);
    expect((await db.select().from(loops).where(eq(loops.id, "loop-1")))[0]!.artifactManifestRevision).toBe(1);

    // A different payload on the committed key NEVER replays — the
    // fingerprint is the payload contract (an honest new base reaches the
    // planner, which conflicts).
    const different = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ baseManifestRevision: 1, entries: [{ path: "c.txt", hash: HASH_C, size: 3 }] }),
    );
    expect(different).toEqual({ ok: false, failure: "manifest_conflict" });

    // The generation moves AND the pending TTL lapses — the original
    // payload's replay still precedes every one of those checks.
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS * 2);
    const pointerTriple = async () =>
      (
        await db
          .select({
            artifactManifestId: loops.artifactManifestId,
            artifactManifestRevision: loops.artifactManifestRevision,
            revision: loops.revision,
          })
          .from(loops)
          .where(eq(loops.id, "loop-1"))
      )[0]!;
    const pointerBeforeReplay = await pointerTriple();
    const replay = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    expect(replay).toEqual({
      ok: true,
      outcome: "committed",
      response: { syncId, needHashes: [], expiresAt: first.response.expiresAt },
    });
    // …and the receipt itself is recovered by re-committing that session.
    await expect(commitArtifactSync(deps, { machineId: "m-1" }, { syncId })).resolves.toEqual({
      ok: true,
      receipt: committed.receipt,
    });
    // The replay moved NOTHING: the pointer, the base and even the unified
    // OCC revision are item-equal before and after (direct invariance
    // assertion — a replay is a READ of the stored receipt, never a write).
    expect(await pointerTriple()).toEqual(pointerBeforeReplay);

    // The replay also precedes artifact_dir_unconfigured: REMOVING the
    // artifactDir entirely still returns the original session, and the
    // receipt stays recoverable through commit.
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: null });
    const pointerBeforeClearReplay = await pointerTriple();
    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest())).resolves.toEqual({
      ok: true,
      outcome: "committed",
      response: { syncId, needHashes: [], expiresAt: first.response.expiresAt },
    });
    await expect(commitArtifactSync(deps, { machineId: "m-1" }, { syncId })).resolves.toEqual({
      ok: true,
      receipt: committed.receipt,
    });
    expect(await pointerTriple()).toEqual(pointerBeforeClearReplay);
  });

  it("manifest policy failure → manifest_invalid carrying the policy reason — zero session rows, zero view writes", async () => {
    await fresh();
    await seedConfiguredLoop();
    const loopsBefore = await snapshotLoops(db);

    const neverSync = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ entries: [{ path: ".git/config", hash: HASH_A, size: 3 }] }),
    );
    expect(neverSync).toEqual({
      ok: false,
      failure: "manifest_invalid",
      reason: "path_never_sync",
      index: 0,
      path: ".git/config",
      hash: undefined,
    });
    const badHash = await prepareArtifactSync(
      deps,
      { machineId: "m-1" },
      makeRequest({ entries: [{ path: "a.txt", hash: "not-hex", size: 3 }] }),
    );
    expect(badHash).toMatchObject({ ok: false, failure: "manifest_invalid", reason: "hash_malformed", index: 0 });
    expect(await sessions()).toHaveLength(0);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("attribution gates every prepare (决策 7)", async () => {
    await fresh();
    await seedConfiguredLoop();
    const result = await prepareArtifactSync(deps, { machineId: "m-unknown" }, makeRequest());
    expect(result).toEqual({ ok: false, failure: "attribution_missing" });
    expect(await sessions()).toHaveLength(0);
  });

  it("scope: an unknown loop and ANOTHER machine's loop are the same leak-free loop_not_found", async () => {
    await fresh();
    await seedConfiguredLoop();
    await seedLoop(db, { id: "loop-2", machineId: "m-2", artifactDir: "/data" });

    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest({ loopId: "loop-ghost" }))).resolves.toEqual({
      ok: false,
      failure: "loop_not_found",
    });
    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest({ loopId: "loop-2" }))).resolves.toEqual({
      ok: false,
      failure: "loop_not_found",
    });
    expect(await sessions()).toHaveLength(0);
  });

  it("an unconfigured loop never starts a sync (artifact_dir_unconfigured)", async () => {
    await fresh();
    await seedConfiguredLoop({ artifactDir: null });
    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest())).resolves.toEqual({
      ok: false,
      failure: "artifact_dir_unconfigured",
    });
    expect(await sessions()).toHaveLength(0);
  });

  it("generation/base checks precede idempotency: config_conflict / manifest_conflict, zero view writes", async () => {
    await fresh();
    await seedConfiguredLoop({ artifactConfigRevision: 2, artifactManifestRevision: 1 });
    const loopsBefore = await snapshotLoops(db);

    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest())).resolves.toEqual({
      ok: false,
      failure: "config_conflict",
    });
    await expect(
      prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest({ configRevision: 2, baseManifestRevision: 0 })),
    ).resolves.toEqual({ ok: false, failure: "manifest_conflict" });
    expect(await sessions()).toHaveLength(0);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("unique-key arbitration: a concurrent same-key insert converges to reuse — the unique violation never escapes", async () => {
    await fresh();
    await seedConfiguredLoop();
    // The competitor commits a same-key session between the resolve and the
    // insert (the config.test.ts competing-write pattern). Its fingerprint
    // matches the request's, so the outcome is a REUSE of the winner's row.
    const request = makeRequest();
    const normalized = normalizeManifestEntries(request.entries);
    if (!normalized.ok) throw new Error("fixture manifest must validate");
    const fingerprint = preparePayloadFingerprint({
      loopId: request.loopId,
      configRevision: request.configRevision,
      baseManifestRevision: request.baseManifestRevision,
      entries: normalized.entries,
    });
    let competitorCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async () => {
        competitorCalls += 1;
        if (competitorCalls > 1) return;
        await db.insert(artifactSyncSessions).values({
          id: "sync-competitor",
          namespaceId: "ns-1",
          machineId: "m-1",
          loopId: "loop-1",
          requestId: "req-1",
          configRevision: 0,
          baseManifestRevision: 0,
          normalizedManifest: normalized.entries,
          payloadFingerprint: fingerprint,
          negotiatedHashes: [HASH_A, HASH_B],
          createdAt: clock.iso(),
          expiresAt: expectedExpiry(),
        });
      },
    };
    deps = { ...deps, hooks };

    const result = await prepareArtifactSync(deps, { machineId: "m-1" }, request);
    expect(result).toMatchObject({ ok: true, outcome: "reused", response: { syncId: "sync-competitor" } });
    expect(await sessions()).toHaveLength(1);
  });

  it("unique-key arbitration: a same-key winner with a DIFFERENT payload surfaces as manifest_conflict", async () => {
    await fresh();
    await seedConfiguredLoop();
    let competitorCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async () => {
        competitorCalls += 1;
        if (competitorCalls > 1) return;
        await db.insert(artifactSyncSessions).values({
          id: "sync-competitor",
          namespaceId: "ns-1",
          machineId: "m-1",
          loopId: "loop-1",
          requestId: "req-1",
          configRevision: 0,
          baseManifestRevision: 0,
          normalizedManifest: [],
          payloadFingerprint: "fp-something-else",
          negotiatedHashes: [],
          createdAt: clock.iso(),
          expiresAt: expectedExpiry(),
        });
      },
    };
    deps = { ...deps, hooks };

    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest())).resolves.toEqual({
      ok: false,
      failure: "manifest_conflict",
    });
    expect(await sessions()).toHaveLength(1); // only the competitor's row
  });

  it("AM6 (session-generation, prepare leg): a real config bump rejects the old-generation prepare — even mid-flight", async () => {
    await fresh();
    await seedConfiguredLoop();

    // Static leg: the generation moved BEFORE the request.
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-2" });
    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest())).resolves.toEqual({
      ok: false,
      failure: "config_conflict",
    });

    // Race leg: the bump lands BETWEEN the loser's resolve and its guarded
    // insert — the guard loses, the bounded re-run re-plans on fresh state,
    // and the retry surfaces the conflict (never a stale-generation session).
    // The loop is now at generation 1; the request targets it.
    let competitorCalls = 0;
    const hooks: ArtifactHomeDeps["hooks"] = {
      afterResolve: async () => {
        competitorCalls += 1;
        if (competitorCalls > 1) return;
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data-3" });
      },
    };
    deps = { ...deps, hooks };
    await expect(
      prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest({ requestId: "req-race", configRevision: 1 })),
    ).resolves.toEqual({ ok: false, failure: "config_conflict" });
    // The hook fires exactly ONCE: the bounded retry's re-resolve observes
    // generation 2 and rejects BEFORE the insert (and before the seam).
    expect(competitorCalls).toBe(1);
    expect(await sessions()).toHaveLength(0);
  });

  it("AB8 (prepare half): a metadata row WITHOUT its file still demands re-upload; a has() failure is storage_error", async () => {
    await fresh();
    await seedConfiguredLoop();
    // Metadata row with NO blob behind it (the file was lost out of band).
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_A, size: 3, verifiedAt: clock.iso() });

    const result = await prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest());
    expect(result).toMatchObject({ ok: true, response: { needHashes: [HASH_A, HASH_B] } });

    // A has() FAILURE (anomaly parked at the blob path) is storage_error —
    // never silently treated as "needed" (the frozen has contract).
    const faults: MemoryBlobStoreFaults = { notRegularKeys: new Set([`ns-1/${HASH_A}`]) };
    await fresh({ faults });
    await seedConfiguredLoop();
    await db.insert(artifactBlobs).values({ namespaceId: "ns-1", hash: HASH_A, size: 3, verifiedAt: clock.iso() });
    await expect(prepareArtifactSync(deps, { machineId: "m-1" }, makeRequest())).resolves.toMatchObject({
      ok: false,
      failure: "storage_error",
    });
  });
});
