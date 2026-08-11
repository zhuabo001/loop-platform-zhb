/**
 * The owner-control DEEP MODULE (Day 8–10 plan §2): the local owner's run
 * surface behind `/api/runs/:id/cancel`. It consumes the STORE-level
 * `cancelRunTx` directly — the RunCoordinator's three-method interface stays
 * exactly `enqueueExecRun / poll / report` (A-02), and the HTTP route never
 * touches the lease state machine.
 *
 * `cancelRunTx` answers only "did it transition" (false covers BOTH a missing
 * run and an already-terminal one); the HTTP contract splits those into
 * 404 vs the idempotent 200 `not_cancelable`, so on a non-transition ONE run
 * read classifies the outcome. The classify-after-the-tx race (the run
 * reaches a terminal phase between the two) is benign in Phase 1's single
 * process: the cancel had no effect either way, and a retry reports the same
 * not_cancelable.
 */
import type { Db } from "../db/index.js";
import { cancelRunTx, getRun } from "../store/runs.js";
import type { Clock } from "../time.js";

export interface OwnerControlDeps {
  db: Db;
  clock: Clock;
}

export type CancelRunResult =
  | { canceled: true }
  | { canceled: false; reason: "not_cancelable" }
  | { canceled: false; reason: "not_found" };

export function createOwnerControl(deps: OwnerControlDeps) {
  return {
    /** Cancel a pending/running run: run → `canceled` and the lease DELETE
     *  land in ONE transaction (ADR-001's cancel rule — a late report always
     *  meets the unified 401). Writes phase + ts ONLY: no outcome/message/
     *  error, no loop-state advance, no notification (plan §3). */
    async cancelRun(runId: string): Promise<CancelRunResult> {
      const transitioned = await cancelRunTx(deps, runId);
      if (transitioned) return { canceled: true };
      const run = await getRun(deps.db, runId);
      return run === undefined
        ? { canceled: false as const, reason: "not_found" as const }
        : { canceled: false as const, reason: "not_cancelable" as const };
    },
  };
}

export type OwnerControl = ReturnType<typeof createOwnerControl>;
