/**
 * Store-internal report finalize: THE run terminal write (ADR-001 T3/T5).
 *
 * Two-phase resolve (plan §3, the report/cancel race protocol): the
 * coordinator does a cheap read-side resolve first (unknown/expired → 401
 * without opening a transaction); THIS function is the write transaction —
 * it RE-resolves the lease inside the transaction (a concurrent cancel that
 * committed in between is caught here), re-checks the run's phase, then
 * writes the terminal state and deletes the lease in the same transaction.
 * Any failure anywhere → the whole transaction rolls back.
 *
 * Branch table (everything else is fail-closed 401 + residual-lease cleanup,
 * zero Run/Loop writes):
 *  - active lease + running run        → FINALIZE (done/exec | error/error)
 *  - terminal-grace lease + error run  → RECONCILE, exactly once (T5)
 *
 * The sweep/report race protocol (review: a lost CAS must not strand an
 * UNCONSUMED report): on real multi-connection Postgres a competitor can
 * commit between this transaction's reads and its guarded writes, turning a
 * CAS to 0 rows. The guard loss raises an internal ReportCasLostError, the
 * rolled-back transaction is retried EXACTLY ONCE, and the retry re-runs the
 * whole branch table on fresh state:
 *  - sweep won (terminal-grace lease + error run) → RECONCILE the original
 *    body (T5's promise survives the race);
 *  - cancel / another report won (lease gone)     → coded 401 — correct:
 *    the report WAS consumed (or deliberately intercepted, T6);
 *  - the retry's CAS loses again                  → ReportRaceLostError, a
 *    NON-401 500: the report was not consumed, so the daemon keeps it
 *    pending and retries into the winner's now-stable state.
 * (Single-connection PGlite serializes the window away — the CAS never loses
 * here; the real interleaving proof stays with Phase 6.)
 */
import { and, eq } from "drizzle-orm";

import type { ReportRequest } from "@loopzhb/protocol";

import { ReportRaceLostError, RunCapabilityInvalidError } from "../coordinator/errors.js";
import type { Db } from "../db/index.js";
import { runLeases, runs, type NewRun, type Run } from "../db/schema.js";
import { isActiveLeaseAnomalous, isLeaseDead } from "./leases.js";
import type { Clock } from "../time.js";

export interface ReportStoreDeps {
  db: Db;
  clock: Clock;
  /** Invariant-violation lines (ids + classifications only — NEVER
   *  credentials). Defaults to console.warn in production. */
  log?: (line: string) => void;
}

/** Text caps for daemon-supplied columns (mirror the reference). */
export const MESSAGE_CAP = 2000;
export const SESSION_ID_CAP = 200;

/** Stable failure reason when the daemon supplies none (shared by the normal
 *  finalize AND the reconcile failure branch — it must never keep the sweep's
 *  generic reclaim reason). */
export const GENERIC_RUN_ERROR = "run failed on machine";

export type ReportTxResult = { ok: true } | { ok: true; reconciled: true };

type ReportTxOutcome =
  | { kind: "ok"; result: ReportTxResult }
  | { kind: "denied"; reason: "unknown_or_expired" | "consumed_or_revoked" | "orphaned_run" | "stale_phase" };

/** NUL-strip + cap — every daemon string that enters a text column. */
function cleanText(value: string, cap: number): string {
  return value.replace(/\0/g, "").slice(0, cap);
}

/** A usable failure detail: cleaned, non-empty, not pure whitespace. */
function cleanError(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const cleaned = value.replace(/\0/g, "").trim();
  return cleaned ? cleaned.slice(0, MESSAGE_CAP) : undefined;
}

/**
 * The Phase 1 terminal write-set (A-08) — IDENTICAL for finalize and
 * reconcile (the reconcile just starts from an error row):
 *  - ok → done/exec and the old error is explicitly cleared;
 *  - !ok → error/error with the daemon's usable error or the stable fallback;
 *  - message priority: explicit body.message → run's existing non-empty →
 *    body.finalText fallback → null;
 *  - durationMs/sessionId save-when-present, overwrite-with-null when absent;
 *  - progress always cleared; ts is the injected clock's transition time.
 * Pre-declared fields (cursor, taskFileContent, artifacts, transcript, cost,
 * attempts, daemon-claimed outcome) are NOT here — they never write.
 */
export function buildReportWriteSet(body: ReportRequest, run: Run, nowIso: string): Partial<NewRun> {
  // Priority-select the RAW value first, then clean the FINAL selection
  // uniformly (review #5 — the reused run.message branch must get the same
  // NUL-strip + cap as daemon-supplied text).
  const selectedMessage =
    body.message !== undefined
      ? body.message
      : run.message != null && run.message !== ""
        ? run.message
        : body.finalText !== undefined
          ? body.finalText
          : null;
  return {
    phase: body.ok ? "done" : "error",
    outcome: body.ok ? "exec" : "error",
    error: body.ok ? null : (cleanError(body.error) ?? GENERIC_RUN_ERROR),
    message: selectedMessage === null ? null : cleanText(selectedMessage, MESSAGE_CAP),
    durationMs: body.durationMs ?? null,
    sessionId: body.sessionId !== undefined ? cleanText(body.sessionId, SESSION_ID_CAP) : null,
    progress: null,
    ts: nowIso,
  };
}

/** Internal control-flow signal: a guarded write affected 0 rows — a
 *  competitor committed between this transaction's reads and writes. The
 *  transaction throws it to roll back, and `withReportCasRetry` decides the
 *  bounded re-resolve. Exported ONLY so tests can drive the retry policy
 *  deterministically; nothing outside the report transaction may throw it. */
export class ReportCasLostError extends Error {
  constructor(readonly runId: string) {
    super(`report CAS lost for run ${runId}`);
    this.name = "ReportCasLostError";
  }
}

/**
 * The bounded re-resolve driver (module header's race protocol): run the
 * report transaction; on a lost CAS, retry EXACTLY ONCE so the branch table
 * re-resolves against the winner's committed state. A second loss means the
 * state is still moving — fail closed with ReportRaceLostError (a NON-401
 * 500) so the daemon keeps the unconsumed report pending.
 *
 * Exported for deterministic unit tests: single-connection PGlite can never
 * lose the CAS through the real transaction, so the retry policy is pinned
 * with synthetic functions (the branch table itself is integration-covered
 * via the coordinator's interleaving hooks).
 */
export async function withReportCasRetry(fn: () => Promise<ReportTxResult>): Promise<ReportTxResult> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ReportCasLostError)) throw err;
    try {
      return await fn();
    } catch (retryErr) {
      if (retryErr instanceof ReportCasLostError) throw new ReportRaceLostError(retryErr.runId);
      throw retryErr;
    }
  }
}

/**
 * The report write transaction. `insideTxHook` is a TEST-ONLY fault-injection
 * seam fired between the run update and the lease delete — its throw proves
 * the two writes are one atomic unit (rolls the run update back).
 *
 * Fail-closed cleanups (orphaned / stale-phase) COMMIT their lease delete in
 * the same transaction and surface a `denied` outcome — the 401 error is
 * thrown AFTER commit (throwing inside would roll the cleanup back).
 */
export async function executeReportTx(
  deps: ReportStoreDeps,
  input: {
    tokenHash: string;
    body: ReportRequest;
    insideTxHook?: ((runId: string) => void | Promise<void>) | undefined;
  },
): Promise<ReportTxResult> {
  return withReportCasRetry(() => runReportTx(deps, input));
}

async function runReportTx(
  deps: ReportStoreDeps,
  input: {
    tokenHash: string;
    body: ReportRequest;
    insideTxHook?: ((runId: string) => void | Promise<void>) | undefined;
  },
): Promise<ReportTxResult> {
  const { db, clock } = deps;
  const outcome = await db.transaction(async (tx): Promise<ReportTxOutcome> => {
    // ONE clock snapshot for the whole transaction: the expiry re-check and
    // the transition stamp must agree.
    const now = clock.now();
    // In-transaction re-resolve: a cancel that committed since the read-side
    // resolve shows up HERE (the lease is gone) — never write against it.
    const lease = (await tx.select().from(runLeases).where(eq(runLeases.tokenHash, input.tokenHash)))[0];
    if (!lease) return { kind: "denied", reason: "consumed_or_revoked" };

    // Re-validate deadness INSIDE the transaction against the same clock
    // snapshot (review #4): the read-side resolve happened before this tx —
    // the grace window may have closed (or been corrupted) in between. The
    // SAME fail-closed predicate as the read side (store/leases.ts): a
    // terminal-grace lease with a missing/unparseable window is dead on
    // sight. The cleanup delete commits; the 401 is thrown after.
    if (isLeaseDead(lease, now.getTime())) {
      await tx.delete(runLeases).where(eq(runLeases.tokenHash, input.tokenHash));
      return { kind: "denied", reason: "unknown_or_expired" };
    }

    // An anomalous ACTIVE lease (non-null expiresAt) is NEVER time-killed —
    // it proceeds through the normal active state machine below so the report
    // finalizes the run (self-healing), and the violation is logged WITHOUT
    // any credential material.
    if (isActiveLeaseAnomalous(lease)) {
      (deps.log ?? console.warn)(
        `[lease] invariant violation: active lease with non-null expiresAt run=${lease.runId} expiresAt=${lease.expiresAt} — kept LIVE (never time-killed)`,
      );
    }

    const run = (await tx.select().from(runs).where(eq(runs.id, lease.runId)))[0];
    if (!run) {
      // Orphaned capability (A-14): drop the orphan, no loop writes, 401.
      await tx.delete(runLeases).where(eq(runLeases.tokenHash, input.tokenHash));
      return { kind: "denied", reason: "orphaned_run" };
    }

    const finalize = lease.state === "active" && run.phase === "running";
    const reconcile = lease.state === "terminal-grace" && run.phase === "error";
    if (!finalize && !reconcile) {
      // Stale phase — incl. the Phase 1 "done + active lease" combo that has
      // no legitimate source: drop the residual lease, zero Run/Loop writes.
      await tx.delete(runLeases).where(eq(runLeases.tokenHash, input.tokenHash));
      return { kind: "denied", reason: "stale_phase" };
    }

    // CAS over the whole write window (ADR-001:36 / ADR-003:80 — review #3):
    // the terminal UPDATE re-guards on the phase we validated, and BOTH writes
    // verify their affected row count. On real multi-connection Postgres a
    // competing report/cancel/sweep that committed in between turns a guard
    // to 0 rows → ReportCasLostError → the transaction rolls back and the
    // BOUNDED re-resolve (module header) re-runs the branch table on the
    // winner's committed state. (On single-connection pglite the guards are
    // structural depth; the real contention proof stays with Phase 6.)
    const updated = await tx
      .update(runs)
      .set(buildReportWriteSet(input.body, run, now.toISOString()))
      .where(and(eq(runs.id, run.id), eq(runs.phase, run.phase)))
      .returning({ id: runs.id });
    if (updated.length !== 1) throw new ReportCasLostError(run.id);
    // Fault-injection seam (between the two writes — see the jsdoc above).
    await input.insideTxHook?.(run.id);
    const deleted = await tx
      .delete(runLeases)
      .where(eq(runLeases.tokenHash, input.tokenHash))
      .returning({ tokenHash: runLeases.tokenHash });
    if (deleted.length !== 1) throw new ReportCasLostError(run.id);
    return { kind: "ok", result: reconcile ? { ok: true as const, reconciled: true as const } : { ok: true as const } };
  });
  if (outcome.kind === "denied") throw new RunCapabilityInvalidError(outcome.reason);
  return outcome.result;
}
