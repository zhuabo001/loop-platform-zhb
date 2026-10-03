/**
 * Artifact snapshot binding — the pure validation/write-plan and its guarded
 * persistence (ADR-010 决策 12, plan §3 "Run 快照边界"; Phase 5 Batch 1
 * slice 2).
 *
 * A run's final report may reference an artifact snapshot (the immutable
 * manifest id minted at commit). Binding is VALIDATED, never trusted: the
 * manifest row must exist (committed), its id must BE the referenced
 * snapshot id (#69), and its namespace / machine / loop / config generation
 * must match the run and the loop's CURRENT generation.
 * An illegal reference is recorded as the run's `artifactSyncError` and
 * NEVER changes the run's own outcome — artifact sync failure is not run
 * failure. Canceled, superseded or reclaimed runs that never produced a
 * legal final report do NOT bind (phase !== "running" at plan time).
 *
 * Batch 1 slice 2 delivers the plan and its persistence ONLY — nothing is
 * wired into the production report transaction (决策 16); Batch 2 calls
 * `planArtifactSnapshotBinding` inside `runReportTx` and lets that
 * transaction's CAS/rollback driver absorb the guard-lost throw.
 */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { loops, runs, type ArtifactManifestRow, type Loop, type Run } from "../db/schema.js";

/** Why a snapshot reference was refused — the value-set seed for the
 *  free-form `runs.artifactSyncError` column (Batch 2 owns the final
 *  taxonomy; the wire report field stays free-form). */
export type ArtifactBindingRejection =
  /** No committed manifest row evidences the referenced snapshot id: the
   *  caller's lookup found nothing, OR the row it returned is NOT the
   *  referenced id — an unverified id never binds (#69). Existence never
   *  leaks across namespaces. */
  | "snapshot_not_committed"
  /** The manifest's namespace ≠ the run's resolved trusted attribution
   *  (决策 7 — attribution is re-derived per operation, never wire input). */
  | "cross_namespace"
  /** The machine chain is broken: manifest / run / loop / trusted
   *  attribution machineIds are not all equal (#70 — in the no-FK model the
   *  loop's machine is re-verified like every other link, never assumed). */
  | "cross_machine"
  /** The manifest belongs to a different loop. */
  | "cross_loop"
  /** The manifest committed under an older config generation than the
   *  loop's current one (决策 8 — a stale-generation snapshot never binds). */
  | "stale_config_generation";

export type ArtifactBindingPlan =
  /** Nothing to write (no snapshot referenced, or the run is not in a
   *  bindable phase). */
  | { kind: "skip" }
  /** Bind the verified manifest id; touches ONLY the artifact column.
   *  `guardConfigRevision` is the loop's config generation observed at plan
   *  time — apply locks and re-verifies the LIVE loop row in the same UPDATE
   *  statement, so a concurrent config write cannot pass the guard (#71). */
  | { kind: "bind"; runWrites: { artifactSnapshotId: string }; guardConfigRevision: number }
  /** Record the stable rejection; NEVER changes the run's outcome. */
  | { kind: "record_error"; reason: ArtifactBindingRejection; runWrites: { artifactSnapshotId: null; artifactSyncError: string } };

export interface ArtifactBindingInput {
  run: Run;
  /** The run's loop — only the fields the checks need. */
  loop: Pick<Loop, "id" | "machineId" | "artifactConfigRevision">;
  /** The committed manifest row for `snapshotId`, or null (the caller looked
   *  it up and found nothing). */
  manifest: ArtifactManifestRow | null;
  /** The report-carried snapshot reference; undefined = the report carries
   *  none. */
  snapshotId: string | undefined;
  /** The trusted attribution the CALLER resolved via the frozen resolver
   *  (artifact/attribution.ts) for the run's machine — never wire input. */
  attribution: { namespaceId: string; machineId: string };
}

/**
 * Fixed evaluation order (first match wins): no snapshotId → skip → run not
 * `running` → skip → no manifest row OR the row is not the referenced id →
 * record_error/snapshot_not_committed → namespace → machine → loop → stale
 * generation → bind.
 */
export function planArtifactSnapshotBinding(input: ArtifactBindingInput): ArtifactBindingPlan {
  const { run, loop, manifest, snapshotId, attribution } = input;
  if (snapshotId === undefined) return { kind: "skip" };
  if (run.phase !== "running") return { kind: "skip" };
  if (manifest === null || manifest.id !== snapshotId) {
    return {
      kind: "record_error",
      reason: "snapshot_not_committed",
      runWrites: { artifactSnapshotId: null, artifactSyncError: "snapshot_not_committed" },
    };
  }
  const reject = (reason: Exclude<ArtifactBindingRejection, "snapshot_not_committed">): ArtifactBindingPlan => ({
    kind: "record_error",
    reason,
    runWrites: { artifactSnapshotId: null, artifactSyncError: reason },
  });
  if (manifest.namespaceId !== attribution.namespaceId) return reject("cross_namespace");
  // The four-party machine chain: manifest = run = loop = attribution. The
  // transitive checks are complete — loop.machineId joins the run side, and
  // the existing two comparisons tie manifest to both run and attribution.
  if (
    manifest.machineId !== run.machineId ||
    manifest.machineId !== attribution.machineId ||
    loop.machineId !== run.machineId
  ) {
    return reject("cross_machine");
  }
  if (manifest.loopId !== run.loopId || run.loopId !== loop.id) return reject("cross_loop");
  if (manifest.configRevision !== loop.artifactConfigRevision) return reject("stale_config_generation");
  // Write the VERIFIED manifest id (post-check it equals snapshotId) — the
  // run never carries an id that only the caller asserted (#69) — and carry
  // the observed generation for the apply-time guard (#71).
  return {
    kind: "bind",
    runWrites: { artifactSnapshotId: manifest.id },
    guardConfigRevision: loop.artifactConfigRevision,
  };
}

/** The guarded run write observed zero rows — the run's phase moved, or (for
 *  a bind) the loop's config generation moved, between the caller's resolve
 *  and this write. In Batch 2 the report transaction's own CAS/rollback
 *  driver absorbs this throw; slice-2 callers re-resolve and re-plan (a
 *  generation bump turns the bind into the stable stale_config_generation
 *  rejection). */
export class ArtifactBindingGuardLostError extends Error {
  constructor(readonly runId: string) {
    super(`artifact binding guard lost for run ${runId}`);
    this.name = "ArtifactBindingGuardLostError";
  }
}

/**
 * Persist a binding plan. `skip` writes NOTHING. Otherwise a guarded run
 * UPDATE keyed on the resolved (id, phase) — the runs-table CAS convention
 * (store/report.ts writeRun). A `bind` additionally locks the loop row with
 * FOR UPDATE and re-verifies its CURRENT config generation in the same
 * statement. A concurrent config write either commits before the lock is
 * acquired (the guard then loses) or waits until this statement/transaction
 * commits. A plain scalar read would only see the statement's MVCC snapshot
 * and could admit an overlapping config change (#71). `record_error` carries NO
 * generation guard — every rejection literal is generation-stable (cross_* /
 * snapshot_not_committed are generation-independent; stale_config_generation
 * is monotone), so a config bump can never falsify a recorded rejection.
 * Accepts a Db OR a transaction handle (the runs.ts `tx: Db` precedent):
 * slice-2 tests wrap it in `db.transaction`, Batch 2 embeds it in the report
 * transaction. A zero-row guard throws ArtifactBindingGuardLostError —
 * never a partial write.
 */
export async function applyArtifactBindingPlan(db: Db, run: Run, plan: ArtifactBindingPlan): Promise<void> {
  if (plan.kind === "skip") return;
  const generationGuard =
    plan.kind === "bind"
      ? sql`(${db.select({ generation: loops.artifactConfigRevision }).from(loops).where(eq(loops.id, run.loopId)).for("update")}) = ${plan.guardConfigRevision}`
      : undefined;
  const updated = await db
    .update(runs)
    .set(plan.runWrites)
    .where(and(eq(runs.id, run.id), eq(runs.phase, run.phase), generationGuard))
    .returning({ id: runs.id });
  if (updated.length !== 1) throw new ArtifactBindingGuardLostError(run.id);
}
