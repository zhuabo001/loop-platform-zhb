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

import { sha256 } from "@loopzhb/protocol/node";
import type { RunRole } from "@loopzhb/protocol";

import type { Db } from "../db/index.js";
import { loops, runLeases, runs, type Loop, type Run } from "../db/schema.js";
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

// ---- poll claim (ADR-001's atomic claim + at-most-once delivery) ----

/** Every pending EXEC run a machine's poll may attempt, in deterministic
 *  dispatch order (`ts ASC, id ASC` — the plan's candidate order). */
export async function pendingExecRunsForMachine(db: Db, machineId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.machineId, machineId), eq(runs.phase, "pending"), eq(runs.role, "exec")))
    .orderBy(asc(runs.ts), asc(runs.id));
}

export interface ClaimStoreDeps extends RunStoreDeps {
  mintRunCredential(): string;
}

export interface ClaimedRun {
  run: Run;
  /** The plaintext wire credential — returned to the daemon ONCE; the DB only
   *  ever holds its sha256. */
  runToken: string;
}

/**
 * THE atomic claim: conditional `pending → running` UPDATE + lease INSERT in
 * ONE transaction (a deliberate reference deviation — the reference mints the
 * lease in a second statement).
 *
 * Returns undefined when the phase guard loses a concurrent race (the run was
 * claimed by another poll): the caller skips THAT candidate and keeps going —
 * the batch is never all-or-nothing. Once this transaction commits, the run
 * has PERMANENTLY left the dispatch surface: a dropped delivery response can
 * never cause a re-execution (at-most-once), the inactivity sweep reaps the
 * orphaned running run later.
 *
 * Phase 1 lease mint policy (ADR-003): every capability is written FALSE
 * explicitly — never inherited from loop config, never left to DB defaults.
 */
export async function claimRunWithLeaseTx(
  deps: ClaimStoreDeps,
  input: { runId: string; loopId: string; machineId: string; role: RunRole },
): Promise<ClaimedRun | undefined> {
  const { db, clock, mintRunCredential } = deps;
  return db.transaction(async (tx) => {
    const claimed = (
      await tx
        .update(runs)
        .set({ phase: "running", ts: clock.now().toISOString() })
        .where(and(eq(runs.id, input.runId), eq(runs.phase, "pending")))
        .returning()
    )[0];
    if (!claimed) return undefined;

    // Mint INSIDE the transaction: a factory failure rolls the claim back,
    // leaving the run pending for a later poll.
    const runToken = mintRunCredential();
    await tx.insert(runLeases).values({
      tokenHash: sha256(runToken),
      runId: claimed.id,
      loopId: input.loopId,
      machineId: input.machineId,
      role: input.role,
      allowControl: false,
      canSetUi: false,
      canSetSchema: false,
      canSetWorkflow: false,
      canFinish: false,
      state: "active",
      expiresAt: null,
      createdAt: clock.now().toISOString(),
    });
    return { run: claimed, runToken };
  });
}
