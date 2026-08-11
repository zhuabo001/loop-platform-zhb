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
 *  2. LEASE PRUNE: terminal-grace leases past their window (`now >=
 *     expiresAt` — a lease dies AT its expiresAt, the boundary pinned with
 *     store/leases.ts) are deleted; a terminal-grace lease with a MISSING or
 *     UNPARSEABLE expiresAt is deleted on sight (fail closed — it must never
 *     linger as a reusable credential). ACTIVE leases are never time-pruned:
 *     only report, cancel or reclaim may retire them.
 *
 * Pass discipline: ONE clock snapshot per pass; a candidate that loses its
 * race (left `running` between scan and reclaim) is benign — neither
 * reclaimed nor failed; a candidate that THROWS (the conjunctive-guard
 * invariant) increments `failed`, is logged WITHOUT credentials, and never
 * blocks the rest of the batch. Overlapping runOnce() calls coalesce into the
 * single in-flight pass — a slow pass never stacks a second concurrent scan.
 *
 * All lifecycle timestamps read the injected Clock; thresholds arrive by
 * constructor injection (NO new env vars in this batch — plan §1).
 */
import { and, asc, eq, gt } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { runLeases, runs, type RunProgressRow } from "../db/schema.js";
import {
  classifyHeartbeatWatermark,
  getMachine,
  heartbeatAgeMs,
  isHeartbeatWatermarkAnomalous,
} from "../store/machines.js";
import { reclaimStaleRunTx } from "../store/runs.js";
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
  expiresAt: runLeases.expiresAt,
} as const;

/**
 * The run's last-activity evidence, in epoch ms — `max(run.ts, progress.at)`
 * restricted to VALID stamps: unparseable values are skipped, and stamps
 * further than the shared skew slack into the future are pollution (the SAME
 * predicate the machine-watermark consumers use — "anomalous" can never drift
 * between surfaces). `null` = no evidence at all; the caller fails CLOSED.
 */
export function lastRunActivityMs(
  run: { ts: string; progress: RunProgressRow | null },
  nowMs: number,
): number | null {
  let best: number | null = null;
  for (const raw of [run.ts, run.progress?.at] as const) {
    if (raw == null) continue;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) continue;
    if (isHeartbeatWatermarkAnomalous(ms, nowMs)) continue;
    best = best === null ? ms : Math.max(best, ms);
  }
  return best;
}

export function createInactivitySweep(deps: InactivitySweepDeps): InactivitySweep {
  const runInactivityMs = deps.runInactivityMs ?? DEFAULT_RUN_INACTIVITY_MS;
  const pageSize = deps.pageSize ?? DEFAULT_SWEEP_PAGE_SIZE;
  const log = deps.log ?? ((line: string) => console.warn(line));

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
    // daemon kept polling) — it never changes the decision.
    const machine = await getMachine(deps.db, run.machineId);
    const heartbeatClass = classifyHeartbeatWatermark(machine?.lastSeen ?? null, nowMs);
    const heartbeatAge = heartbeatAgeMs(machine?.lastSeen ?? null, nowMs);
    const diagnostic = `machineHeartbeat=${heartbeatClass}${heartbeatAge === null ? "" : ` ageMs=${heartbeatAge}`}`;

    try {
      const reclaimed = await reclaimStaleRunTx({ db: deps.db, clock: deps.clock }, run.id);
      if (!reclaimed) return; // left `running` between scan and reclaim — benign race
      stats.reclaimed += 1;
      log(
        `[sweep] reclaim run=${run.id} loop=${run.loopId} machine=${run.machineId}` +
          ` inactiveMs=${activityMs === null ? "unknown" : nowMs - activityMs} ${diagnostic}`,
      );
    } catch (err) {
      // A conjunctive-guard violation (running WITHOUT an active lease) rolls
      // its own transaction back — count it, log it, keep sweeping.
      stats.failed += 1;
      log(`[sweep] reclaim FAILED run=${run.id}: ${err instanceof Error ? err.message : String(err)}`);
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
        const expiryMs = lease.expiresAt === null ? null : Date.parse(lease.expiresAt);
        // Fail closed: missing/unparseable windows and `now >= expiresAt` are
        // all dead. The keyset cursor advances past deleted rows safely.
        if (expiryMs !== null && !Number.isNaN(expiryMs) && nowMs < expiryMs) continue;
        await deps.db.delete(runLeases).where(eq(runLeases.tokenHash, lease.tokenHash));
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
  stop(): void;
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
  const tick = (): void => {
    void sweep
      .runOnce()
      .catch((err: unknown) => onError(`[sweep] pass failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
