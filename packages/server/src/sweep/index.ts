/**
 * The inactivity sweep (Day 8–10 plan §1) — the vanished-machine guard and
 * the terminal-grace janitor. ONE deep module owns both passes:
 *
 *  1. RUN RECLAIM: scan `running` runs in keyset-bounded pages over an
 *     explicit column projection; a run whose last activity reaches the
 *     inactivity timeout is handed to the store's `reclaimStaleRunTx` — the
 *     ONLY terminal-grace producer (ADR-001 T5). Last activity is
 *     `max(run.ts, progress.at)` over VALID stamps only: garbage parses to no
 *     evidence, near-future skew (≤ HEARTBEAT_SKEW_SLACK_MS) reads as fresh,
 *     and far-future pollution is anomalous on sight — it must never grant a
 *     run immortality (fail closed: NO valid evidence ⇒ reclaim). The machine
 *     heartbeat watermark is classified via the shared
 *     `classifyHeartbeatWatermark`/`heartbeatAgeMs` pair for the reclaim LOG
 *     LINE ONLY — a fresh machine NEVER vetoes reclaiming its own timed-out
 *     run (ADR-001: a lost Delivery response must converge to an observable
 *     error even while the daemon keeps polling).
 *  2. LEASE PRUNE: dead terminal-grace leases are deleted, where "dead" is
 *     THE shared `isLeaseDead` predicate (store/leases.ts — the SAME rule the
 *     read-side resolve and the report transaction's re-check use: past
 *     window, or a missing/unparseable one, fail closed). Only ACTUAL
 *     deletions count toward `pruned`. ACTIVE leases are never time-pruned:
 *     only report, cancel or reclaim may retire them.
 *
 * Pass discipline: ONE clock snapshot per pass; a candidate that loses its
 * race (left `running` between scan and reclaim, or proved FRESH activity to
 * the reclaim transaction's in-tx re-validation) is benign — neither
 * reclaimed nor failed; a candidate that THROWS (the conjunctive-guard
 * invariant) increments `failed`, is logged WITHOUT credentials, and never
 * blocks the rest of the batch. The machine-heartbeat DIAGNOSTIC read is
 * fail-open under the same isolation: a throwing read marks the log line
 * `machineHeartbeat=unavailable` and the reclaim proceeds. Overlapping
 * runOnce() calls coalesce into the single in-flight pass — a slow pass
 * never stacks a second concurrent scan.
 *
 * All lifecycle timestamps read the injected Clock; thresholds arrive by
 * constructor injection (NO new env vars in this batch — plan §1).
 */
import { and, asc, eq, gt } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { runLeases, runs, type RunProgressRow } from "../db/schema.js";
import { isLeaseDead } from "../store/leases.js";
import { classifyHeartbeatWatermark, getMachine, heartbeatAgeMs } from "../store/machines.js";
import { lastRunActivityMs, reclaimStaleRunTx, ReclaimGuardLostError } from "../store/runs.js";
import type { Clock } from "../time.js";

/** Production thresholds (plan §1): a run silent for 20 minutes is stale;
 *  the sweep wakes every 30 seconds. */
export const DEFAULT_RUN_INACTIVITY_MS = 20 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
export const DEFAULT_SWEEP_PAGE_SIZE = 100;

export interface SweepStats {
  /** `running` candidates examined this pass. */
  scanned: number;
  /** Runs handed to reclaimStaleRunTx that actually transitioned. */
  reclaimed: number;
  /** Dead terminal-grace leases deleted this pass. */
  pruned: number;
  /** Candidates whose reclaim THREW (invariant violations) — never blocks the batch. */
  failed: number;
}

export interface InactivitySweep {
  runOnce(): Promise<SweepStats>;
}

export interface InactivitySweepDeps {
  db: Db;
  clock: Clock;
  runInactivityMs?: number;
  pageSize?: number;
  /** Receives safe log lines (ids + classifications only — NEVER credentials). */
  log?: (line: string) => void;
  /** TEST-ONLY seam: override the diagnostic machine read (fault injection —
   *  proves a throwing diagnostic never aborts the pass). Production never
   *  sets this; the real read is store/machines.getMachine. */
  readMachineForDiagnostic?: (db: Db, machineId: string) => Promise<{ lastSeen: string | null } | undefined>;
}

/** Explicit candidate projection (plan §1): exactly the columns the decision
 *  reads — large terminal payloads never enter the sweep's memory. */
const runCandidateColumns = {
  id: runs.id,
  loopId: runs.loopId,
  machineId: runs.machineId,
  ts: runs.ts,
  progress: runs.progress,
} as const;

const terminalGraceColumns = {
  tokenHash: runLeases.tokenHash,
  runId: runLeases.runId,
  state: runLeases.state,
  expiresAt: runLeases.expiresAt,
} as const;

/**
 * Classify a reclaim failure for logging (Issue #10, Batch 4). Returns ONLY a
 * fixed classification string — never the error message, stack, or any
 * database text that might contain credentials.
 */
function classifyReclaimError(err: unknown): string {
  if (err instanceof ReclaimGuardLostError) {
    return "reclaim_guard_lost";
  }
  return "reclaim_failed";
}

export function createInactivitySweep(deps: InactivitySweepDeps): InactivitySweep {
  const runInactivityMs = deps.runInactivityMs ?? DEFAULT_RUN_INACTIVITY_MS;
  const pageSize = deps.pageSize ?? DEFAULT_SWEEP_PAGE_SIZE;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const readMachine = deps.readMachineForDiagnostic ?? getMachine;

  async function considerCandidate(
    run: { id: string; loopId: string; machineId: string; ts: string; progress: RunProgressRow | null },
    nowMs: number,
    stats: SweepStats,
  ): Promise<void> {
    const activityMs = lastRunActivityMs(run, nowMs);
    // A within-slack future stamp yields a negative age → fresh → kept.
    if (activityMs !== null && nowMs - activityMs < runInactivityMs) return;

    // Diagnostic ONLY (plan §1): the machine's watermark explains WHY the run
    // may have been orphaned (machine vanished vs delivery lost while the
    // daemon kept polling) — it never changes the decision. Fail-OPEN under
    // candidate-level isolation (review): a throwing diagnostic read must
    // neither abort the whole pass nor count as the candidate's reclaim
    // failure — the reclaim proceeds with the diagnostic hole marked
    // `unavailable`.
    let diagnostic: string;
    try {
      const machine = await readMachine(deps.db, run.machineId);
      const heartbeatClass = classifyHeartbeatWatermark(machine?.lastSeen ?? null, nowMs);
      const heartbeatAge = heartbeatAgeMs(machine?.lastSeen ?? null, nowMs);
      diagnostic = `machineHeartbeat=${heartbeatClass}${heartbeatAge === null ? "" : ` ageMs=${heartbeatAge}`}`;
    } catch {
      // Driver errors and injected values can contain connection details or
      // newlines. This diagnostic channel promises IDs + classifications only.
      diagnostic = "machineHeartbeat=unavailable";
    }

    try {
      // The scan's staleness decision is a HINT: reclaimStaleRunTx
      // re-validates the activity watermark INSIDE its transaction (review:
      // scan/reclaim TOCTOU) — a Phase 2 progress heartbeat that landed in
      // between turns this into a benign "activity_fresh" skip.
      const outcome = await reclaimStaleRunTx({ db: deps.db, clock: deps.clock }, { runId: run.id, runInactivityMs });
      if (outcome !== "reclaimed") return; // left `running` / fresh activity — benign race
      stats.reclaimed += 1;
      log(
        `[sweep] reclaim run=${run.id} loop=${run.loopId} machine=${run.machineId}` +
          ` inactiveMs=${activityMs === null ? "unknown" : nowMs - activityMs} ${diagnostic}`,
      );
    } catch (err) {
      // A conjunctive-guard violation (running WITHOUT an active lease) rolls
      // its own transaction back — count it, log it (with fixed classification
      // ONLY — never the error message or database text), keep sweeping.
      stats.failed += 1;
      const classification = classifyReclaimError(err);
      log(`[sweep] reclaim FAILED run=${run.id} classification=${classification}`);
    }
  }

  async function pruneTerminalGraceLeases(nowMs: number, stats: SweepStats): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const page = await deps.db
        .select(terminalGraceColumns)
        .from(runLeases)
        .where(and(eq(runLeases.state, "terminal-grace"), after === null ? undefined : gt(runLeases.tokenHash, after)))
        .orderBy(asc(runLeases.tokenHash))
        .limit(pageSize);
      if (page.length === 0) return;
      for (const lease of page) {
        // THE shared deadness predicate (review: no third copy of the rule —
        // read-side resolve, the report transaction's re-check and this prune
        // MUST agree on "dead"). The keyset cursor advances past deleted
        // rows safely.
        if (!isLeaseDead(lease, nowMs)) continue;
        // Count only ACTUAL deletions (review): on multi-connection Postgres
        // a concurrent report may consume the lease between the page read
        // and this delete — a 0-row delete must not inflate `pruned`.
        const deleted = await deps.db
          .delete(runLeases)
          .where(eq(runLeases.tokenHash, lease.tokenHash))
          .returning({ tokenHash: runLeases.tokenHash });
        if (deleted.length === 0) continue;
        stats.pruned += 1;
        log(`[sweep] prune terminal-grace lease run=${lease.runId}`);
      }
      after = page[page.length - 1]!.tokenHash;
      if (page.length < pageSize) return;
    }
  }

  async function execute(): Promise<SweepStats> {
    const stats: SweepStats = { scanned: 0, reclaimed: 0, pruned: 0, failed: 0 };
    const nowMs = deps.clock.now().getTime(); // ONE snapshot for the whole pass

    let afterId: string | null = null;
    for (;;) {
      const page = await deps.db
        .select(runCandidateColumns)
        .from(runs)
        .where(and(eq(runs.phase, "running"), afterId === null ? undefined : gt(runs.id, afterId)))
        .orderBy(asc(runs.id))
        .limit(pageSize);
      if (page.length === 0) break;
      for (const run of page) {
        stats.scanned += 1;
        await considerCandidate(run, nowMs, stats);
      }
      afterId = page[page.length - 1]!.id;
      if (page.length < pageSize) break;
    }

    await pruneTerminalGraceLeases(nowMs, stats);
    return stats;
  }

  let inFlight: Promise<SweepStats> | null = null;
  return {
    runOnce(): Promise<SweepStats> {
      // Overlapping passes coalesce into the in-flight one (plan §1) — the
      // interval tick that fires while a slow pass is still running must not
      // stack a second scan on top of it.
      inFlight ??= execute().then(
        (stats) => {
          inFlight = null;
          return stats;
        },
        (err: unknown) => {
          inFlight = null;
          throw err;
        },
      );
      return inFlight;
    },
  };
}

export interface SweepTimer {
  /** Block new ticks and wait for the in-flight pass (if any) to settle —
   *  shutdown drains BEFORE closing HTTP/DB (review): a slow pass must never
   *  outlive the database it transacts on. */
  stopAndDrain(): Promise<void>;
}

/**
 * The production timer wiring (plan §1): exactly ONE immediate async pass the
 * moment the HTTP listener is bound, then an `unref()`'d interval — the timer
 * never holds the process open. A throwing pass is logged and the NEXT tick
 * still fires (the sweep has no HTTP trigger; the interval is its only driver).
 */
export function armInactivitySweep(
  sweep: InactivitySweep,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
  onError: (line: string) => void = (line) => console.error(line),
): SweepTimer {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = (): void => {
    if (stopped) return; // a queued tick firing mid-drain must not start a new pass
    inFlight = sweep.runOnce().then(
      () => undefined,
      () => {
        // Logging must never turn a handled sweep failure into an unhandled
        // rejection that prevents shutdown from draining.
        try {
          onError("[sweep] pass failed classification=sweep_pass_failed");
        } catch {
          // Preserve the timer and ordered shutdown guarantees even when an
          // injected logger fails.
        }
      },
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    // tick() catches its own errors, so this await never rejects. The drain
    // has no timeout of its own: a wedged pass means wedged DB queries, and
    // closeDb would hang on them anyway.
    stopAndDrain: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
