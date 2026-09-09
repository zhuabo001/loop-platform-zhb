/**
 * Loop lifecycle DB ADAPTERS (Phase 4 Batch 2) — the transaction-side wiring
 * of the pure kernel in `./index.ts` (ADR-009 决策 8's planned接线, 修订
 * 2026-09-01 决策 5/6). The kernel decides WHAT to write; these functions own
 * the transaction, the pre-transaction resolve, the guarded write and the
 * bounded re-resolve on a lost guard. No HTTP mapping here — the route layer
 * maps the closed result unions to status codes.
 *
 * Guard discipline (review SPEC-1/SPEC-3, ADR-009 修订 2026-09-01): every op
 * RESOLVES the loop row before opening the write transaction (the kernel
 * plans from THAT snapshot), then lands a conditional UPDATE keyed on the
 * snapshot's `revision` — the unified monotonic OCC token every loops write
 * increments. A zero-row guard means a competitor committed between resolve
 * and write: roll back, re-resolve ONCE, and if the guard loses again fail
 * closed (never a partial commit, never a stale-snapshot overwrite). The
 * millisecond `updatedAt` could not serve here — a same-timestamp competitor
 * leaves it unchanged, and a stale write would pass the guard.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { loops, runLeases, runs, type Loop } from "../db/schema.js";
import { withGuardRetry } from "../store/guard-retry.js";
import type { Clock } from "../time.js";
import {
  planGoalUpdate,
  planReopen,
  type GoalUpdateRejection,
} from "./index.js";

export interface LifecycleOpsDeps {
  db: Db;
  clock: Clock;
  hooks?: LifecycleOpsHooks;
}

/** TEST-ONLY seams (CoordinatorHooks precedent). Single-connection PGlite
 *  cannot interleave a competitor INSIDE a transaction, so the deterministic
 *  race window lives between the pre-transaction resolve and the guarded
 *  write — a hook here commits a REAL competing transaction. */
export interface LifecycleOpsHooks {
  afterResolve?(loopId: string, surface: "goal" | "taskFile" | "reopen"): void | Promise<void>;
}

/** A guarded write observed zero rows — a competitor committed between the
 *  resolve and the write. Rolls the transaction back; the caller re-resolves
 *  once. */
class LifecycleGuardLostError extends Error {
  constructor(readonly loopId: string) {
    super(`lifecycle guard lost for loop ${loopId}`);
    this.name = "LifecycleGuardLostError";
  }
}

/** The guard lost AGAIN on the single bounded re-resolve — the row is still
 *  moving. Surfaces as a retryable 500; no partial state was ever committed. */
export class LifecycleRaceLostError extends Error {
  constructor(readonly loopId: string) {
    super(`lifecycle guard did not settle for loop ${loopId}`);
    this.name = "LifecycleRaceLostError";
  }
}

/** Run `fn` through the shared bounded re-resolve (store/guard-retry.ts). */
async function withLifecycleRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withGuardRetry(
    fn,
    (err) => err instanceof LifecycleGuardLostError,
    (err) => new LifecycleRaceLostError((err as LifecycleGuardLostError).loopId),
  );
}

async function readLoop(db: Db, loopId: string): Promise<Loop | undefined> {
  return (await db.select().from(loops).where(eq(loops.id, loopId)).limit(1))[0];
}

// ---- goal (ADR-009 决策 2) ----

export type UpdateGoalResult =
  | { found: false }
  | { found: true; kind: "noop"; loop: Loop }
  | { found: true; kind: "changed"; loop: Loop }
  | { found: true; kind: "rejected"; reason: GoalUpdateRejection };

/**
 * Set/clear a loop's goal. The pure kernel plans noop / stable rejection /
 * the revision+1 patch from the RESOLVED snapshot; the guarded write is
 * keyed on the snapshot's `revision` so NO concurrent loops write (a goal
 * change, a claim bump, a schedule edit, …) can ever be silently
 * overwritten. A no-op writes NOTHING (updatedAt/revision included).
 */
export async function updateGoal(
  deps: LifecycleOpsDeps,
  loopId: string,
  command: { goal: string | null },
): Promise<UpdateGoalResult> {
  return withLifecycleRetry(async () => {
    const resolved = await readLoop(deps.db, loopId);
    if (!resolved) return { found: false };
    await deps.hooks?.afterResolve?.(loopId, "goal");
    const plan = planGoalUpdate(resolved, command, deps.clock.now().toISOString());
    if (plan.kind === "noop") return { found: true, kind: "noop", loop: resolved };
    if (plan.kind === "rejected") return { found: true, kind: "rejected", reason: plan.reason };
    return deps.db.transaction(async (tx): Promise<UpdateGoalResult> => {
      const updated = await tx
        .update(loops)
        .set({ ...plan.writes, revision: sql`${loops.revision} + 1` })
        .where(and(eq(loops.id, loopId), eq(loops.revision, resolved.revision)))
        .returning();
      if (updated.length !== 1) throw new LifecycleGuardLostError(loopId);
      return { found: true, kind: "changed", loop: updated[0]! };
    });
  });
}

// ---- task file retarget (Batch 2 plan §2.2) ----

export type UpdateTaskFileResult =
  | { found: false }
  | { found: true; kind: "noop"; loop: Loop }
  | { found: true; kind: "changed"; loop: Loop }
  | { found: true; kind: "conflict"; reason: "run_in_progress" };

/**
 * Backfill or retarget the machine-side task-file path. The server never
 * interprets the path (validation of existence/jail is the daemon's at run
 * time). A raw-string-equal value is a no-op; an effective retarget clears
 * the ENTIRE old sync snapshot (content/syncedAt/attemptedAt/error) so a
 * stale snapshot can never be mistaken for the new target's content. A
 * RUNNING run holds a snapshot of the old path, so retargeting mid-run is a
 * plain 409; pending runs don't block (the claim transaction re-reads the
 * latest loop row).
 */
export async function updateTaskFile(
  deps: LifecycleOpsDeps,
  loopId: string,
  taskFile: string,
): Promise<UpdateTaskFileResult> {
  return withLifecycleRetry(async () => {
    const resolved = await readLoop(deps.db, loopId);
    if (!resolved) return { found: false };
    await deps.hooks?.afterResolve?.(loopId, "taskFile");
    if (resolved.taskFile === taskFile) return { found: true, kind: "noop", loop: resolved };

    return deps.db.transaction(async (tx): Promise<UpdateTaskFileResult> => {
      const running = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.loopId, loopId), eq(runs.phase, "running")))
        .limit(1);
      if (running.length > 0) return { found: true, kind: "conflict", reason: "run_in_progress" };

      // The claim transaction bumps `revision` as it flips a run to running
      // (store/runs.ts), so a claim committed anywhere between the resolve
      // above and this write loses the guard — the retry re-resolves and the
      // probe then sees the running run. The old-snapshot pollution race
      // (review SPEC-1/ADV-3) is closed.
      const updated = await tx
        .update(loops)
        .set({
          taskFile,
          taskFileContent: null,
          taskFileSyncedAt: null,
          taskFileSyncAttemptedAt: null,
          taskFileSyncError: null,
          updatedAt: deps.clock.now().toISOString(),
          revision: sql`${loops.revision} + 1`,
        })
        .where(and(eq(loops.id, loopId), eq(loops.revision, resolved.revision)))
        .returning();
      if (updated.length !== 1) throw new LifecycleGuardLostError(loopId);
      return { found: true, kind: "changed", loop: updated[0]! };
    });
  });
}

// ---- reopen (ADR-009 决策 5; 修订 2026-09-01 决策 5) ----

export type ReopenLoopResult =
  | { found: false }
  | { found: true; kind: "changed"; loop: Loop }
  | {
      found: true;
      kind: "rejected";
      reason: "invalid_loop_state" | "loop_not_completed" | "schedule_revision_exhausted";
    };

/**
 * Reopen a Completed loop in ONE transaction: the pure kernel computes the
 * completion-clearing + schedule re-arm patch (revision+1, fresh activation
 * boundary, watermark cleared — never backfilling occurrences missed while
 * completed); BEFORE that write lands, every leftover pending/running run of
 * the loop is canceled and EVERY residual lease (active and terminal-grace
 * alike) is deleted, so no old-generation credential can finalize into the
 * reopened generation. goal/goalRevision/state/task-file snapshot/cron/
 * timezone/run history all stay.
 */
export async function reopenLoop(deps: LifecycleOpsDeps, loopId: string): Promise<ReopenLoopResult> {
  return withLifecycleRetry(async () => {
    const resolved = await readLoop(deps.db, loopId);
    if (!resolved) return { found: false };
    await deps.hooks?.afterResolve?.(loopId, "reopen");
    const nowIso = deps.clock.now().toISOString();
    const plan = planReopen(resolved, nowIso);
    if (plan.kind === "rejected") return { found: true, kind: "rejected", reason: plan.reason };

    return deps.db.transaction(async (tx): Promise<ReopenLoopResult> => {
      // Old-generation revocation first: cancel leftover pending/running runs
      // (cancel semantics — no outcome), then delete every residual lease.
      await tx
        .update(runs)
        .set({ phase: "canceled", ts: nowIso })
        .where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])));
      await tx.delete(runLeases).where(eq(runLeases.loopId, loopId));

      const updated = await tx
        .update(loops)
        .set({ ...plan.writes, revision: sql`${loops.revision} + 1` })
        .where(and(eq(loops.id, loopId), eq(loops.revision, resolved.revision)))
        .returning();
      if (updated.length !== 1) throw new LifecycleGuardLostError(loopId);
      return { found: true, kind: "changed", loop: updated[0]! };
    });
  });
}
