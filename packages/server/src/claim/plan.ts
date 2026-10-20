/**
 * The read-only half of `claim:legacy` (ADR-011 决策 21): resolve the target,
 * check every selected machine and its whole resource chain, and decide what
 * the copy step would do — WITHOUT copying a byte or writing a row.
 *
 * Two rules shape everything here:
 *
 *  1. ALL-OR-NOTHING AT THE SELECTION LEVEL. One machine owned by another team
 *     (or one broken chain) refuses the WHOLE run. There is no "claim what you
 *     can" fallback, because a partially claimed selection is exactly the
 *     state the batch contract forbids.
 *  2. FAIL CLOSED ON ANOMALY. A blob row whose file is gone, a manifest whose
 *     namespace drifted, an entry with no blob row: all refuse. The claim is
 *     the last chance to notice a broken history before the source namespace
 *     stops being the place anyone looks.
 *
 * The target-side `has()` classification (reuse vs copy) is the ONLY blob-store
 * access here, and it is an lstat — dry-run must stay cheap and must not read
 * any blob bytes (dry-run depth ruling, 决策 21).
 */
import { ARTIFACT_HASH_RE } from "@loopzhb/protocol";
import { and, eq } from "drizzle-orm";

import { NAMESPACE_ID_RE, type BlobStore } from "../artifact/blob-store.js";
import { isLegalExpectedSize } from "../artifact/blob-store-verify.js";
import type { Db } from "../db/index.js";
import {
  artifactBlobs,
  artifactManifests,
  artifactSyncSessions,
  loops,
  machines,
  memberships,
  runs,
  teams,
  users,
} from "../db/schema.js";

/** The stable failure vocabulary. The CLI maps every one of these to exit 1;
 *  the report prints the code verbatim so an operator can grep the runbook. */
export type ClaimFailureCode =
  | "target_user_missing"
  | "target_team_missing"
  | "target_team_namespace_invalid"
  | "target_membership_missing"
  | "machine_missing"
  | "machine_revoked"
  | "machine_owned_by_other_team"
  | "machine_run_active"
  | "chain_inconsistent"
  | "source_blob_missing"
  | "source_blob_corrupt"
  | "target_blob_corrupt"
  | "storage_error"
  /** A guarded UPDATE matched an unexpected row count, or the in-transaction
   *  post-claim invariant failed. The world moved under the planner. */
  | "claim_guard_lost"
  /** The transaction threw for any other reason; nothing was committed. */
  | "claim_transaction_failed";

export interface ClaimRefusal {
  failure: ClaimFailureCode;
  machineId?: string;
  hash?: string;
  /** Fixed sub-reason for `chain_inconsistent` (e.g. `manifest_namespace_mismatch`). */
  detail?: string;
  /** The offending row id, when one names the problem better than an index. */
  subject?: string;
}

export interface MachinePlan {
  id: string;
  /** True ⇒ already owned by the target team: verified, then left alone. */
  alreadyClaimed: boolean;
  /** The namespace this machine's Artifact rows must live in RIGHT NOW. */
  sourceNamespace: string;
  loopCount: number;
  runCount: number;
  /** Reported as a WARNING, never a refusal (决策 21). A `running` Run never
   *  reaches the plan at all — it refuses the whole run. */
  pendingRunCount: number;
  manifestCount: number;
  sessionCount: number;
  committedSessionCount: number;
  blobRowCount: number;
}

export interface ClaimPlan {
  dataDir: string;
  userId: string;
  username: string;
  teamId: string;
  teamName: string;
  /** Sorted by machine id — deterministic regardless of argv order. */
  machines: MachinePlan[];
  toClaim: MachinePlan[];
  alreadyClaimed: MachinePlan[];
  /** Deduped, deterministic (hash asc) target-side work. */
  copyHashes: string[];
  reuseHashes: string[];
  copyBytes: number;
  reuseBytes: number;
  /** hash → the verified size recorded on the source blob row. */
  expectedSize: Map<string, number>;
  /** hash → the namespace the bytes currently live in (read side). */
  sourceNamespaceOf: Map<string, string>;
}

export type PlanClaimResult = { ok: true; plan: ClaimPlan } | { ok: false; refusal: ClaimRefusal };

export interface PlanClaimOptions {
  db: Db;
  blobStore: BlobStore;
  dataDir: string;
  githubUserId: string;
  machineIds: readonly string[];
}

export async function planClaim(options: PlanClaimOptions): Promise<PlanClaimResult> {
  const { db, blobStore, githubUserId } = options;

  // --- target ---------------------------------------------------------------
  const user = (await db.select().from(users).where(eq(users.id, githubUserId)).limit(1))[0];
  if (user === undefined) return refuse("target_user_missing");

  const team = (
    await db
      .select()
      .from(teams)
      .where(and(eq(teams.ownerUserId, githubUserId), eq(teams.kind, "personal")))
      .limit(1)
  )[0];
  if (team === undefined) return refuse("target_team_missing");

  // Defensive by construction: `teams_id_namespace_ck` already pins the shape,
  // so this branch is UNREACHABLE in a database this code can produce. It stays
  // because handing a bad namespace to the BlobStore is the one failure mode
  // worth an explicit refusal; the acceptance record must say plainly that it
  // carries no test.
  if (!NAMESPACE_ID_RE.test(team.id)) return refuse("target_team_namespace_invalid");

  const membership = (
    await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, githubUserId), eq(memberships.teamId, team.id)))
      .limit(1)
  )[0];
  if (membership === undefined) return refuse("target_membership_missing");

  // --- machines (input order is replaced by id order for determinism) -------
  const sortedIds = [...options.machineIds].sort();
  const plannedMachines: MachinePlan[] = [];
  const hashSizes = new Map<string, number>();
  const sourceNamespaceOf = new Map<string, string>();

  for (const machineId of sortedIds) {
    const machine = (await db.select().from(machines).where(eq(machines.id, machineId)).limit(1))[0];
    if (machine === undefined) return refuse("machine_missing", { machineId });
    if (machine.revokedAt !== null) return refuse("machine_revoked", { machineId });

    const alreadyClaimed = machine.teamId === team.id;
    if (machine.teamId !== null && !alreadyClaimed) {
      return refuse("machine_owned_by_other_team", { machineId });
    }
    // An UNCLAIMED machine's history lives under its own id; an ALREADY
    // CLAIMED one must already be migrated. A claimed machine whose rows still
    // point at the machine namespace is a half-migrated world: refuse it,
    // never re-migrate it (决策 21).
    const sourceNamespace = alreadyClaimed ? team.id : machine.id;

    const chain = await checkChain(db, { machineId, sourceNamespace, teamId: team.id });
    if (!chain.ok) return chain;

    const active = await checkActiveRuns(db, machineId);
    if (!active.ok) return active;

    const loopCount = (await db.select({ id: loops.id }).from(loops).where(eq(loops.machineId, machineId))).length;

    for (const [hash, size] of chain.hashes) {
      const seen = hashSizes.get(hash);
      if (seen !== undefined && seen !== size) {
        return refuse("chain_inconsistent", { machineId, hash, detail: "blob_size_conflict" });
      }
      hashSizes.set(hash, size);
      sourceNamespaceOf.set(hash, sourceNamespace);
    }

    plannedMachines.push({
      id: machineId,
      alreadyClaimed,
      sourceNamespace,
      loopCount,
      runCount: chain.runCount,
      pendingRunCount: active.pendingRunCount,
      manifestCount: chain.manifestCount,
      sessionCount: chain.sessionCount,
      committedSessionCount: chain.committedSessionCount,
      blobRowCount: chain.hashes.size,
    });
  }

  // --- source presence + target-side classification -------------------------
  const expectedSize = new Map(hashSizes);
  const copyHashes: string[] = [];
  const reuseHashes: string[] = [];
  let copyBytes = 0;
  let reuseBytes = 0;

  for (const hash of [...expectedSize.keys()].sort()) {
    const size = expectedSize.get(hash)!;
    const namespace = sourceNamespaceOf.get(hash)!;

    const present = await blobStore.has({ namespaceId: namespace, hash });
    if (!present.ok) return refuse("storage_error", { hash, detail: present.failure });
    if (!present.present) return refuse("source_blob_missing", { hash, detail: namespace });

    // The target side: `has` on the team namespace is an lstat, never a read.
    const target = await blobStore.has({ namespaceId: team.id, hash });
    if (!target.ok) return refuse("storage_error", { hash, detail: target.failure });
    if (target.present) {
      reuseHashes.push(hash);
      reuseBytes += size;
    } else {
      copyHashes.push(hash);
      copyBytes += size;
    }
  }

  const toClaim = plannedMachines.filter((m) => !m.alreadyClaimed);
  const alreadyClaimed = plannedMachines.filter((m) => m.alreadyClaimed);

  return {
    ok: true,
    plan: {
      dataDir: options.dataDir,
      userId: user.id,
      username: user.username,
      teamId: team.id,
      teamName: team.name,
      machines: plannedMachines,
      toClaim,
      alreadyClaimed,
      copyHashes,
      reuseHashes,
      copyBytes,
      reuseBytes,
      expectedSize,
      sourceNamespaceOf,
    },
  };
}

/** The per-machine resource chain (决策 21). Every check is a read; the first
 *  failure names its sub-reason. */
async function checkChain(
  db: Db,
  input: { machineId: string; sourceNamespace: string; teamId: string },
): Promise<
  | {
      ok: true;
      hashes: Map<string, number>;
      manifestCount: number;
      sessionCount: number;
      committedSessionCount: number;
      runCount: number;
    }
  | { ok: false; refusal: ClaimRefusal }
> {
  const { machineId, sourceNamespace } = input;
  const chainRefuse = (detail: string, extra: Partial<ClaimRefusal> = {}) =>
    ({ ok: false, refusal: { failure: "chain_inconsistent", machineId, detail, ...extra } }) as const;

  const loopRows = await db
    .select({ id: loops.id, artifactManifestId: loops.artifactManifestId })
    .from(loops)
    .where(eq(loops.machineId, machineId));
  const loopIds = new Set(loopRows.map((l) => l.id));

  const manifestRows = await db.select().from(artifactManifests).where(eq(artifactManifests.machineId, machineId));
  const sessionRows = await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.machineId, machineId));
  const runRows = await db
    .select({ id: runs.id, artifactSnapshotId: runs.artifactSnapshotId })
    .from(runs)
    .where(eq(runs.machineId, machineId));

  const manifestIds = new Set<string>();
  const hashes = new Map<string, number>();

  for (const manifest of manifestRows) {
    if (manifest.namespaceId !== sourceNamespace) {
      return chainRefuse("manifest_namespace_mismatch", { subject: manifest.id });
    }
    if (!loopIds.has(manifest.loopId)) return chainRefuse("manifest_orphan_loop", { subject: manifest.id });
    if (manifest.fileCount !== manifest.entries.length) {
      return chainRefuse("manifest_file_count_mismatch", { subject: manifest.id });
    }
    const total = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
    if (manifest.totalBytes !== total) return chainRefuse("manifest_total_bytes_mismatch", { subject: manifest.id });

    for (const entry of manifest.entries) {
      if (!ARTIFACT_HASH_RE.test(entry.hash)) return chainRefuse("manifest_entry_bad_hash", { subject: manifest.id });
      if (!isLegalExpectedSize(entry.size)) return chainRefuse("manifest_entry_bad_size", { subject: manifest.id });
      hashes.set(entry.hash, entry.size);
    }
    manifestIds.add(manifest.id);
  }

  for (const session of sessionRows) {
    if (session.namespaceId !== sourceNamespace) {
      return chainRefuse("session_namespace_mismatch", { subject: session.id });
    }
    if (!loopIds.has(session.loopId)) return chainRefuse("session_orphan_loop", { subject: session.id });
  }

  for (const run of runRows) {
    if (run.artifactSnapshotId !== null && !manifestIds.has(run.artifactSnapshotId)) {
      return chainRefuse("run_snapshot_dangling", { subject: run.id });
    }
  }

  // The loop's own snapshot cursor must also resolve — a loop pointing at a
  // manifest that is not the machine's means the two halves of the history
  // disagree about what was committed.
  for (const loop of loopRows) {
    if (loop.artifactManifestId !== null && !manifestIds.has(loop.artifactManifestId)) {
      return chainRefuse("loop_snapshot_dangling", { subject: loop.id });
    }
  }

  // The blob rows are the copy set: they are the SUPERSET of the manifest
  // entries (checked next) and the only thing a still-pending session can
  // commit against after the claim — a session whose negotiated hashes were
  // never recorded would fail its own completeness check in the new namespace.
  const blobRows = await db.select().from(artifactBlobs).where(eq(artifactBlobs.namespaceId, sourceNamespace));

  for (const entry of hashes) {
    const [hash, size] = entry;
    const row = blobRows.find((b) => b.hash === hash);
    if (row === undefined) return chainRefuse("blob_row_missing", { hash });
    if (row.size !== size) return chainRefuse("blob_size_mismatch", { hash });
  }
  for (const row of blobRows) {
    if (!ARTIFACT_HASH_RE.test(row.hash)) return chainRefuse("blob_row_bad_hash", { hash: row.hash });
    if (!isLegalExpectedSize(row.size)) return chainRefuse("blob_row_bad_size", { hash: row.hash });
    hashes.set(row.hash, row.size);
  }

  return {
    ok: true,
    hashes,
    manifestCount: manifestRows.length,
    sessionCount: sessionRows.length,
    committedSessionCount: sessionRows.filter((s) => s.receipt !== null && s.receipt !== undefined).length,
    runCount: runRows.length,
  };
}

/**
 * The active-Run gate (决策 21, user ruling): `running` REFUSES, `pending` only
 * warns.
 *
 * A `running` Run holds a live lease and its Report is authorized by the Run
 * credential — the machine-eligibility gate that now 401s an unclaimed machine
 * does not gate reports — so it can land AFTER the claim and re-derive
 * attribution against rows we just rewrote. That is what "drain first" means.
 *
 * A `pending` Run is inert before the claim (an unclaimed machine can never
 * claim work) and becomes claimable afterwards, which is the machine returning
 * to service. Refusing it would deadlock: cancelling needs the admin API,
 * which needs the server up, which the lock forbids.
 */
async function checkActiveRuns(
  db: Db,
  machineId: string,
): Promise<{ ok: true; pendingRunCount: number } | { ok: false; refusal: ClaimRefusal }> {
  const running = (
    await db.select({ id: runs.id }).from(runs).where(and(eq(runs.machineId, machineId), eq(runs.phase, "running"))).limit(1)
  )[0];
  if (running !== undefined) return { ok: false, refusal: { failure: "machine_run_active", machineId, subject: running.id } };

  const pending = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.machineId, machineId), eq(runs.phase, "pending")));
  return { ok: true, pendingRunCount: pending.length };
}

function refuse(failure: ClaimFailureCode, extra: Omit<ClaimRefusal, "failure"> = {}): PlanClaimResult {
  return { ok: false, refusal: { failure, ...extra } };
}
