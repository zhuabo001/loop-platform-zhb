/**
 * ArtifactHome — the Phase 5 artifact-sync state machine (ADR-010 决策 6–12,
 * Phase 5 Batch 1 slice 4). This module is the ONLY writer of the
 * artifact_sync_sessions / artifact_manifests / artifact_blobs rows and of the
 * loop's artifact pointer + sync-attempt triple; Batch 1 wires it from TESTS
 * ONLY — no production route, no composition (决策 16).
 *
 * PREPARE negotiates a sync session:
 *  - Fixed evaluation order (决策 13's per-step codes): manifest policy →
 *    attribution → loop scope → configured → config generation → base
 *    revision → idempotency. Validation precedes attribution because a
 *    manifest failure is payload-local and leaks nothing about scope;
 *    generation/base checks precede the idempotency lookup so an
 *    old-generation request is a config/manifest conflict even when its key
 *    would otherwise "reuse" a stale session (AM6's session-generation half).
 *  - Idempotency (决策 9): the session key is (namespaceId, machineId,
 *    requestId); the fingerprint (决策 6) covers the canonical payload sans
 *    requestId. Same key + same fingerprint reuses the session — an EXPIRED
 *    pending session is renewed in place with the same syncId (re-prepare IS
 *    the renegotiation path). Same key + different fingerprint is a stable
 *    manifest_conflict, never a leaked unique-key exception: the insert runs
 *    INSERT … ON CONFLICT DO NOTHING and re-reads the winner inside the same
 *    transaction, then lets the pure planner decide (reuse / committed /
 *    conflict). A daemon that must renegotiate after a conflict mints a NEW
 *    requestId — the old key stays poisoned by design.
 *  - Pending expiry is an EXCLUSIVE upper bound: a session is usable while
 *    now < expiresAt (writer-computed from the injected Clock, 决策 9). A
 *    committed receipt never expires.
 *  - needHashes = the negotiated hashes without a verified blob BEHIND their
 *    metadata row: a row whose file is missing still demands re-upload
 *    (AB8's prepare half), and a has() failure is storage_error — never a
 *    silent "needed" (the frozen BlobStore contract: has never swallows
 *    storage errors).
 *
 * PUT uploads one negotiated blob (决策 10): the session (carried by id) is
 * re-validated on EVERY upload — attribution, existence (unknown OR
 * cross-attribution is the same leak-free session_not_found), committed
 * state, pending expiry, and the config generation (checked BOTH before the
 * byte stream starts and after the publish completes — a generation that
 * moved mid-upload rejects the PUT; the published-but-unreferenced blob is
 * the 决策 12 tolerated leftover). Only hashes the session negotiated are
 * accepted, and the stream is never pulled for an unnegotiated one. The byte
 * stream is the ONLY source of truth: expectedSize comes from the session's
 * negotiated manifest entry, never from a declared size. Failures map
 * verbatim from the BlobStore contract (content_mismatch/storage_error);
 * invalid_key is unreachable (the hash came from a policy-validated
 * manifest, the namespace from the trusted resolver) and throws an
 * invariant violation rather than looping a permanent defect through a
 * retryable class. A successful publish records the (namespaceId, hash)
 * metadata row with the VERIFIED size — ON CONFLICT DO NOTHING makes a
 * duplicate PUT idempotent, and wrong bytes can never be laundered by an
 * existing blob (writeVerified always re-verifies the stream).
 *  - prepare writes NOTHING to the current view (no loops write). Its one
 *    write path (the session insert) guards on the resolved loop's unified
 *    OCC revision inside the transaction, so a concurrent generation bump
 *    loses the guard and the bounded re-run re-plans on fresh state — the
 *    write path is race-safe, not single-thread-only (withGuardRetry: exactly
 *    one re-run, then ArtifactSyncRaceLostError).
 *
 * Internal failure literals are finer than the 9 wire codes (决策 13's
 * double layer, the RunCapabilityInvalidError precedent); the Batch 2 route
 * layer owns the mapping. `artifact_dir_unconfigured` and the 404-grade
 * `loop_not_found` have no wire code yet — recorded in the ADR revision log.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  ARTIFACT_SYNC_SESSION_TTL_MILLIS,
  normalizeManifestEntries,
  type ArtifactManifestFailure,
  type NormalizedManifestEntry,
  type PrepareArtifactSyncRequest,
  type PrepareArtifactSyncResponse,
} from "@loopzhb/protocol";
import { preparePayloadFingerprint } from "@loopzhb/protocol/node";

import type { Db } from "../db/index.js";
import {
  artifactBlobs,
  artifactManifests,
  artifactSyncSessions,
  loops,
  type ArtifactManifestRow,
  type ArtifactSyncSessionRow,
  type Loop,
  type NewArtifactSyncSession,
} from "../db/schema.js";
import { withGuardRetry } from "../store/guard-retry.js";
import type { Clock } from "../time.js";
import type { ArtifactAttributionResolver, TrustedMachineIdentity } from "./attribution.js";
import type { BlobStore } from "./blob-store.js";

export interface ArtifactHomeDeps {
  db: Db;
  clock: Clock;
  /** Server-minted ids (决策 12: a manifest id is NOT content-addressed).
   *  Production shape: `sync-${randomUUID()}` / `amf-${randomUUID()}`; tests
   *  inject deterministic factories. */
  ids: { syncId(): string; manifestId(): string };
  blobStore: BlobStore;
  /** The ONLY namespace source (决策 7/15) — re-derived on EVERY operation,
   *  never cached from the request. */
  attribution: ArtifactAttributionResolver;
  /** TEST-ONLY seams (the config.ts hooks.afterResolve precedent). Slice 5's
   *  interleavings fire `afterResolve` BETWEEN the resolve and the write
   *  (outside any transaction) or at the PUT byte stream's await points;
   *  `insideCommitTx` may ONLY throw, to prove rollback (PGlite is
   *  single-connection: never wait on a competitor inside the tx). */
  hooks?: {
    afterResolve?(op: "prepare" | "put" | "commit", id: string): void | Promise<void>;
    insideCommitTx?(syncId: string): void | Promise<void>;
  };
}

/** A guarded write observed zero rows — a competitor committed between the
 *  resolve and the write. Internal: `withGuardRetry` re-runs the whole
 *  resolve+plan+write once on fresh state. */
class ArtifactSyncGuardLostError extends Error {
  constructor(
    readonly op: string,
    readonly id: string,
  ) {
    super(`artifact sync guard lost during ${op} for ${id}`);
    this.name = "ArtifactSyncGuardLostError";
  }
}

/** The guard lost AGAIN on the single bounded re-resolve (the
 *  ArtifactConfigRaceLostError precedent): a retryable-500-grade exception,
 *  never a domain result; no partial state was ever committed. */
export class ArtifactSyncRaceLostError extends Error {
  constructor(
    readonly op: string,
    readonly id: string,
  ) {
    super(`artifact sync guard did not settle during ${op} for ${id}`);
    this.name = "ArtifactSyncRaceLostError";
  }
}

/** A state the contract makes unreachable (e.g. ON CONFLICT DO NOTHING with
 *  no winner row). Thrown, never a domain result — mapping an invariant
 *  violation to a retryable failure would loop a permanent defect. */
export class ArtifactSyncInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSyncInvariantError";
  }
}

// ---- prepare: pure idempotency planner ----

export type PrepareSessionPlan =
  | { kind: "insert" }
  | { kind: "reuse"; refreshTtl: boolean }
  | { kind: "return_committed" }
  | { kind: "conflict" };

/** The idempotency decision over the session row found under the request's
 *  unique key. Fixed order: same key + DIFFERENT fingerprint is a conflict
 *  even when the stored session is already committed (决策 6/9 — the
 *  fingerprint is the payload contract; requestId is only the key); same
 *  fingerprint + a receipt returns the committed session; an expired pending
 *  session reuses in place with a TTL refresh (expiry is an EXCLUSIVE bound:
 *  usable while now < expiresAt). */
export function planPrepareSession(input: {
  existing: Pick<ArtifactSyncSessionRow, "payloadFingerprint" | "receipt" | "expiresAt"> | null;
  fingerprint: string;
  nowIso: string;
}): PrepareSessionPlan {
  const { existing, fingerprint, nowIso } = input;
  if (existing === null) return { kind: "insert" };
  if (existing.payloadFingerprint !== fingerprint) return { kind: "conflict" };
  if (existing.receipt !== null) return { kind: "return_committed" };
  return { kind: "reuse", refreshTtl: nowIso >= existing.expiresAt };
}

// ---- prepare: DB adapter ----

export type PrepareArtifactSyncResult =
  | { ok: true; outcome: "created" | "reused" | "committed"; response: PrepareArtifactSyncResponse }
  | {
      ok: false;
      failure: "manifest_invalid";
      reason: ArtifactManifestFailure;
      index: number | undefined;
      path: string | undefined;
      hash: string | undefined;
    }
  | { ok: false; failure: "storage_error"; cause?: unknown }
  | {
      ok: false;
      failure: "attribution_missing" | "loop_not_found" | "artifact_dir_unconfigured" | "config_conflict" | "manifest_conflict";
    };

/** The full internal failure literal set for prepare (Batch 2 maps it onto
 *  the wire taxonomy; `artifact_dir_unconfigured` and the 404-grade
 *  `loop_not_found` have no wire code in Batch 1). */
export type PrepareArtifactSyncFailure = Extract<PrepareArtifactSyncResult, { ok: false }>["failure"];

interface SessionKey {
  namespaceId: string;
  machineId: string;
  requestId: string;
}

function sessionKeyWhere(key: SessionKey) {
  return and(
    eq(artifactSyncSessions.namespaceId, key.namespaceId),
    eq(artifactSyncSessions.machineId, key.machineId),
    eq(artifactSyncSessions.requestId, key.requestId),
  );
}

/** Pending expiry is writer-computed from the injected Clock (决策 9). */
function expiryFromIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) + ARTIFACT_SYNC_SESSION_TTL_MILLIS).toISOString();
}

/** needHashes = negotiated hashes without a verified blob BEHIND the metadata
 *  row. No row → needed (no store call required). A row whose FILE is gone →
 *  still needed (AB8: prepare re-negotiates the missing blob; commit refuses
 *  the incomplete snapshot). A has() failure → storage_error, never a silent
 *  "needed". */
async function computeNeedHashes(
  deps: ArtifactHomeDeps,
  namespaceId: string,
  hashes: readonly string[],
): Promise<{ ok: true; need: string[] } | { ok: false; cause?: unknown }> {
  const need: string[] = [];
  for (const hash of hashes) {
    const row = (
      await deps.db
        .select({ hash: artifactBlobs.hash })
        .from(artifactBlobs)
        .where(and(eq(artifactBlobs.namespaceId, namespaceId), eq(artifactBlobs.hash, hash)))
        .limit(1)
    )[0];
    if (!row) {
      need.push(hash);
      continue;
    }
    const presence = await deps.blobStore.has({ namespaceId, hash });
    if (!presence.ok) return { ok: false, cause: presence.cause };
    if (!presence.present) need.push(hash);
  }
  return { ok: true, need };
}

/** The session insert — the ONLY write prepare performs, and it touches no
 *  current-view state. The transaction first re-checks the resolved loop's
 *  unified OCC revision: a concurrent loops write (a config bump, a claim,
 *  anything) between the outer resolve and this tx loses the guard, rolls
 *  back, and the bounded re-run re-plans on fresh state. The insert itself
 *  arbitrates the (namespaceId, machineId, requestId) unique key with
 *  ON CONFLICT DO NOTHING: a concurrent same-key prepare won — re-read the
 *  winner INSIDE the tx and let the caller's planner decide, so the unique
 *  violation never escapes as an exception. */
async function insertSessionGuarded(
  deps: ArtifactHomeDeps,
  loop: Loop,
  key: SessionKey,
  request: PrepareArtifactSyncRequest,
  entries: NormalizedManifestEntry[],
  fingerprint: string,
  nowIso: string,
): Promise<{ session: ArtifactSyncSessionRow; created: boolean }> {
  const row: NewArtifactSyncSession = {
    id: deps.ids.syncId(),
    namespaceId: key.namespaceId,
    machineId: key.machineId,
    loopId: request.loopId,
    requestId: request.requestId,
    configRevision: request.configRevision,
    baseManifestRevision: request.baseManifestRevision,
    normalizedManifest: entries,
    payloadFingerprint: fingerprint,
    negotiatedHashes: [...new Set(entries.map((entry) => entry.hash))],
    createdAt: nowIso,
    expiresAt: expiryFromIso(nowIso),
  };
  return deps.db.transaction(async (tx) => {
    const still = await tx
      .select({ id: loops.id })
      .from(loops)
      .where(and(eq(loops.id, loop.id), eq(loops.revision, loop.revision)))
      .limit(1);
    if (still.length !== 1) throw new ArtifactSyncGuardLostError("prepare", loop.id);
    const inserted = await tx.insert(artifactSyncSessions).values(row).onConflictDoNothing().returning();
    if (inserted.length === 1) return { session: inserted[0]!, created: true };
    const winner = (await tx.select().from(artifactSyncSessions).where(sessionKeyWhere(key)).limit(1))[0];
    if (!winner) {
      throw new ArtifactSyncInvariantError(`session insert for request ${request.requestId} lost the conflict but no winner row exists`);
    }
    return { session: winner, created: false };
  });
}

/** Renew an expired pending session IN PLACE — same syncId, new expiresAt
 *  (re-prepare IS the renegotiation path; the daemon keeps one logical sync
 *  under one requestId). The guarded UPDATE keys on (id, receipt IS NULL,
 *  expiresAt = observed): zero rows means a competitor committed or renewed
 *  first — re-read and return the winner's row so concurrent renewals
 *  converge to ONE response. */
async function renewSession(deps: ArtifactHomeDeps, session: ArtifactSyncSessionRow, nowIso: string): Promise<ArtifactSyncSessionRow> {
  const renewed = await deps.db
    .update(artifactSyncSessions)
    .set({ expiresAt: expiryFromIso(nowIso) })
    .where(
      and(
        eq(artifactSyncSessions.id, session.id),
        isNull(artifactSyncSessions.receipt),
        eq(artifactSyncSessions.expiresAt, session.expiresAt),
      ),
    )
    .returning();
  if (renewed.length === 1) return renewed[0]!;
  const reread = (
    await deps.db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, session.id)).limit(1)
  )[0];
  if (!reread) throw new ArtifactSyncInvariantError(`session ${session.id} vanished during prepare renewal`);
  return reread;
}

async function prepareOnce(
  deps: ArtifactHomeDeps,
  machine: TrustedMachineIdentity,
  request: PrepareArtifactSyncRequest,
  entries: NormalizedManifestEntry[],
): Promise<PrepareArtifactSyncResult> {
  // (2) Attribution — re-derived on EVERY operation (决策 7/15).
  const attribution = await deps.attribution.resolve(machine);
  if (!attribution.ok) return { ok: false, failure: "attribution_missing" };
  // (3) Loop + scope: an unknown loop and a loop owned by ANOTHER machine are
  // the same leak-free refusal (决策 13: existence never leaks across scope).
  const loop = (await deps.db.select().from(loops).where(eq(loops.id, request.loopId)).limit(1))[0];
  if (!loop || loop.machineId !== attribution.machineId) return { ok: false, failure: "loop_not_found" };
  // (4) An unconfigured loop never starts a sync (plan §1's dormancy rule).
  if (loop.artifactDir === null) return { ok: false, failure: "artifact_dir_unconfigured" };
  // (5)/(6) Generation + base BEFORE the idempotency lookup (决策 6/13): an
  // old-generation request conflicts even when its key would otherwise reuse
  // a stale session (which could never commit anyway — PUT/commit re-check
  // the generation against the CURRENT loop).
  if (request.configRevision !== loop.artifactConfigRevision) return { ok: false, failure: "config_conflict" };
  if (request.baseManifestRevision !== loop.artifactManifestRevision) return { ok: false, failure: "manifest_conflict" };

  const fingerprint = preparePayloadFingerprint({
    loopId: request.loopId,
    configRevision: request.configRevision,
    baseManifestRevision: request.baseManifestRevision,
    entries,
  });
  const key: SessionKey = { namespaceId: attribution.namespaceId, machineId: attribution.machineId, requestId: request.requestId };
  const existing = (await deps.db.select().from(artifactSyncSessions).where(sessionKeyWhere(key)).limit(1))[0] ?? null;
  // TEST-ONLY interleaving seam (slice 5 fires a REAL competing write here).
  await deps.hooks?.afterResolve?.("prepare", request.loopId);

  const nowIso = deps.clock.now().toISOString();
  let plan = planPrepareSession({ existing, fingerprint, nowIso });
  if (plan.kind === "conflict") return { ok: false, failure: "manifest_conflict" };

  let session: ArtifactSyncSessionRow;
  let created = false;
  if (plan.kind === "insert") {
    const insert = await insertSessionGuarded(deps, loop, key, request, entries, fingerprint, nowIso);
    session = insert.session;
    created = insert.created;
    if (!created) {
      // The arbitration winner is an EXISTING row — re-plan against it.
      plan = planPrepareSession({ existing: session, fingerprint, nowIso });
      if (plan.kind === "conflict") return { ok: false, failure: "manifest_conflict" };
    }
  } else {
    session = existing!;
  }

  // 决策 9: 已提交请求返回原 session — the receipt is recoverable by
  // re-committing this session (which replays it verbatim).
  if (plan.kind === "return_committed") {
    return { ok: true, outcome: "committed", response: { syncId: session.id, needHashes: [], expiresAt: session.expiresAt } };
  }
  if (plan.kind === "reuse" && plan.refreshTtl) {
    session = await renewSession(deps, session, nowIso);
    if (session.receipt !== null) {
      return { ok: true, outcome: "committed", response: { syncId: session.id, needHashes: [], expiresAt: session.expiresAt } };
    }
  }
  // 决策 9: 重复 prepare 可重新计算缺失 Blob. (The fingerprint covers the
  // entries, so same-fingerprint reuse always re-derives the SAME hash set —
  // the stored negotiatedHashes never change on reuse.)
  const need = await computeNeedHashes(deps, session.namespaceId, session.negotiatedHashes);
  if (!need.ok) return { ok: false, failure: "storage_error", cause: need.cause };
  return {
    ok: true,
    outcome: created ? "created" : "reused",
    response: { syncId: session.id, needHashes: need.need, expiresAt: session.expiresAt },
  };
}

/**
 * Negotiate a sync session (ADR-010 决策 6/9). See the module header for the
 * fixed evaluation order; step (1) is the manifest policy — payload-local, so
 * it precedes attribution and is NOT re-run on the bounded re-run's behalf
 * (it is deterministic).
 */
export async function prepareArtifactSync(
  deps: ArtifactHomeDeps,
  machine: TrustedMachineIdentity,
  request: PrepareArtifactSyncRequest,
): Promise<PrepareArtifactSyncResult> {
  const validation = normalizeManifestEntries(request.entries);
  if (!validation.ok) {
    return {
      ok: false,
      failure: "manifest_invalid",
      reason: validation.failure,
      index: validation.index,
      path: validation.path,
      hash: validation.hash,
    };
  }
  return withGuardRetry(
    () => prepareOnce(deps, machine, request, validation.entries),
    (err) => err instanceof ArtifactSyncGuardLostError,
    (err) => new ArtifactSyncRaceLostError((err as ArtifactSyncGuardLostError).op, (err as ArtifactSyncGuardLostError).id),
  );
}

// ---- PUT: verified blob upload (决策 10) ----

export type PutArtifactBlobResult =
  | { ok: true; size: number; published: boolean }
  | { ok: false; failure: "storage_error"; cause?: unknown }
  | {
      ok: false;
      failure:
        | "attribution_missing"
        | "session_not_found"
        | "session_expired"
        | "session_committed"
        | "loop_not_found"
        | "config_conflict"
        | "hash_not_negotiated"
        | "content_mismatch";
    };

/** The full internal failure literal set for PUT. `session_not_found` is the
 *  404-grade leak-free refusal (unknown OR cross-attribution — 决策 13);
 *  `session_committed` names a client bug no wire code honestly covers yet
 *  (Batch 2 maps it; the ADR revision log records the literal). */
export type PutArtifactBlobFailure = Extract<PutArtifactBlobResult, { ok: false }>["failure"];

/** The session as the PUT path consults it. */
async function findSessionById(db: Db, syncId: string): Promise<ArtifactSyncSessionRow | null> {
  return (await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, syncId)).limit(1))[0] ?? null;
}

/** Upload one negotiated blob. PUT performs NO guarded loop write (the
 *  metadata row is generation-independent content truth), so it needs no
 *  guard-retry wrapper — the generation re-check after the publish is what
 *  keeps an old-generation upload from counting. */
export async function putArtifactBlob(
  deps: ArtifactHomeDeps,
  machine: TrustedMachineIdentity,
  input: { syncId: string; hash: string; bytes: AsyncIterable<Uint8Array> },
): Promise<PutArtifactBlobResult> {
  const attribution = await deps.attribution.resolve(machine);
  if (!attribution.ok) return { ok: false, failure: "attribution_missing" };

  const session = await findSessionById(deps.db, input.syncId);
  // Unknown OR cross-attribution: one leak-free refusal (决策 13).
  if (!session || session.namespaceId !== attribution.namespaceId || session.machineId !== attribution.machineId) {
    return { ok: false, failure: "session_not_found" };
  }
  if (session.receipt !== null) return { ok: false, failure: "session_committed" };
  if (deps.clock.now().toISOString() >= session.expiresAt) return { ok: false, failure: "session_expired" };

  const loop = (await deps.db.select().from(loops).where(eq(loops.id, session.loopId)).limit(1))[0];
  if (!loop) return { ok: false, failure: "loop_not_found" };
  if (loop.machineId !== session.machineId) return { ok: false, failure: "session_not_found" };
  // Generation check #1 — BEFORE the stream is touched (决策 10: 写入期间和
  // 完成前都验证会话及配置代际).
  if (session.configRevision !== loop.artifactConfigRevision) return { ok: false, failure: "config_conflict" };

  // Only negotiated hashes are accepted — and the stream is NEVER pulled for
  // an unnegotiated one.
  if (!session.negotiatedHashes.includes(input.hash)) return { ok: false, failure: "hash_not_negotiated" };
  // The expected size comes from the session's negotiated manifest entry —
  // never from a declared size or Content-Length (决策 10). Every negotiated
  // hash has an entry (negotiatedHashes is derived from the manifest), and
  // the policy's hash_size_mismatch rule makes the size unambiguous.
  const entry = session.normalizedManifest.find((e) => e.hash === input.hash);
  if (!entry) {
    throw new ArtifactSyncInvariantError(`session ${session.id} negotiated hash ${input.hash} with no manifest entry`);
  }

  await deps.hooks?.afterResolve?.("put", session.id);

  const written = await deps.blobStore.writeVerified({
    namespaceId: session.namespaceId,
    hash: input.hash,
    expectedSize: entry.size,
    bytes: input.bytes,
  });
  if (!written.ok) {
    if (written.failure === "invalid_key") {
      // Unreachable: the hash came from a policy-validated manifest and the
      // namespace from the trusted resolver. Throw rather than looping a
      // permanent defect through the retryable storage_error class.
      throw new ArtifactSyncInvariantError(`blob store rejected a negotiated key ${session.namespaceId}/${input.hash}`);
    }
    if (written.failure === "content_mismatch") return { ok: false, failure: "content_mismatch" };
    return { ok: false, failure: "storage_error", cause: written.cause };
  }

  // Generation check #2 — AFTER the publish completes. A generation that
  // moved mid-upload rejects the PUT; the published-but-unreferenced blob is
  // the 决策 12 tolerated leftover (never delete shared blobs to fake a
  // filesystem rollback).
  const current = (await deps.db.select().from(loops).where(eq(loops.id, session.loopId)).limit(1))[0];
  if (!current) return { ok: false, failure: "loop_not_found" };
  if (current.artifactConfigRevision !== session.configRevision) return { ok: false, failure: "config_conflict" };

  // Record the metadata row ONLY after the publish succeeded (schema contract
  // on artifact_blobs). ON CONFLICT DO NOTHING makes a duplicate PUT
  // idempotent (AB4): the verified size is identical for identical content.
  await deps.db
    .insert(artifactBlobs)
    .values({ namespaceId: session.namespaceId, hash: input.hash, size: written.size, verifiedAt: deps.clock.now().toISOString() })
    .onConflictDoNothing();
  return { ok: true, size: written.size, published: written.published };
}

// ---- snapshot read (AC10 / binding loader) ----

/** Load a committed manifest by id — the Run artifactSnapshotId source
 *  (决策 12: the manifest id IS the snapshot id). null = no committed
 *  manifest row with this id. */
export async function readArtifactSnapshot(db: Db, manifestId: string): Promise<ArtifactManifestRow | null> {
  return (await db.select().from(artifactManifests).where(eq(artifactManifests.id, manifestId)).limit(1))[0] ?? null;
}
