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
import { and, asc, eq, inArray } from "drizzle-orm";

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

/** The generic reason the SWEEP writes when reclaiming a vanished machine's
 *  run (Step 4's reclaimStaleRun). Deliberately unstable-looking and generic:
 *  a reconciling failure report replaces it with the real error or the
 *  fallback — it must never survive a wake-report. */
export const RECLAIM_RUN_ERROR = "machine timed out / disconnected";

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

// ---- lifecycle primitives (cancel / sweep reclaim) ----

/** How long a reclaimed run's terminal-grace lease stays alive to accept the
 *  ONE reconciling wake-report (a laptop can sleep overnight or a weekend). */
export const TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Owner cancel (Phase 1: NO HTTP route — the owner adapter calls the
 * coordinator). Run → `canceled` and the lease DELETE land in ONE transaction
 * (a deliberate reference deviation: there is no "canceled but lease still
 * live" window, so a late report always meets the unified 401). Terminal and
 * missing runs are a no-op. Returns whether the run transitioned.
 */
export async function cancelRunTx(deps: RunStoreDeps, runId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(runs)
      .set({ phase: "canceled", ts: deps.clock.now().toISOString() })
      .where(and(eq(runs.id, runId), inArray(runs.phase, ["pending", "running"])))
      .returning({ id: runs.id });
    if (updated.length === 0) return false;
    await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    return true;
  });
}

/**
 * Sweep reclaim — SWEEP-ORCHESTRATION ONLY (report, cancel, normal failure
 * and admin paths must never call this: they must not manufacture reconcile
 * eligibility). In ONE transaction: a still-running run goes error/error with
 * the generic reclaim reason (the wake-report replaces it with the truth),
 * `ts` is stamped, and the lease flips active → terminal-grace with the FIRST
 * `now + 24h` window.
 *
 * The lease-terminalize step is PRIVATE to this transaction — there is
 * deliberately no standalone exported terminalizeLease (structural pin in the
 * tests). Guards: only a `running` run reclaims (a repeat reclaim is a no-op
 * and can NEVER extend the first window), and only an `active` lease flips.
 */
export async function reclaimStaleRunTx(deps: RunStoreDeps, runId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    const updated = await tx
      .update(runs)
      .set({ phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR, ts: nowIso })
      .where(and(eq(runs.id, runId), eq(runs.phase, "running")))
      .returning({ id: runs.id });
    if (updated.length === 0) return false;
    await tx
      .update(runLeases)
      .set({ state: "terminal-grace", expiresAt: new Date(now.getTime() + TERMINAL_GRACE_MS).toISOString() })
      .where(and(eq(runLeases.runId, runId), eq(runLeases.state, "active")));
    return true;
  });
}
