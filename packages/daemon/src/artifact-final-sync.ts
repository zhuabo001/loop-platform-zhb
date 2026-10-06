/**
 * Run-final artifact sync (Phase 5 Batch 2 slice 6; ADR-010 决策 11/19/20/24/25).
 *
 * After the runner settles and BEFORE the report body is serialized, every
 * run of an artifact-configured loop forces a final sync of the loop's
 * artifact directory:
 *
 *  - the sync pins the DELIVERY's generation (决策 20): the target is
 *    assembled from `delivery.loop.artifact` — a directory set or moved
 *    during the run never re-binds this run;
 *  - `freshSession: true` mints a new session (决策 11/24): a snapshot id is
 *    produced even when the content is unchanged, so every run carries an
 *    explicit snapshot;
 *  - `reuseCachedHashes: false` (决策 25): the final sync always rehashes
 *    every file — only the watcher's event path may reuse cached hashes;
 *  - the WHOLE attempt — the per-loop queue wait, the scan, the uploads and
 *    the retries — lives under ONE 30 s deadline (批次计划 §1), composed as
 *    an AbortSignal so the existing cancellation points (queue wait, fetch,
 *    scan boundaries) do the cancel; the deadline watcher RECORDS its own
 *    expiry (a normal completion disarms it) and that record — never the
 *    settled outcome — decides the classification (#106): the abort races the
 *    client's own late failure classification, so a scan that hangs past the
 *    deadline and then fails still freezes `"timeout"`, and the report still
 *    carries the run's own outcome;
 *  - the two report fields stay MUTUALLY EXCLUSIVE at the source: a synced
 *    outcome carries `artifactSnapshotId`, every other outcome maps to a
 *    stable `artifactSyncError` literal (the U2 table below).
 *
 * When the deadline expires the loop additionally gets ONE bounded
 * `reportLocalFailure` (`failure: "timeout"` — the taxonomy value reserved
 * for this path), whichever non-synced outcome the attempt settled as, so the
 * loop-level sync state reflects the stall; the report budget is independent
 * of the 30 s deadline, and an over-budget or failed report NEVER changes
 * the frozen report fields.
 *
 * Time is injectable (`sleep`) — tests drive the deadline deterministically,
 * no fake timers. This module NEVER throws: an internal program error is
 * logged and frozen as `"internal_error"` (a run-report field only — not a
 * taxonomy value, never reported to the loop endpoint).
 */
import type { ArtifactWatchItem, Delivery } from "@loopzhb/protocol";

import {
  defaultArtifactSyncSleep,
  type ArtifactSyncClient,
  type ArtifactSyncOutcome,
  type ArtifactSyncSleepFn,
} from "./artifact-sync.js";

/** The total Run-final sync budget (批次计划 §1: 排队、扫描、上传和重试). */
export const FINAL_SYNC_DEADLINE_MS = 30_000;
/** The independent budget for the U1 timeout reportLocalFailure — AFTER the
 *  deadline, so the report path can never stretch the sync itself. */
export const FINAL_SYNC_TIMEOUT_REPORT_BUDGET_MS = 10_000;

/** The artifact fields a final sync contributes to the run's report body.
 *  At most one key is present. */
export interface FinalArtifactReportFields {
  artifactSnapshotId?: string;
  artifactSyncError?: string;
}

/** The runtime's narrow view (runtime.ts imports this TYPE only — the same
 *  zero-cycle seam as the slice-5 watch controller). */
export interface FinalArtifactSync {
  /** Run the final sync for this delivery and return the report fields.
   *  NEVER rejects; a shutdown signal returns {} fast (the report will not
   *  be sent anyway). */
  run(delivery: Delivery, signal: AbortSignal): Promise<FinalArtifactReportFields>;
}

export interface FinalArtifactSyncDeps {
  /** The daemon's ONE sync client (cli.ts shares the instance with the watch
   *  manager, so the per-loop serial queue and the global upload gate are
   *  structurally shared — a queued final sync's wait counts into the 30 s). */
  sync: ArtifactSyncClient;
  /** The daemon's already-canonical allowed roots (the jail intersection). */
  daemonRoots: readonly string[];
  sleep?: ArtifactSyncSleepFn;
  /** TEST-ONLY overrides; the production values are the exported constants. */
  deadlineMs?: number;
  timeoutReportMs?: number;
  log?: (line: string) => void;
}

/** The U2 mapping table: every non-synced outcome → the stable literal the
 *  report carries. `failed` maps to the scan taxonomy value itself; the rest
 *  are fixed strings (the report column is deliberately free-form). Consulted
 *  ONLY when the deadline did not expire — an expired attempt freezes
 *  `"timeout"` whatever it settled as (#106). */
function outcomeToError(outcome: ArtifactSyncOutcome): string | undefined {
  switch (outcome.kind) {
    case "synced":
      return undefined;
    case "failed":
      return outcome.failure;
    case "terminal":
      return outcome.code ?? "terminal";
    case "unavailable":
      return "unavailable";
    case "config_changed":
      return "config_changed";
    case "stopped":
      return "stopped";
    case "cancelled":
      // Defensive: with no observed expiry and no caller abort there is no
      // cancel source left (the deadline branch owns the real cancellation).
      return "timeout";
    case "unchanged":
      // Unreachable with freshSession (suppression is bypassed) — defensive:
      // never invent a snapshot id.
      return undefined;
  }
}

export function createFinalArtifactSync(deps: FinalArtifactSyncDeps): FinalArtifactSync {
  const sleep = deps.sleep ?? defaultArtifactSyncSleep;
  const deadlineMs = deps.deadlineMs ?? FINAL_SYNC_DEADLINE_MS;
  const timeoutReportMs = deps.timeoutReportMs ?? FINAL_SYNC_TIMEOUT_REPORT_BUDGET_MS;
  const log = deps.log ?? (() => {});

  return {
    async run(delivery, signal) {
      // Shutdown fast path: a daemon that is stopping does not pay the
      // deadline for a report that will never be sent.
      if (signal.aborted) return {};
      const artifact = delivery.loop.artifact;
      if (artifact === undefined) return {}; // unconfigured loop — Phase 4 behavior
      const runId = delivery.runId;
      try {
        const target: ArtifactWatchItem = {
          loopId: delivery.loop.id,
          artifactDir: artifact.dir,
          workdir: delivery.loop.workdir,
          roots: delivery.roots,
          configRevision: artifact.configRevision,
        };
        const deadlineCtl = new AbortController();
        const deadlineWatchDone = new AbortController();
        // The deadline watcher: resolves on schedule OR on cancellation (the
        // caller's shutdown, or `deadlineWatchDone` after the sync settled).
        // ONLY a scheduled expiry — caller alive, sync still in flight — flips
        // `deadlineFired` and cancels the sync: a normal completion must never
        // be misread as an expiry, and the flag is recorded HERE rather than
        // inferred from the settled outcome (#106) — the abort races the
        // client's own late failure classification.
        let deadlineFired = false;
        const deadlineWatch = (async () => {
          await sleep(deadlineMs, AbortSignal.any([signal, deadlineWatchDone.signal]));
          if (deadlineWatchDone.signal.aborted || signal.aborted) return;
          deadlineFired = true;
          deadlineCtl.abort();
        })();
        let outcome: ArtifactSyncOutcome;
        try {
          outcome = await deps.sync.syncLoop({
            target,
            daemonRoots: deps.daemonRoots,
            signal: AbortSignal.any([signal, deadlineCtl.signal]),
            freshSession: true,
            reuseCachedHashes: false,
          });
        } finally {
          // ONE cleanup for every settle, a throw included: disarming the
          // watcher here is what keeps a normal completion from looking like
          // an expiry, and it never leaves the timer armed (#106/P3).
          deadlineWatchDone.abort();
          await deadlineWatch;
        }

        if (signal.aborted) return {}; // shutting down — the report stays unsent
        if (outcome.kind === "synced") {
          // A commit that genuinely raced the deadline still produced a legal
          // snapshot — bind it (the server validates the reference).
          return { artifactSnapshotId: outcome.artifactSnapshotId };
        }
        if (!deadlineFired) {
          // The attempt settled on its own inside the budget: the outcome's
          // own classification is the report field (U2).
          if (outcome.kind === "unchanged") {
            log(`run ${runId}: final sync returned unchanged under freshSession — no snapshot minted`);
            return {};
          }
          return { artifactSyncError: outcomeToError(outcome) ?? "internal_error" };
        }
        // The deadline ITSELF expired. Whatever the sync settled as — its own
        // late failure classification, a queued cancellation — the attempt blew
        // its budget, so the stable "timeout" is frozen (#106) and the loop
        // gets ONE bounded local-failure report (U1). The report's budget is
        // its own; its result never changes the frozen fields.
        if (outcome.kind === "unchanged") {
          log(`run ${runId}: final sync settled unchanged after the ${deadlineMs}ms deadline — freezing timeout`);
        }
        const budgetCtl = new AbortController();
        const budgetWatchDone = new AbortController();
        const budgetWatch = (async () => {
          await sleep(timeoutReportMs, AbortSignal.any([signal, budgetWatchDone.signal]));
          budgetCtl.abort();
        })();
        let reported: ArtifactSyncOutcome | undefined;
        try {
          reported = await deps.sync
            .reportLocalFailure({
              target,
              failure: "timeout",
              detail: `the run-final sync exceeded the ${deadlineMs}ms deadline`,
              signal: AbortSignal.any([signal, budgetCtl.signal]),
            })
            .catch((err: unknown) => {
              log(`run ${runId}: timeout reportLocalFailure threw: ${err instanceof Error ? err.message : String(err)}`);
              return undefined;
            });
        } finally {
          budgetWatchDone.abort();
          await budgetWatch;
        }
        if (signal.aborted) return {};
        if (reported !== undefined) {
          const state = reported.kind === "failed" ? reported.reported : reported.kind;
          log(`run ${runId}: final sync exceeded the ${deadlineMs}ms deadline — loop-level timeout report: ${state}`);
        }
        return { artifactSyncError: "timeout" };
      } catch (err) {
        log(`run ${runId}: final sync failed internally: ${err instanceof Error ? err.message : String(err)}`);
        if (signal.aborted) return {};
        return { artifactSyncError: "internal_error" };
      }
    },
  };
}
