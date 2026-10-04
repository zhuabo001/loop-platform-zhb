/**
 * Artifact sync-error reporting — the write path behind
 * POST /api/machine/loops/:id/artifact-sync-error (ADR-010 决策 13, Batch 2
 * slice 2).
 *
 * A daemon reports a LOCAL scan/watcher failure (one of the nine client
 * classes) together with the configuration generation and the base manifest
 * revision the failed scan was bound to. The report only lands when BOTH
 * still match the loop's current values — a late error must never overwrite
 * a newer success (commit success advances `artifactManifestRevision`; a
 * config change advances `artifactConfigRevision`).
 *
 * Evaluation order: trusted attribution → loop scope → unconfigured gate →
 * double-match gate → guarded UPDATE. Every refusal and a zero-row guard
 * loss both surface as `{ok:true, recorded:false}` with ZERO writes; the
 * write is bookkeeping, never the operation's result, so it never retries
 * (the `stampCommitFailure` precedent in sync.ts).
 *
 * `recorded:false` deliberately covers two causes (gate mismatch, guard
 * loss) — the wire only promises "no state was written", which is true for
 * both.
 */
import { and, eq, sql } from "drizzle-orm";

import type { ArtifactSyncErrorReportRequest } from "@loopzhb/protocol";

import type { Db } from "../db/index.js";
import { loops } from "../db/schema.js";
import type { Clock } from "../time.js";
import type { ArtifactAttributionResolver, TrustedMachineIdentity } from "./attribution.js";
import { isRecoverableStorageError } from "./storage-error.js";

export interface ArtifactSyncErrorDeps {
  db: Db;
  clock: Clock;
  /** The ONLY namespace source (决策 7) — re-resolved per call. */
  attribution: ArtifactAttributionResolver;
  /** TEST-ONLY seam (the ArtifactConfigStoreDeps precedent): fires between
   *  the gate read and the guarded write, letting a test commit a REAL
   *  competing write on the single PGlite connection (the CAS-loss path). */
  hooks?: { afterGate?(loopId: string): void | Promise<void> };
}

export type RecordArtifactSyncErrorResult =
  | { ok: true; recorded: boolean }
  | { ok: false; failure: "attribution_missing" | "loop_not_found" }
  | { ok: false; failure: "storage_error"; cause?: unknown };

/**
 * Record one client-side sync failure on the loop's attempt state.
 *
 * `succeededAt` is never touched: a failure after a success keeps the
 * success stamp (the triple reads "attempted, last failure X, last success
 * T"). The unified OCC revision is bumped like every loops write, so a
 * concurrent management op's guard is not silently skipped over.
 */
export async function recordArtifactSyncError(
  deps: ArtifactSyncErrorDeps,
  machine: TrustedMachineIdentity,
  loopId: string,
  report: ArtifactSyncErrorReportRequest,
): Promise<RecordArtifactSyncErrorResult> {
  try {
    const attribution = await deps.attribution.resolve(machine);
    if (!attribution.ok) return { ok: false, failure: "attribution_missing" };

    const loop = (await deps.db.select().from(loops).where(eq(loops.id, loopId)).limit(1))[0];
    // Unknown OR another machine's loop: one leak-free refusal — existence
    // never leaks across scopes (决策 13's code-less 404 convention).
    if (!loop || loop.machineId !== attribution.machineId) return { ok: false, failure: "loop_not_found" };

    // A never-configured loop is (0, 0), so a spurious report could pass the
    // double-match gate and pollute a loop that has no sync state at all.
    if (loop.artifactDir === null) return { ok: true, recorded: false };

    // The double-match gate: both revisions must still equal the loop's
    // current values (决策 13 — 迟到错误不得覆盖较新的成功状态).
    if (
      loop.artifactConfigRevision !== report.configRevision ||
      loop.artifactManifestRevision !== report.baseManifestRevision
    ) {
      return { ok: true, recorded: false };
    }

    await deps.hooks?.afterGate?.(loop.id);
    const nowIso = deps.clock.now().toISOString();
    const updated = await deps.db
      .update(loops)
      .set({
        artifactSyncAttemptedAt: nowIso,
        artifactSyncError: report.failure,
        updatedAt: nowIso,
        revision: sql`${loops.revision} + 1`,
      })
      .where(
        and(
          eq(loops.id, loop.id),
          // The revision guard is the OCC proof that the row did not move
          // between the gate read and this write; a concurrent commit or
          // config change loses it and the report is honestly not recorded.
          eq(loops.revision, loop.revision),
          eq(loops.artifactConfigRevision, report.configRevision),
          eq(loops.artifactManifestRevision, report.baseManifestRevision),
        ),
      )
      .returning({ id: loops.id });
    return { ok: true, recorded: updated.length === 1 };
  } catch (err) {
    if (isRecoverableStorageError(err)) return { ok: false, failure: "storage_error", cause: err };
    throw err; // unrecognized defects keep the raw-throw boundary (决策 13)
  }
}
