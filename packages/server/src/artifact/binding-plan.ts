/**
 * Artifact snapshot binding — the pure validation/write-plan and its guarded
 * persistence (ADR-010 决策 12, plan §3 "Run 快照边界"; Phase 5 Batch 1
 * slice 2).
 *
 * A run's final report may reference an artifact snapshot (the immutable
 * manifest id minted at commit) OR carry the daemon's stable sync-error
 * classification — never both (the daemon keeps the two fields mutually
 * exclusive; both present is an ambiguous report). Binding is VALIDATED,
 * never trusted: the manifest row must exist (committed), its id must BE the
 * referenced snapshot id (#69), and its namespace / machine / loop / config
 * generation must match the run and the loop's CURRENT generation.
 * An illegal reference is recorded as the run's `artifactSyncError` and
 * NEVER changes the run's own outcome — artifact sync failure is not run
 * failure. Canceled, superseded or reclaimed runs that never produced a
 * legal final report do NOT bind: eligibility is confirmed by the report
 * transaction (finalize / terminal-grace reconcile) and passed in EXPLICITLY
 * (ADR-010 决策 19 末段) — the planner never re-derives it from run.phase.
 *
 * Batch 1 slice 2 delivered the plan and its persistence ONLY; Batch 2
 * slice 6 calls `planArtifactSnapshotBinding` inside `runReportTx` and lets
 * that transaction's CAS/rollback driver absorb the guard-lost throw.
 */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { loops, runs, type ArtifactManifestRow, type Loop, type Run } from "../db/schema.js";
import type { ArtifactAttribution } from "./attribution.js";

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
  | "stale_config_generation"
  /** The report carried BOTH artifactSnapshotId and artifactSyncError — an
   *  ambiguous report (the daemon keeps them mutually exclusive). The
   *  snapshot is NOT bound; the legal run outcome still commits. */
  | "ambiguous_artifact_report"
  /** Trusted attribution could not be resolved for the run's machine —
   *  fail-closed (unreachable for a claimed machine, never assumed). */
  | "attribution_missing";

export type ArtifactBindingPlan =
  /** Nothing to write (the report carries neither artifact field). */
  | { kind: "skip" }
  /** Bind the verified manifest id; touches ONLY the artifact column.
   *  `guardConfigRevision` is the loop's config generation observed at plan
   *  time — apply locks and re-verifies the LIVE loop row in the same UPDATE
   *  statement, so a concurrent config write cannot pass the guard (#71). */
  | { kind: "bind"; runWrites: { artifactSnapshotId: string }; guardConfigRevision: number }
  /** Record the stable rejection; NEVER changes the run's outcome. `reason`
   *  is an ArtifactBindingRejection literal OR — for a sync-error-only
   *  report — the daemon's own stable classification carried verbatim. */
  | { kind: "record_error"; reason: string; runWrites: { artifactSnapshotId: null; artifactSyncError: string } };

export interface ArtifactBindingInput {
  run: Run;
  /** The run's loop — only the fields the checks need. */
  loop: Pick<Loop, "id" | "machineId" | "artifactConfigRevision">;
  /** The committed manifest row for `snapshotId`, or null (the caller looked
   *  it up and found nothing). NOT read at all for an ambiguous report or a
   *  sync-error-only report — the caller skips the lookup (existence never
   *  leaks before validation). */
  manifest: ArtifactManifestRow | null;
  /** The report-carried snapshot reference; undefined = the report carries
   *  none. */
  snapshotId: string | undefined;
  /** The RAW report-carried sync-error field. Its PRESENCE decides ambiguity
   *  and the record path: an empty, whitespace-only or NUL-only string is
   *  still a CARRIED field (#105) — text cleaning is a STORAGE policy, never
   *  a presence test. undefined = the report carries no error field. */
  syncError: string | undefined;
  /** The storage text for `syncError`, normalized by the caller (NUL-stripped,
   *  trimmed, capped); undefined when the raw value carries no usable text.
   *  Only the error-only arm consults it: a value that normalizes to nothing
   *  records NOTHING (skip) — never an invented literal. */
  syncErrorText: string | undefined;
  /** The binding eligibility the report transaction EXPLICITLY confirmed
   *  (ADR-010 决策 19 末段): "finalize" = active lease + running run;
   *  "reconcile" = the ONE terminal-grace wake-report for a swept run. Both
   *  are bindable; canceled/superseded/reclaimed-without-report runs never
   *  reach the planner. The value is part of the contract — the planner
   *  trusts it and never re-derives eligibility from run.phase. */
  eligibility: "finalize" | "reconcile";
  /** The trusted attribution the CALLER resolved via the frozen resolver
   *  (artifact/attribution.ts) for the run's machine — never wire input. */
  attribution: ArtifactAttribution;
}

/**
 * Fixed evaluation order (first match wins): neither field CARRIED → skip →
 * BOTH fields carried → record_error/ambiguous_artifact_report (short-circuit,
 * no manifest read) → syncError only → record_error with the daemon's
 * classification verbatim (skip when the raw value normalizes to nothing) →
 * attribution missing → record_error/attribution_missing → no manifest row OR
 * the row is not the referenced id → record_error/snapshot_not_committed →
 * namespace → machine → loop → stale generation → bind.
 *
 * Presence is judged on the RAW wire fields, never on the cleaned text: a
 * report carrying a snapshot id plus an empty/whitespace/NUL-only error is
 * AMBIGUOUS (#105) — cleaning only decides what TEXT an error-only report
 * records.
 */
export function planArtifactSnapshotBinding(input: ArtifactBindingInput): ArtifactBindingPlan {
  const { run, loop, manifest, snapshotId, syncError, syncErrorText, attribution } = input;
  if (snapshotId === undefined && syncError === undefined) return { kind: "skip" };
  if (snapshotId !== undefined && syncError !== undefined) {
    return {
      kind: "record_error",
      reason: "ambiguous_artifact_report",
      runWrites: { artifactSnapshotId: null, artifactSyncError: "ambiguous_artifact_report" },
    };
  }
  if (syncError !== undefined) {
    // The field was CARRIED (raw presence above); only its stored text follows
    // the text policy. No usable text ⇒ no classification to record: write
    // nothing rather than invent a literal (the run outcome is unaffected
    // either way).
    if (syncErrorText === undefined) return { kind: "skip" };
    return {
      kind: "record_error",
      reason: syncErrorText,
      runWrites: { artifactSnapshotId: null, artifactSyncError: syncErrorText },
    };
  }
  if (!attribution.ok) {
    return {
      kind: "record_error",
      reason: "attribution_missing",
      runWrites: { artifactSnapshotId: null, artifactSyncError: "attribution_missing" },
    };
  }
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
