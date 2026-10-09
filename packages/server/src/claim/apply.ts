/**
 * The single claim transaction (ADR-011 决策 21). Opens ONLY after every blob
 * has been copied and verified, and writes nothing but metadata.
 *
 * Exactly four things change:
 *   - `artifact_manifests.namespace_id`
 *   - `artifact_sync_sessions.namespace_id` (committed ones included — a
 *     committed session whose namespace was left behind can never replay its
 *     stored receipt again)
 *   - `machines.team_id`
 *   - new `artifact_blobs` rows in the TEAM namespace
 *
 * Everything else is preserved verbatim: manifest ids, entries, revision,
 * committedAt, session receipts and normalized manifests, `runs.artifact_snapshot_id`,
 * `loops.*` and `machines.id`/`token_hash`. That is the precise carve-out from
 * ADR-010's "manifests are immutable" rule — the namespace column is migrated
 * exactly once, here, and never afterwards.
 *
 * Every UPDATE is guarded on its exact pre-image and asserts its row count, so
 * a world that moved since planning aborts the whole transaction instead of
 * half-applying it. The last statement re-derives the attribution through the
 * PRODUCTION resolver: if the Team resolver does not now produce exactly the
 * namespace this CLI wrote, the claim did not do what it claims to have done.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { createTeamAttributionResolver } from "../artifact/attribution-team.js";
import type { Db } from "../db/index.js";
import { artifactBlobs, artifactManifests, artifactSyncSessions, machines, runs } from "../db/schema.js";
import type { Clock } from "../time.js";

import type { ClaimPlan, ClaimRefusal } from "./plan.js";

export class ClaimGuardLostError extends Error {
  constructor(detail: string, subject?: string) {
    super(subject === undefined ? detail : `${detail}: ${subject}`);
    this.name = "ClaimGuardLostError";
  }
}

export interface ApplyClaimOptions {
  db: Db;
  plan: ClaimPlan;
  clock: Clock;
  /** TEST-ONLY seams (same shape as the ArtifactHome hooks).
   *  `beforeClaimTx` runs AFTER planning and BEFORE the transaction opens — the
   *  only place a test can move the world under the planner and prove the
   *  guarded UPDATEs notice. `insideClaimTx` proves the rollback without a real
   *  DB fault. */
  hooks?: { beforeClaimTx?: (db: Db) => Promise<void>; insideClaimTx?: () => Promise<void> };
}

export interface ApplyOutcome {
  machinesClaimed: number;
  manifests: number;
  sessions: number;
  blobRowsInserted: number;
  blobRowsAlreadyPresent: number;
}

export type ApplyResult = { ok: true; outcome: ApplyOutcome } | { ok: false; refusal: ClaimRefusal };

export async function applyClaim(options: ApplyClaimOptions): Promise<ApplyResult> {
  const { db, plan } = options;
  const nowIso = options.clock.now().toISOString();

  const outcome: ApplyOutcome = {
    machinesClaimed: 0,
    manifests: 0,
    sessions: 0,
    blobRowsInserted: 0,
    blobRowsAlreadyPresent: 0,
  };

  try {
    await options.hooks?.beforeClaimTx?.(db);
    await db.transaction(async (tx) => {
      for (const machine of plan.toClaim) {
        const preImage = and(
          eq(artifactManifests.machineId, machine.id),
          eq(artifactManifests.namespaceId, machine.sourceNamespace),
        );
        const manifests = await tx
          .update(artifactManifests)
          .set({ namespaceId: plan.teamId })
          .where(preImage)
          .returning({ id: artifactManifests.id });
        if (manifests.length !== machine.manifestCount) {
          throw new ClaimGuardLostError("manifest_update_mismatch", machine.id);
        }
        outcome.manifests += manifests.length;

        const sessions = await tx
          .update(artifactSyncSessions)
          .set({ namespaceId: plan.teamId })
          .where(
            and(eq(artifactSyncSessions.machineId, machine.id), eq(artifactSyncSessions.namespaceId, machine.sourceNamespace)),
          )
          .returning({ id: artifactSyncSessions.id });
        if (sessions.length !== machine.sessionCount) {
          throw new ClaimGuardLostError("session_update_mismatch", machine.id);
        }
        outcome.sessions += sessions.length;

        // `team_id IS NULL` is the ownership guard: a machine claimed by
        // someone else between planning and now must not be silently moved.
        const claimed = await tx
          .update(machines)
          .set({ teamId: plan.teamId })
          .where(and(eq(machines.id, machine.id), isNull(machines.teamId)))
          .returning({ id: machines.id });
        if (claimed.length !== 1) throw new ClaimGuardLostError("machine_update_mismatch", machine.id);
        outcome.machinesClaimed += 1;

        // Defensive re-check for the one thing the lock cannot rule out: an
        // OLD server build that does not honour the dataDir lock, still holding
        // a live lease. Cheaper than reasoning about it.
        const running = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.machineId, machine.id), eq(runs.phase, "running")))
          .limit(1);
        if (running.length > 0) throw new ClaimGuardLostError("run_appeared", running[0]!.id);

        // The post-claim invariant, asserted through the PRODUCTION resolver:
        // after this transaction the Team resolver must produce exactly the
        // namespace this CLI wrote.
        const resolved = await createTeamAttributionResolver({ db: tx }).resolve({ machineId: machine.id });
        if (!resolved.ok || resolved.namespaceId !== plan.teamId) {
          throw new ClaimGuardLostError("attribution_disagrees", machine.id);
        }
      }

      const wanted = [...plan.expectedSize.keys()];
      if (wanted.length > 0) {
        const existing = await tx
          .select({ hash: artifactBlobs.hash, size: artifactBlobs.size })
          .from(artifactBlobs)
          .where(and(eq(artifactBlobs.namespaceId, plan.teamId), inArray(artifactBlobs.hash, wanted)));
        for (const row of existing) {
          // Same hash, different size: the two namespaces disagree about what
          // the content is. Never pick a winner — refuse.
          if (row.size !== plan.expectedSize.get(row.hash)) {
            throw new ClaimGuardLostError("blob_size_conflict", row.hash);
          }
        }
        const have = new Set(existing.map((row) => row.hash));
        outcome.blobRowsAlreadyPresent = have.size;
        const missing = wanted.filter((hash) => !have.has(hash));
        if (missing.length > 0) {
          // `onConflictDoNothing` closes the residual TOCTOU between the select
          // and this insert; the select above is what makes a SIZE conflict
          // detectable rather than silently accepted. The two-machines-one-team
          // hash reuse lands here: the row already exists and is kept as-is.
          await tx
            .insert(artifactBlobs)
            .values(
              missing.map((hash) => ({
                namespaceId: plan.teamId,
                hash,
                size: plan.expectedSize.get(hash)!,
                verifiedAt: nowIso,
              })),
            )
            .onConflictDoNothing();
          outcome.blobRowsInserted += missing.length;
        }
      }

      await options.hooks?.insideClaimTx?.();
    });
  } catch (err) {
    if (err instanceof ClaimGuardLostError) {
      return { ok: false, refusal: { failure: "claim_guard_lost", detail: err.message } };
    }
    return { ok: false, refusal: { failure: "claim_transaction_failed", detail: String(err) } };
  }

  return { ok: true, outcome };
}
