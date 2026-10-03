/**
 * ArtifactHome — the Phase 5 artifact-sync state machine (ADR-010 决策 6–12,
 * Phase 5 Batch 1 slice 4). This module is the ONLY writer of the
 * artifact_sync_sessions / artifact_manifests / artifact_blobs rows and of the
 * loop's artifact pointer + sync-attempt triple; Batch 1 wires it from TESTS
 * ONLY — no production route, no composition (决策 16).
 *
 * PREPARE negotiates a sync session:
 *  - Fixed evaluation order (决策 13's per-step codes): manifest policy →
 *    attribution → loop scope → committed replay → configured → config
 *    generation → base revision → pending/new idempotency. Validation
 *    precedes attribution because a manifest failure is payload-local and
 *    leaks nothing about scope. The committed replay precedes the
 *    configured/generation/base checks: a real commit advanced the loop's
 *    base past the session's, so those checks would misclassify the original
 *    payload's re-prepare as a conflict and orphan the stored receipt (决策
 *    9's recovery path). Only a PENDING-or-new key is decided by the current
 *    generation/base, so an old-generation request is a config/manifest
 *    conflict even when its key would otherwise "reuse" a stale pending
 *    session (AM6's session-generation half).
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
 *    metadata row: a row whose VERIFIED size contradicts the negotiated
 *    entry does not back this session (the declared size was never verified —
 *    the upload is re-demanded, and writeVerified re-checks the bytes against
 *    the manifest), a row whose file is missing still demands re-upload
 *    (AB8's prepare half), and a has() failure is storage_error — never a
 *    silent "needed" (the frozen BlobStore contract: has never swallows
 *    storage errors).
 *  - prepare writes NOTHING to the current view (no loops write). Its one
 *    write path (the session insert) locks the resolved loop's row FOR
 *    UPDATE inside the transaction and re-verifies the observed unified OCC
 *    revision under the lock, so a concurrent generation bump loses the
 *    guard and the bounded re-run re-plans on fresh state — the write path
 *    is race-safe, not single-thread-only (withGuardRetry: exactly one
 *    re-run, then ArtifactSyncRaceLostError).
 *
 * PUT uploads one negotiated blob (决策 10): the session (carried by id) is
 * re-validated on EVERY upload — attribution, existence (unknown OR
 * cross-attribution is the same leak-free session_not_found), committed
 * state, pending expiry, and the config generation. The whole set is checked
 * BEFORE the byte stream starts AND re-verified after the publish completes
 * (the publish takes real time: the attribution is re-resolved and the
 * session + loop re-read before the upload counts) — a generation that moved
 * mid-upload, a lapsed TTL, a committed session or an attribution remap all
 * reject the PUT; the published-but-unreferenced blob is the 决策 12
 * tolerated leftover. Only hashes the session negotiated are accepted, and
 * the stream is never pulled for an unnegotiated one. The byte stream is the
 * ONLY source of truth: expectedSize comes from the session's negotiated
 * manifest entry, never from a declared size. Failures map verbatim from the
 * BlobStore contract (content_mismatch/storage_error); invalid_key is
 * unreachable (the hash came from a policy-validated manifest, the namespace
 * from the trusted resolver) and throws an invariant violation rather than
 * looping a permanent defect through a retryable class. A successful publish
 * records the (namespaceId, hash) metadata row with the VERIFIED size —
 * ON CONFLICT DO NOTHING makes a duplicate PUT idempotent, and wrong bytes
 * can never be laundered by an existing blob (writeVerified always
 * re-verifies the stream).
 *
 * COMMIT (决策 11/12) turns a fully-uploaded session into an immutable
 * manifest + a fixed receipt:
 *  - The receipt replay precedes everything after the scope checks: a stored
 *    receipt is returned VERBATIM (AC7 — no new snapshot, no revision bump,
 *    no pointer touch), it never expires, and it survives config generation
 *    changes and even an out-of-band loop deletion (attribution-gated).
 *  - Precheck order (session-anchored, so drift since PREPARE is caught
 *    regardless of any intermediate loop write): receipt → expired →
 *    config generation → base revision → manifest-revision exhaustion.
 *  - Blob completeness is verified BEFORE the transaction: every negotiated
 *    hash needs a metadata row whose VERIFIED size matches the negotiated
 *    entry AND a present file — a missing/contradicting row or a row without
 *    its file is blob_missing (AB8, the resume class; the dedup path never
 *    launders a lying size past writeVerified, so a manifest's totalBytes
 *    always matches verified content truth), a has() failure is
 *    storage_error (never a silent "missing").
 *  - Adjudication observes the (loop, session) pair LOOP-FIRST, SESSION-
 *    SECOND — out-of-tx (a scope probe reads the session for its loopId,
 *    then the loop, then ONE bounded session re-read decides) and inside the
 *    commit transaction alike. The observation order is what keeps the two
 *    reads consistent: a competitor's commit advances the loop's base AND
 *    writes the session's receipt ATOMICALLY (one transaction), the loop's
 *    generations are monotonic, and a receipt is write-once — so a session
 *    read placed AFTER the loop read can never observe "the base advanced
 *    past this session, yet no receipt exists". An advanced base alongside a
 *    null receipt therefore always came from a DIFFERENT session (a real
 *    manifest_conflict), while a completed same-session winner's receipt is
 *    always observed and replayed. The reverse order was the A4-1 Round-2
 *    defect: session read → competitor commit → loop read produced a bogus
 *    manifest_conflict that also stamped its wire code over the winner's
 *    success triple. READ COMMITTED suffices — no row locks are added, so
 *    prepare's FOR UPDATE stays the module's only lock and no lock ordering
 *    arises. (PGlite evidence; the real multi-physical-connection
 *    verification stays #11/#72 scope.)
 *  - ONE transaction then re-observes the LIVE pair in the same order and
 *    decides receipt-FIRST (a winner's receipt replays verbatim — same-
 *    session concurrent commits converge to ONE receipt; the pending TTL is
 *    re-checked against a fresh clock read; the attribution association is
 *    re-verified), then re-checks the LIVE loop row against the SESSION's
 *    generation/base/exhaustion plus the loop↔session association (决策
 *    11's 事务内重新检查), lands the guarded
 *    loop UPDATE FIRST (the row lock serializes concurrent commits, making
 *    the (loopId, manifestRevision) unique violation unreachable for a
 *    correct race — a defensive cause-chain conversion still maps it to a
 *    guard loss), inserts the immutable manifest (fresh ID-factory id, so
 *    identical content from two sessions is two snapshots), fires the
 *    throw-only insideCommitTx seam, and writes the receipt behind a
 *    `receipt IS NULL` guard — a same-session concurrent commit loses the
 *    guard, rolls back EVERYTHING (no orphan manifest, no pointer move),
 *    and its bounded re-run replays the winner's receipt (AC7 convergence).
 *  - The guarded UPDATE re-baselines on the IN-TX row: a competitor that
 *    bumped only the OCC revision (an unrelated domain write) does NOT
 *    block a commit — the session-anchored re-checks carry the semantic
 *    guards, the revision predicate closes the select→update window.
 *  - Sync-attempt stamping (the loops triple, wire-code values): the success
 *    stamp rides the in-tx guarded UPDATE; failure stamps
 *    (manifest_conflict / blob_missing / storage_error) are a best-effort
 *    post-failure UPDATE guarded on (id, resolved revision, session
 *    generation) — the generation predicate is AM6's 旧代请求不能更新新代状态
 *    guard, zero rows skip silently with NO retry. config_conflict /
 *    session_expired / exhaustion never stamp (no current-generation
 *    attempt exists, or no wire code exists yet — Batch 2 owns the mapping).
 *
 * Internal failure literals are finer than the 9 wire codes (决策 13's
 * double layer, the RunCapabilityInvalidError precedent); the Batch 2 route
 * layer owns the mapping. `artifact_dir_unconfigured`, the 404-grade
 * `loop_not_found`/`session_not_found` and `session_committed` have no wire
 * code yet — recorded in the ADR revision log.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  ARTIFACT_SYNC_SESSION_TTL_MILLIS,
  normalizeManifestEntries,
  type ArtifactErrorCode,
  type ArtifactManifestFailure,
  type CommitArtifactSyncResponse,
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
  type NewArtifactManifest,
  type NewArtifactSyncSession,
} from "../db/schema.js";
import { REVISION_INT32_MAX } from "../schedule/transition.js";
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
 *  row. No row → needed (no store call required). A row whose VERIFIED size
 *  contradicts the negotiated entry → still needed (the declared size was
 *  never verified; writeVerified re-checks the bytes against the manifest —
 *  the dedup path never launders a lying size). A row whose FILE is gone →
 *  still needed (AB8: prepare re-negotiates the missing blob; commit refuses
 *  the incomplete snapshot). A has() failure → storage_error, never a silent
 *  "needed". */
async function computeNeedHashes(
  deps: ArtifactHomeDeps,
  namespaceId: string,
  entries: readonly NormalizedManifestEntry[],
): Promise<{ ok: true; need: string[] } | { ok: false; cause?: unknown }> {
  const need: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.hash)) continue; // one negotiation per hash (policy dedups)
    seen.add(entry.hash);
    const row = (
      await deps.db
        .select({ size: artifactBlobs.size })
        .from(artifactBlobs)
        .where(and(eq(artifactBlobs.namespaceId, namespaceId), eq(artifactBlobs.hash, entry.hash)))
        .limit(1)
    )[0];
    if (!row || row.size !== entry.size) {
      need.push(entry.hash);
      continue;
    }
    const presence = await deps.blobStore.has({ namespaceId, hash: entry.hash });
    if (!presence.ok) return { ok: false, cause: presence.cause };
    if (!presence.present) need.push(entry.hash);
  }
  return { ok: true, need };
}

/** The session insert — the ONLY write prepare performs, and it touches no
 *  current-view state. The transaction first locks the resolved loop's row
 *  FOR UPDATE and re-verifies the observed OCC revision UNDER the lock
 *  (ADR-009: snapshot-derived writes hold the row's write access; a lockless
 *  SELECT would leave a real multi-connection SELECT→INSERT window where a
 *  config write commits unguarded): a concurrent loops write between the
 *  outer resolve and this tx loses the guard, rolls back, and the bounded
 *  re-run re-plans on fresh state. The insert itself arbitrates the
 *  (namespaceId, machineId, requestId) unique key with ON CONFLICT DO
 *  NOTHING: a concurrent same-key prepare won — re-read the winner INSIDE the
 *  tx and let the caller's planner decide, so the unique violation never
 *  escapes as an exception. */
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
    // ADR-009 L138/L145: a write derived from the loop's decision snapshot
    // must hold the row's write access for the observed revision. A plain
    // in-tx SELECT takes no lock — under READ COMMITTED a concurrent loops
    // write (a config bump, a claim, anything) could commit in the
    // SELECT→INSERT window without losing any guard. Lock the row FOR UPDATE
    // (the binding-plan.ts Round-2 precedent) and re-verify the revision
    // UNDER the lock: a concurrent writer either committed first (the locked
    // re-read observes the new revision → guard loss → bounded re-run) or
    // blocks until this tx ends. A row lock never modifies the current view.
    const locked = await tx.select({ revision: loops.revision }).from(loops).where(eq(loops.id, loop.id)).for("update");
    if (locked.length !== 1 || locked[0]!.revision !== loop.revision) {
      throw new ArtifactSyncGuardLostError("prepare", loop.id);
    }
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

  const fingerprint = preparePayloadFingerprint({
    loopId: request.loopId,
    configRevision: request.configRevision,
    baseManifestRevision: request.baseManifestRevision,
    entries,
  });
  const key: SessionKey = { namespaceId: attribution.namespaceId, machineId: attribution.machineId, requestId: request.requestId };
  const existing = (await deps.db.select().from(artifactSyncSessions).where(sessionKeyWhere(key)).limit(1))[0] ?? null;

  // 决策 9's committed replay precedes the configured/generation/base checks:
  // a REAL commit advanced the loop's base (and possibly generation) past the
  // session's, so those checks would misclassify the original payload's
  // re-prepare as a conflict and make the stored receipt unrecoverable
  // through prepare. Same key + same fingerprint + a receipt returns the
  // original session verbatim (needHashes is empty — the receipt is recovered
  // by re-committing this session, which replays it). A different fingerprint
  // NEVER replays (the fingerprint is the payload contract — the planner's
  // conflict branch below decides that case).
  if (existing !== null && existing.payloadFingerprint === fingerprint && existing.receipt !== null) {
    return {
      ok: true,
      outcome: "committed",
      response: { syncId: existing.id, needHashes: [], expiresAt: existing.expiresAt },
    };
  }

  // (4) An unconfigured loop never starts a sync (plan §1's dormancy rule).
  if (loop.artifactDir === null) return { ok: false, failure: "artifact_dir_unconfigured" };
  // (5)/(6) Generation + base BEFORE the pending/new idempotency decision
  // (决策 6/13): an old-generation request conflicts even when its key would
  // otherwise reuse a stale PENDING session (which could never commit anyway
  // — PUT/commit re-check the generation against the CURRENT loop).
  if (request.configRevision !== loop.artifactConfigRevision) return { ok: false, failure: "config_conflict" };
  if (request.baseManifestRevision !== loop.artifactManifestRevision) return { ok: false, failure: "manifest_conflict" };

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
  const need = await computeNeedHashes(deps, session.namespaceId, session.normalizedManifest);
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

  // Completion re-verification (决策 10: 写入期间和完成前都验证会话及配置代际):
  // the publish took real time, so EVERYTHING the pre-stream checks vouched
  // for is re-derived before the upload counts — the trusted attribution (a
  // namespace remap mid-stream revokes the session), the session's
  // committed/expired state, the loop's existence and its attribution
  // association, and the config generation. A refusal leaves the published
  // blob unreferenced — the 决策 12 tolerated leftover (never delete shared
  // blobs to fake a filesystem rollback) — and records NO metadata row.
  const attributionNow = await deps.attribution.resolve(machine);
  if (!attributionNow.ok) return { ok: false, failure: "attribution_missing" };
  const currentSession = await findSessionById(deps.db, session.id);
  if (
    !currentSession ||
    currentSession.namespaceId !== attributionNow.namespaceId ||
    currentSession.machineId !== attributionNow.machineId
  ) {
    return { ok: false, failure: "session_not_found" };
  }
  if (currentSession.receipt !== null) return { ok: false, failure: "session_committed" };
  if (deps.clock.now().toISOString() >= currentSession.expiresAt) return { ok: false, failure: "session_expired" };
  const current = (await deps.db.select().from(loops).where(eq(loops.id, currentSession.loopId)).limit(1))[0];
  if (!current) return { ok: false, failure: "loop_not_found" };
  if (current.machineId !== currentSession.machineId) return { ok: false, failure: "session_not_found" };
  if (current.artifactConfigRevision !== currentSession.configRevision) return { ok: false, failure: "config_conflict" };

  // Record the metadata row ONLY after the publish succeeded (schema contract
  // on artifact_blobs). ON CONFLICT DO NOTHING makes a duplicate PUT
  // idempotent (AB4): the verified size is identical for identical content.
  await deps.db
    .insert(artifactBlobs)
    .values({ namespaceId: currentSession.namespaceId, hash: input.hash, size: written.size, verifiedAt: deps.clock.now().toISOString() })
    .onConflictDoNothing();
  return { ok: true, size: written.size, published: written.published };
}

// ---- commit: pure precheck planner ----

export type CommitPrecheck =
  | { kind: "receipt" }
  | { kind: "expired" }
  | { kind: "config_conflict" }
  | { kind: "manifest_conflict" }
  | { kind: "exhausted" }
  | { kind: "proceed" };

/** The commit precheck over the session row and the loop's current
 *  generations. Fixed order (决策 11/13): a stored RECEIPT replays first — it
 *  never expires and stays readable across config generations; an expired
 *  pending session rejects before the generation checks (both are the
 *  renegotiate class, but expiry is the honest cause); then the SESSION's
 *  captured generation and base are compared against the loop's CURRENT
 *  values (session-anchored, so drift since prepare is caught regardless of
 *  intermediate loop writes); exhaustion is checked last — it only matters
 *  when a commit would otherwise proceed. The adapter gates scope
 *  (attribution, cross-machine) BEFORE this planner runs. */
export function planCommitPrecheck(input: {
  session: Pick<ArtifactSyncSessionRow, "receipt" | "expiresAt" | "configRevision" | "baseManifestRevision">;
  loop: Pick<Loop, "artifactConfigRevision" | "artifactManifestRevision">;
  nowIso: string;
}): CommitPrecheck {
  const { session, loop, nowIso } = input;
  if (session.receipt !== null) return { kind: "receipt" };
  if (nowIso >= session.expiresAt) return { kind: "expired" };
  if (session.configRevision !== loop.artifactConfigRevision) return { kind: "config_conflict" };
  if (session.baseManifestRevision !== loop.artifactManifestRevision) return { kind: "manifest_conflict" };
  if (loop.artifactManifestRevision >= REVISION_INT32_MAX) return { kind: "exhausted" };
  return { kind: "proceed" };
}

// ---- commit: DB adapter ----

export type CommitArtifactSyncResult =
  | { ok: true; receipt: CommitArtifactSyncResponse }
  | { ok: false; failure: "storage_error"; cause?: unknown }
  | {
      ok: false;
      failure:
        | "attribution_missing"
        | "session_not_found"
        | "session_expired"
        | "loop_not_found"
        | "config_conflict"
        | "manifest_conflict"
        | "blob_missing"
        | "manifest_revision_exhausted";
    };

/** The full internal failure literal set for commit. `manifest_revision_exhausted`
 *  is the slice-2 pre-declared literal (ADR revision log): a stable rejection
 *  — result union, zero writes, never thrown; its wire mapping is Batch 2's. */
export type CommitArtifactSyncFailure = Extract<CommitArtifactSyncResult, { ok: false }>["failure"];

/** The internal failures that stamp the loop's sync-attempt triple, mapped to
 *  their WIRE code (loops.artifactSyncError's enum is ARTIFACT_ERROR_CODES —
 *  the double layer of 决策 13). */
const COMMIT_STAMPED_FAILURES = {
  manifest_conflict: "artifact_manifest_conflict",
  blob_missing: "artifact_blob_missing",
  storage_error: "artifact_storage_error",
} as const satisfies Record<string, ArtifactErrorCode>;
type CommitStampedFailure = keyof typeof COMMIT_STAMPED_FAILURES;

/** Best-effort failure stamp (决策 8's 同步尝试状态): guarded on (id, the
 *  resolved OCC revision, the SESSION's config generation) — the generation
 *  predicate is AM6's 旧代请求不能更新新代状态 guard, so an old-generation
 *  failure can never overwrite the new generation's state. Zero rows (a
 *  fresher writer won) skip silently with NO retry — the triple is
 *  bookkeeping, never the operation's result. */
async function stampCommitFailure(
  deps: ArtifactHomeDeps,
  loop: Loop,
  session: ArtifactSyncSessionRow,
  failure: CommitStampedFailure,
  nowIso: string,
): Promise<void> {
  await deps.db
    .update(loops)
    .set({
      artifactSyncAttemptedAt: nowIso,
      artifactSyncError: COMMIT_STAMPED_FAILURES[failure],
      updatedAt: nowIso,
      revision: sql`${loops.revision} + 1`,
    })
    .where(
      and(
        eq(loops.id, loop.id),
        eq(loops.revision, loop.revision),
        eq(loops.artifactConfigRevision, session.configRevision),
      ),
    );
}

/** Walk the drizzle error cause chain for a Postgres unique violation
 *  (23505) — the defensive conversion for the (loopId, manifestRevision)
 *  unique index (the guarded loop UPDATE's row lock makes it unreachable for
 *  a correct race; the conversion keeps a contract breach on the bounded
 *  retry path instead of leaking a driver exception). */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  while (cur !== null && typeof cur === "object") {
    if ("code" in cur && (cur as { code: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

type CommitTxOutcome =
  | { kind: "committed"; receipt: CommitArtifactSyncResponse }
  | {
      kind: "aborted";
      failure: "session_not_found" | "session_expired" | "config_conflict" | "manifest_conflict" | "manifest_revision_exhausted";
    };

async function commitOnce(
  deps: ArtifactHomeDeps,
  machine: TrustedMachineIdentity,
  input: { syncId: string },
): Promise<CommitArtifactSyncResult> {
  const attribution = await deps.attribution.resolve(machine);
  if (!attribution.ok) return { ok: false, failure: "attribution_missing" };

  const probe = await findSessionById(deps.db, input.syncId);
  // Unknown OR cross-attribution: one leak-free refusal (决策 13) — a receipt
  // is never replayed across scope either.
  if (!probe || probe.namespaceId !== attribution.namespaceId || probe.machineId !== attribution.machineId) {
    return { ok: false, failure: "session_not_found" };
  }

  // The adjudicating pair is observed LOOP-FIRST, SESSION-SECOND (A4-1 Round
  // 2). A competitor's commit advances the loop's base AND writes the
  // session's receipt ATOMICALLY (one transaction), the loop's generations
  // only move forward, and a receipt is write-once — so the session read
  // placed AFTER the loop read can never observe "the base advanced past this
  // session, yet no receipt exists": an advanced base with a null receipt
  // always came from a DIFFERENT session (a real manifest_conflict), while a
  // completed same-session winner's receipt is always seen and replayed
  // below. The reverse order was the Round-2 defect — session read →
  // competitor commit → loop read produced a bogus conflict whose stamp also
  // overwrote the winner's success triple. The re-read is the bounded
  // re-evaluation: exactly ONE fresh session read, taken after the loop
  // observation, decides — no fixed extra checkpoint, no window moved.
  const loop = (await deps.db.select().from(loops).where(eq(loops.id, probe.loopId)).limit(1))[0];
  const session = await findSessionById(deps.db, probe.id);
  if (!session) throw new ArtifactSyncGuardLostError("commit", probe.id); // vanished mid-flight: re-resolve

  if (!loop) {
    // The receipt is self-contained and already attribution-gated: it replays
    // even across an out-of-band loop deletion (AC7's restart recovery must
    // never depend on unrelated state).
    return session.receipt !== null ? { ok: true, receipt: session.receipt } : { ok: false, failure: "loop_not_found" };
  }
  if (loop.machineId !== session.machineId) return { ok: false, failure: "session_not_found" };

  const nowIso = deps.clock.now().toISOString();
  const precheck = planCommitPrecheck({ session, loop, nowIso });
  if (precheck.kind === "receipt") return { ok: true, receipt: session.receipt! };
  if (precheck.kind === "expired") return { ok: false, failure: "session_expired" };
  if (precheck.kind === "config_conflict") return { ok: false, failure: "config_conflict" }; // never stamps
  if (precheck.kind === "exhausted") return { ok: false, failure: "manifest_revision_exhausted" }; // zero writes, never stamps
  if (precheck.kind === "manifest_conflict") {
    await stampCommitFailure(deps, loop, session, "manifest_conflict", nowIso);
    return { ok: false, failure: "manifest_conflict" };
  }

  // Blob completeness BEFORE the transaction (决策 11/12): every negotiated
  // hash needs a metadata row whose VERIFIED size matches the negotiated
  // entry AND a present file.
  const sizeByHash = new Map(session.normalizedManifest.map((entry) => [entry.hash, entry.size]));
  for (const hash of session.negotiatedHashes) {
    const expectedSize = sizeByHash.get(hash);
    if (expectedSize === undefined) {
      throw new ArtifactSyncInvariantError(`session ${session.id} negotiated hash ${hash} with no manifest entry`);
    }
    const row = (
      await deps.db
        .select({ size: artifactBlobs.size })
        .from(artifactBlobs)
        .where(and(eq(artifactBlobs.namespaceId, session.namespaceId), eq(artifactBlobs.hash, hash)))
        .limit(1)
    )[0];
    if (row && row.size === expectedSize) {
      const presence = await deps.blobStore.has({ namespaceId: session.namespaceId, hash });
      if (!presence.ok) {
        await stampCommitFailure(deps, loop, session, "storage_error", nowIso);
        return { ok: false, failure: "storage_error", cause: presence.cause };
      }
      if (presence.present) continue;
    }
    // No row, a row whose verified size contradicts the negotiated entry (the
    // dedup path never launders a lying size past writeVerified), or a row
    // whose file is gone (AB8): the snapshot is incomplete — commit refuses
    // (resume class: re-upload, then retry the same commit).
    await stampCommitFailure(deps, loop, session, "blob_missing", nowIso);
    return { ok: false, failure: "blob_missing" };
  }

  // TEST-ONLY interleaving seam — fires between the resolve/precheck and the
  // commit transaction (slice 5 commits a REAL competing write here).
  await deps.hooks?.afterResolve?.("commit", session.id);

  const outcome = await deps.db.transaction(async (tx): Promise<CommitTxOutcome> => {
    // (a) The SAME observation order as the outer adjudication: the LIVE loop
    // row first, the LIVE session row second. Under READ COMMITTED each
    // statement sees the latest committed state and the competitor's
    // base-advance + receipt-write commit ATOMICALLY, so the session read
    // placed after the loop read observes every completed same-session
    // winner's receipt — the two-read window is closed by the atomicity
    // invariant, no row locks needed (prepare's FOR UPDATE stays the module's
    // only lock). The DECISION order stays receipt-first regardless.
    const live = (await tx.select().from(loops).where(eq(loops.id, session.loopId)).limit(1))[0];
    if (!live) throw new ArtifactSyncGuardLostError("commit", session.id); // vanished mid-flight: roll back, re-resolve
    const liveSession = (
      await tx.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, session.id)).limit(1)
    )[0];
    if (!liveSession) throw new ArtifactSyncGuardLostError("commit", session.id); // vanished mid-flight: roll back, re-resolve
    if (liveSession.receipt !== null) return { kind: "committed", receipt: liveSession.receipt };
    if (deps.clock.now().toISOString() >= liveSession.expiresAt) return { kind: "aborted", failure: "session_expired" };
    if (liveSession.namespaceId !== attribution.namespaceId || liveSession.machineId !== attribution.machineId) {
      return { kind: "aborted", failure: "session_not_found" };
    }
    // (b) The LIVE loop row against the SESSION's generation/base — any drift
    // since prepare is caught here regardless of what the outer resolve saw.
    if (live.machineId !== liveSession.machineId) return { kind: "aborted", failure: "session_not_found" };
    if (live.artifactConfigRevision !== liveSession.configRevision) return { kind: "aborted", failure: "config_conflict" };
    if (live.artifactManifestRevision !== liveSession.baseManifestRevision) return { kind: "aborted", failure: "manifest_conflict" };
    if (live.artifactManifestRevision >= REVISION_INT32_MAX) return { kind: "aborted", failure: "manifest_revision_exhausted" };

    const manifestRevision = live.artifactManifestRevision + 1;
    const manifestId = deps.ids.manifestId();
    const receipt: CommitArtifactSyncResponse = { artifactSnapshotId: manifestId, manifestRevision };
    try {
      // (c) The guarded loop UPDATE lands FIRST: pointer + manifestRevision +
      // the SUCCESS stamp + the unified OCC bump, guarded on the in-tx row's
      // revision (the predicate is re-evaluated under the row lock — a
      // competitor in the select→update window loses the guard).
      const updated = await tx
        .update(loops)
        .set({
          artifactManifestId: manifestId,
          artifactManifestRevision: manifestRevision,
          artifactSyncAttemptedAt: nowIso,
          artifactSyncSucceededAt: nowIso,
          artifactSyncError: null,
          updatedAt: nowIso,
          revision: sql`${loops.revision} + 1`,
        })
        .where(and(eq(loops.id, live.id), eq(loops.revision, live.revision)))
        .returning({ id: loops.id });
      if (updated.length !== 1) throw new ArtifactSyncGuardLostError("commit", session.id);
      // (d) The immutable manifest — fresh ID-factory id (决策 12: identical
      // content from two sessions is still two snapshots).
      await tx.insert(artifactManifests).values({
        id: manifestId,
        namespaceId: liveSession.namespaceId,
        machineId: liveSession.machineId,
        loopId: liveSession.loopId,
        configRevision: liveSession.configRevision,
        manifestRevision,
        entries: liveSession.normalizedManifest,
        fileCount: liveSession.normalizedManifest.length,
        totalBytes: liveSession.normalizedManifest.reduce((sum, entry) => sum + entry.size, 0),
        committedAt: nowIso,
      } satisfies NewArtifactManifest);
      // (e) The throw-only seam (AC3: any failure here rolls back EVERYTHING).
      await deps.hooks?.insideCommitTx?.(session.id);
      // (f) The receipt behind a receipt-IS-NULL guard: a same-session
      // concurrent commit loses here, rolls back its loop update AND manifest
      // insert, and its bounded re-run replays the winner's receipt.
      const marked = await tx
        .update(artifactSyncSessions)
        .set({ receipt })
        .where(and(eq(artifactSyncSessions.id, session.id), isNull(artifactSyncSessions.receipt)))
        .returning({ id: artifactSyncSessions.id });
      if (marked.length !== 1) throw new ArtifactSyncGuardLostError("commit", session.id);
      return { kind: "committed", receipt };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ArtifactSyncGuardLostError("commit", session.id);
      throw err;
    }
  });

  if (outcome.kind === "aborted") {
    // The in-tx re-verification found drift the outer precheck predates. Only
    // manifest_conflict stamps (base competition IS an attempt conclusion);
    // session_not_found/session_expired/config_conflict/exhausted never stamp.
    if (outcome.failure === "manifest_conflict") {
      await stampCommitFailure(deps, loop, session, "manifest_conflict", nowIso);
    }
    return { ok: false, failure: outcome.failure };
  }
  return { ok: true, receipt: outcome.receipt };
}

/**
 * Commit a fully-uploaded session (ADR-010 决策 11/12). See the module header
 * for the receipt/precheck/completeness/transaction contract. The bounded
 * re-run (withGuardRetry — exactly once, then ArtifactSyncRaceLostError)
 * covers the guard losses: the loop CAS, the receipt guard, the defensive
 * unique-violation conversion.
 */
export async function commitArtifactSync(
  deps: ArtifactHomeDeps,
  machine: TrustedMachineIdentity,
  input: { syncId: string },
): Promise<CommitArtifactSyncResult> {
  return withGuardRetry(
    () => commitOnce(deps, machine, input),
    (err) => err instanceof ArtifactSyncGuardLostError,
    (err) => new ArtifactSyncRaceLostError((err as ArtifactSyncGuardLostError).op, (err as ArtifactSyncGuardLostError).id),
  );
}

// ---- snapshot read (AC10 / binding loader) ----

/** Load a committed manifest by id — the Run artifactSnapshotId source
 *  (决策 12: the manifest id IS the snapshot id). null = no committed
 *  manifest row with this id. */
export async function readArtifactSnapshot(db: Db, manifestId: string): Promise<ArtifactManifestRow | null> {
  return (await db.select().from(artifactManifests).where(eq(artifactManifests.id, manifestId)).limit(1))[0] ?? null;
}
