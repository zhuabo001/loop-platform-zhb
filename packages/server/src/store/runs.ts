/**
 * Store-internal run primitives. NOT a public repository port (plan §1): the
 * RunCoordinator is the only caller, and all lifecycle timestamps come from
 * the injected Clock — never `new Date()` here.
 *
 * Transaction boundaries (ADR-001/003, deliberate reference deviations):
 *  - enqueue: supersede-all + insert in ONE transaction;
 *  - claim (Step 2): conditional `pending → running` UPDATE + lease INSERT in
 *    ONE transaction;
 *  - report finalize (Step 3): run UPDATE + lease DELETE in ONE transaction.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { loops, runs, type Loop } from "../db/schema.js";
import type { Clock } from "../time.js";

/** The slice of coordinator dependencies the run store needs. */
export interface RunStoreDeps {
  db: Db;
  clock: Clock;
  newRunId(): string;
}

/** Stable terminal message for a superseded run (pinned by T7 tests). */
export const SUPERSEDED_MESSAGE = "superseded by a newer pending run";

export type EnqueueExecRunResult =
  | { enqueued: true; runId: string; supersededRunIds: string[] }
  | { enqueued: false; reason: "loop_not_found" | "running_exists" };

/**
 * A phase guard inside the enqueue transaction lost a race (the row was no
 * longer pending when the conditional UPDATE landed) — the transaction throws
 * and rolls back rather than enqueue behind a concurrently-claimed run. On
 * single-connection pglite this is defensive depth; it becomes load-bearing
 * on real multi-connection Postgres (Phase 6).
 */
export class EnqueueGuardLostError extends Error {
  constructor(readonly runId: string) {
    super(`enqueue supersede guard lost for run ${runId}`);
    this.name = "EnqueueGuardLostError";
  }
}

export async function getLoop(db: Db, loopId: string): Promise<Loop | undefined> {
  return (await db.select().from(loops).where(eq(loops.id, loopId)))[0];
}

/**
 * T7 atomic supersede: create the loop's next pending exec run.
 *
 * The caller (coordinator) fetches the loop and serializes per loop; THIS
 * function is one transaction: re-check for a running run (zero-write skip),
 * conditionally supersede every older pending EXEC run (non-exec pendings are
 * out of scope — Phase 3 roles), then insert exactly one new pending run.
 * Any failure — a lost phase guard, a factory throw, an insert error —
 * propagates and rolls the whole transaction back.
 */
export async function enqueueExecRunTx(deps: RunStoreDeps, loop: Loop): Promise<EnqueueExecRunResult> {
  const { db, clock, newRunId } = deps;
  return db.transaction(async (tx) => {
    const running = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.loopId, loop.id), eq(runs.phase, "running")))
      .limit(1);
    if (running.length > 0) return { enqueued: false as const, reason: "running_exists" as const };

    const pendings = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.loopId, loop.id), eq(runs.phase, "pending"), eq(runs.role, "exec")))
      .orderBy(asc(runs.ts), asc(runs.id));

    const ts = clock.now().toISOString();
    const supersededRunIds: string[] = [];
    for (const pending of pendings) {
      const updated = await tx
        .update(runs)
        .set({ phase: "canceled", outcome: "skipped", message: SUPERSEDED_MESSAGE, ts })
        .where(and(eq(runs.id, pending.id), eq(runs.phase, "pending")))
        .returning({ id: runs.id });
      if (updated.length === 0) throw new EnqueueGuardLostError(pending.id);
      supersededRunIds.push(pending.id);
    }

    const runId = newRunId();
    await tx.insert(runs).values({
      id: runId,
      loopId: loop.id,
      machineId: loop.machineId,
      phase: "pending",
      role: "exec",
      ts,
    });
    return { enqueued: true as const, runId, supersededRunIds };
  });
}
