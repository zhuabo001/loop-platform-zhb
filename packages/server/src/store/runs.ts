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
 *
 * Phase 3 Batch 2: enqueue accepts optional trigger metadata for scheduled
 * runs. Scheduled triggers validate revision/cron/enabled and atomically
 * advance lastScheduledAt watermark.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { sha256 } from "@loopzhb/protocol/node";
import type { RunProgress, RunRole } from "@loopzhb/protocol";

import type { Db } from "../db/index.js";
import { loops, runLeases, runs, type Loop, type Run, type RunProgressRow } from "../db/schema.js";
import { isOccurrence, isValidPersistedScheduleState, parseRfc3339Ms } from "../schedule/time-semantics.js";
import { isHeartbeatWatermarkAnomalous } from "./machines.js";
import { withGuardRetry } from "./guard-retry.js";
import type { Clock } from "../time.js";
import type { ExecTrigger } from "../coordinator/index.js";

/** The slice of coordinator dependencies the run store needs. */
export interface RunStoreDeps {
  db: Db;
  clock: Clock;
  newRunId(): string;
  hooks?: RunStoreHooks;
}

/** TEST-ONLY committed-interleaving seams. The read happens outside the
 * write transaction and the revision CAS proves that a competitor committed
 * in this window cannot make the ensuing decision stale. */
export interface RunStoreHooks {
  afterEnqueueLoopResolve?(loopId: string): void | Promise<void>;
  afterClaimLoopResolve?(loopId: string, runId: string): void | Promise<void>;
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
  | {
      enqueued: false;
      reason:
        | "loop_not_found"
        | "loop_completed"
        | "running_exists"
        | "stale_revision"
        | "not_active"
        | "not_an_occurrence"
        | "future_occurrence"
        | "before_activation"
        | "occurrence_too_old"
        | "already_scheduled"
        | "invalid_schedule_state";
    };

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

class EnqueueLoopGuardLostError extends Error {
  constructor(readonly loopId: string) {
    super(`enqueue loop guard lost for loop ${loopId}`);
    this.name = "EnqueueLoopGuardLostError";
  }
}

export class EnqueueRaceLostError extends Error {
  constructor(readonly loopId: string) {
    super(`enqueue loop guard did not settle for loop ${loopId}`);
    this.name = "EnqueueRaceLostError";
  }
}

export async function getLoop(db: Db, loopId: string): Promise<Loop | undefined> {
  return (await db.select().from(loops).where(eq(loops.id, loopId)))[0];
}

/** The enqueue transaction's running-run probe — ONE implementation shared by
 *  the manual and scheduled branches so the skip rule cannot drift. */
async function hasRunningExecRun(tx: Db, loopId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.loopId, loopId), eq(runs.phase, "running")))
    .limit(1);
  return rows.length > 0;
}

export async function getRun(db: Db, runId: string): Promise<Run | undefined> {
  return (await db.select().from(runs).where(eq(runs.id, runId)))[0];
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
 *
 * Phase 3 Batch 2: scheduled triggers validate revision/cron/enabled state
 * and atomically advance lastScheduledAt watermark. Running runs still skip
 * but watermark advances. Manual triggers (default) bypass all schedule checks.
 */
export async function enqueueExecRunTx(
  deps: RunStoreDeps,
  loop: Loop,
  trigger?: ExecTrigger,
): Promise<EnqueueExecRunResult> {
  return withGuardRetry(
    async () => {
      const { db, clock, newRunId } = deps;
      const currentLoop = await getLoop(db, loop.id);
      if (!currentLoop) return { enqueued: false as const, reason: "loop_not_found" as const };
      await deps.hooks?.afterEnqueueLoopResolve?.(loop.id);

      let canonicalFor: string | undefined;
      if (trigger?.kind === "scheduled") {

      // Phase 4 Completion guard: a Completed loop's finish bumped the
      // schedule revision AND cleared enabled, so the revision/not_active
      // checks below already refuse every stale callback — but an explicit
      // classification keeps the completed rejection distinguishable from an
      // ordinary pause in logs and tests.
        if (currentLoop.completedAt !== null) {
          return { enqueued: false as const, reason: "loop_completed" as const };
        }

      // Validate revision
        if (currentLoop.scheduleRevision !== trigger.scheduleRevision) {
          return { enqueued: false as const, reason: "stale_revision" as const };
        }

      // Validate active (enabled && cron not null)
        if (!currentLoop.enabled || currentLoop.cron === null) {
          return { enqueued: false as const, reason: "not_active" as const };
        }

      // Fail-closed persisted-state validation (Batch 3 §2.2): an ACTIVE
      // scheduled loop whose activation is missing/non-canonical, whose
      // non-null watermark is non-canonical, or whose revision is not a
      // non-negative safe integer is CORRUPT. Zero writes — corrupt strings
      // must never feed the lexicographic comparisons below or pollute the
      // watermark (the write paths only ever emit toISOString() forms, so a
      // violation means the row was damaged outside them).
        if (!isValidPersistedScheduleState({ ...currentLoop, cron: currentLoop.cron })) {
          return { enqueued: false as const, reason: "invalid_schedule_state" as const };
        }

      // Validate scheduledFor is a well-formed, genuine occurrence of the
      // loop's CURRENT cron/timezone and not in the future. Without these
      // guards an arbitrary (or future) timestamp would advance the watermark
      // and silently swallow every later real tick.
        const scheduledMs = parseRfc3339Ms(trigger.scheduledFor);
        if (
          scheduledMs === undefined ||
          !isOccurrence({ cron: currentLoop.cron, timezone: currentLoop.timezone }, new Date(scheduledMs))
        ) {
          return { enqueued: false as const, reason: "not_an_occurrence" as const };
        }
        if (scheduledMs > clock.now().getTime()) {
          return { enqueued: false as const, reason: "future_occurrence" as const };
        }

      // Canonicalize to UTC ISO before ANY comparison or persistence: every
      // equivalent representation of the same instant (`+08:00` offsets,
      // `+00:00`, …) must behave identically. Stored activation/watermark are
      // guaranteed canonical here — the fail-closed guard above rejected the
      // row otherwise — so string comparison on canonical forms is exact.
        canonicalFor = new Date(scheduledMs).toISOString();

      // Validate occurrence is after activation
        if (
          currentLoop.scheduleActivatedAt !== null &&
          canonicalFor <= currentLoop.scheduleActivatedAt
        ) {
          return { enqueued: false as const, reason: "before_activation" as const };
        }

      // Validate occurrence is after watermark
        if (currentLoop.lastScheduledAt !== null && canonicalFor <= currentLoop.lastScheduledAt) {
          return { enqueued: false as const, reason: "already_scheduled" as const };
        }
      } else if (currentLoop.completedAt !== null) {
        return { enqueued: false as const, reason: "loop_completed" as const };
      }

      return db.transaction(async (tx) => {
        if (trigger?.kind === "scheduled") {
          const updated = await tx
            .update(loops)
            .set({ lastScheduledAt: canonicalFor!, revision: sql`${loops.revision} + 1` })
            .where(and(eq(loops.id, loop.id), eq(loops.revision, currentLoop.revision)))
            .returning({ id: loops.id });
          if (updated.length !== 1) throw new EnqueueLoopGuardLostError(loop.id);

          if (await hasRunningExecRun(tx, loop.id)) {
            return { enqueued: false as const, reason: "running_exists" as const };
          }
        } else {
          if (await hasRunningExecRun(tx, loop.id)) {
            return { enqueued: false as const, reason: "running_exists" as const };
          }

          const guarded = await tx
            .update(loops)
            .set({ revision: sql`${loops.revision} + 1` })
            .where(and(eq(loops.id, loop.id), eq(loops.revision, currentLoop.revision)))
            .returning({ id: loops.id });
          if (guarded.length !== 1) throw new EnqueueLoopGuardLostError(loop.id);
        }

    // Supersede all pending exec runs
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
          machineId: currentLoop.machineId,
          phase: "pending",
          role: "exec",
          ts,
        });
        return { enqueued: true as const, runId, supersededRunIds };
      });
    },
    (err) => err instanceof EnqueueLoopGuardLostError,
    (err) => new EnqueueRaceLostError((err as EnqueueLoopGuardLostError).loopId),
  );
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
  /** The authoritative loop row returned by the successful revision CAS —
   *  the Delivery and lease fields are built from this proven snapshot,
   *  never from the candidate scan's hint. */
  loop: Loop;
}

/**
 * THE atomic claim: conditional `pending → running` UPDATE + lease INSERT in
 * ONE transaction (a deliberate reference deviation — the reference mints the
 * lease in a second statement).
 *
 * The UPDATE guard carries the FULL write-time eligibility (`id + pending +
 * machineId + loopId + role` — review finding #2): the candidate scan's
 * snapshot is only a hint, and the lease/Delivery are built from the
 * RETURNING authoritative row, never from the caller's stale copy.
 *
 * Phase 4 Batch 2 (ADR-009 修订 2026-09-01 决策 7): after the run flips, the
 * claim attempt resolves the Loop immediately before the write transaction;
 * that transaction proves the snapshot with an `id + revision` CAS. A
 * missing/Completed Loop mints no lease, while a competitor commit loses the
 * CAS and rolls the run flip back before one bounded re-resolve. The
 * minted lease is EXPLICITLY v1: `terminalProtocolVersion: 1`,
 * `goalRevision: <loop's current revision>` and `canFinish: role==='exec' &&
 * goal!=null` — never left to DDL defaults. Leases minted BEFORE the Phase 4
 * upgrade keep their persisted v0 semantics forever (决策 7: the protocol
 * version is decided at claim time).
 *
 * Returns undefined when the guard loses a concurrent race (the run was
 * claimed by another poll) OR the authoritative loop resolve refuses the
 * claim: the caller skips THAT candidate and keeps going — the batch is never
 * all-or-nothing. Once this transaction commits, the run has PERMANENTLY left
 * the dispatch surface: a dropped delivery response can never cause a
 * re-execution (at-most-once), the inactivity sweep reaps the orphaned
 * running run later.
 *
 * Phase 1 lease mint policy (ADR-003): the control capabilities are written
 * FALSE explicitly — never inherited from loop config, never left to DB
 * defaults.
 */
export async function claimRunWithLeaseTx(
  deps: ClaimStoreDeps,
  input: { runId: string; loopId: string; machineId: string; role: RunRole },
): Promise<ClaimedRun | undefined> {
  return withGuardRetry(
    async () => {
      const { db, clock, mintRunCredential } = deps;
      const candidate = await getRun(db, input.runId);
      if (
        !candidate ||
        candidate.phase !== "pending" ||
        candidate.machineId !== input.machineId ||
        candidate.loopId !== input.loopId ||
        candidate.role !== input.role
      ) {
        return undefined;
      }
      const loop = await getLoop(db, input.loopId);
      if (!loop || loop.completedAt !== null) throw new ClaimRefusedError(input.runId);
      await deps.hooks?.afterClaimLoopResolve?.(loop.id, input.runId);

      return db.transaction(async (tx) => {
        const claimed = (
      await tx
        .update(runs)
        .set({ phase: "running", ts: clock.now().toISOString() })
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.phase, "pending"),
            eq(runs.machineId, input.machineId),
            eq(runs.loopId, input.loopId),
            eq(runs.role, input.role),
          ),
        )
        .returning()
        )[0];
        if (!claimed) return undefined;

    // OCC bump (review SPEC-1/ADV-3, ADR-009 修订 2026-09-01): claiming flips
    // a run to running WITHOUT touching the loops row, so a concurrent
    // management op (task-file retarget, goal, reopen, schedule) that
    // resolved the loop before this claim must NEVER land its stale write.
    // Every loops write bumps `revision`; every management op guards on it —
    // this bump loses their guard, and their bounded re-resolve then sees
    // the running run (retarget → 409 run_in_progress). Wire-neutral: no
    // lease or response field changes.
        const guardedLoop = (
          await tx
            .update(loops)
            .set({ revision: sql`${loops.revision} + 1` })
            .where(and(eq(loops.id, loop.id), eq(loops.revision, loop.revision)))
            .returning()
        )[0];
        if (!guardedLoop) throw new ClaimLoopGuardLostError(claimed.id, loop.id);

    // Mint INSIDE the transaction: a factory failure rolls the claim back,
    // leaving the run pending for a later poll.
        const runToken = mintRunCredential();
        await tx.insert(runLeases).values({
      tokenHash: sha256(runToken),
      runId: claimed.id,
      loopId: claimed.loopId,
      machineId: claimed.machineId,
      role: claimed.role,
      allowControl: false,
      canSetUi: false,
      canSetSchema: false,
      canSetWorkflow: false,
          canFinish: claimed.role === "exec" && guardedLoop.goal !== null,
      terminalProtocolVersion: 1,
          goalRevision: guardedLoop.goalRevision,
      state: "active",
      expiresAt: null,
      createdAt: clock.now().toISOString(),
        });
        return { run: claimed, runToken, loop: guardedLoop };
      });
    },
    (err) => err instanceof ClaimLoopGuardLostError,
    (err) => new ClaimRaceLostError((err as ClaimLoopGuardLostError).runId),
  );
}

class ClaimLoopGuardLostError extends Error {
  constructor(readonly runId: string, readonly loopId: string) {
    super(`claim loop guard lost for run ${runId} on loop ${loopId}`);
    this.name = "ClaimLoopGuardLostError";
  }
}

export class ClaimRaceLostError extends Error {
  constructor(readonly runId: string) {
    super(`claim loop guard did not settle for run ${runId}`);
    this.name = "ClaimRaceLostError";
  }
}

/** Internal control-flow signal: the authoritative loop resolve refused the
 * claim (loop gone or Completed). No write transaction starts, and the poll
 * pipeline catches it as a skip. */
export class ClaimRefusedError extends Error {
  constructor(readonly runId: string) {
    super(`claim refused for run ${runId}`);
    this.name = "ClaimRefusedError";
  }
}

// ---- lifecycle primitives (cancel / sweep reclaim) ----

/** The deps the lifecycle primitives need — narrower than RunStoreDeps (no
 *  id/credential factories). Their future adapters (owner cancel, Day 8–10
 *  sweep orchestration) call them DIRECTLY: they are deliberately NOT on the
 *  RunCoordinator interface (A-02). */
export interface LifecycleStoreDeps {
  db: Db;
  clock: Clock;
}

/** How long a reclaimed run's terminal-grace lease stays alive to accept the
 *  ONE reconciling wake-report (a laptop can sleep overnight or a weekend). */
export const TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The run's last-activity evidence, in epoch ms — `max(run.ts, progress.at)`
 * restricted to VALID stamps: unparseable values are skipped, and stamps
 * further than the shared skew slack into the future are pollution (the SAME
 * predicate the machine-watermark consumers use — "anomalous" can never drift
 * between surfaces). `null` = no evidence at all; the caller fails CLOSED.
 *
 * THE shared staleness rule: the sweep's candidate scan AND reclaimStaleRunTx's
 * in-transaction re-validation both compute activity through THIS function —
 * the rule cannot drift between the hint and the guard.
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

/** The outcome of a reclaim attempt (review: scan/reclaim TOCTOU). Anything
 *  other than "reclaimed" is a BENIGN race — the sweep neither logs it as a
 *  failure nor counts it: the run simply no longer matches the scan's hint. */
export type ReclaimOutcome =
  | "reclaimed"
  /** Left `running` between the scan and this transaction. */
  | "not_running"
  /** A fresh ts/progress.at landed between the scan and this transaction —
   *  the in-transaction re-validation vetoes the reclaim (Phase 2 progress
   *  heartbeats make this reachable). */
  | "activity_fresh"
  /** The row's activity evidence changed after this transaction read it, so
   *  the conditional reclaim deliberately gave up. A later sweep may inspect
   *  the new value; this pass must never overwrite it. */
  | "activity_changed";

/**
 * Owner cancel (Phase 1: NO HTTP route — the future owner adapter calls
 * THIS store primitive directly; A-02 keeps it off the coordinator's
 * three-method interface). Run → `canceled` and the lease DELETE land in ONE transaction
 * (a deliberate reference deviation: there is no "canceled but lease still
 * live" window, so a late report always meets the unified 401). Terminal and
 * missing runs are a no-op. Returns whether the run transitioned.
 */
export async function cancelRunTx(deps: LifecycleStoreDeps, runId: string): Promise<boolean> {
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

/** The reclaim's conjunctive guard lost: the run was running but NO active
 *  lease flipped — an invariant violation (claim+lease are one transaction,
 *  so a running run ALWAYS has an active lease). Thrown to roll the whole
 *  transaction back: erroring the run without a grace window would create a
 *  terminal state no late report can ever reconcile (review #6). */
export class ReclaimGuardLostError extends Error {
  constructor(readonly runId: string) {
    super(`reclaim guard lost for run ${runId}: running without an active lease`);
    this.name = "ReclaimGuardLostError";
  }
}

/**
 * Sweep reclaim — SWEEP-ORCHESTRATION ONLY (report, cancel, normal failure
 * and admin paths must never call this: they must not manufacture reconcile
 * eligibility). In ONE transaction: re-validate the staleness decision (below),
 * a still-running run goes error/error with the generic reclaim reason (the
 * wake-report replaces it with the truth), `ts` is stamped, and the lease
 * flips active → terminal-grace with the FIRST `now + 24h` window.
 *
 * The activity re-validation (review: scan/reclaim TOCTOU): the sweep's scan
 * decided staleness from a snapshot; a `ts`/`progress.at` write that landed
 * since (Phase 2 progress heartbeats) must veto the reclaim. The transaction
 * re-reads the run and recomputes `lastRunActivityMs` — the SAME shared
 * predicate as the scan — against a FRESH clock snapshot: still-fresh →
 * "activity_fresh", a benign skip that is neither reclaimed nor failed.
 *
 * The eligibility guard is CONJUNCTIVE (plan §事务守卫 — review #6): only
 * `running run + active lease` reclaims. The lease flip must affect EXACTLY
 * one row — zero rows means the invariant is broken, and the whole
 * transaction rolls back via ReclaimGuardLostError (zero writes).
 *
 * The lease-terminalize step is PRIVATE to this transaction — there is
 * deliberately no standalone exported terminalizeLease (structural pin in the
 * tests). Guards: only a `running` run reclaims (a repeat reclaim is a no-op
 * and can NEVER extend the first window), and only an `active` lease flips.
 */
export async function reclaimStaleRunTx(
  deps: LifecycleStoreDeps,
  input: { runId: string; runInactivityMs: number },
): Promise<ReclaimOutcome> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const nowMs = now.getTime();
    const candidate = (
      await tx
        .select({ phase: runs.phase, ts: runs.ts, progress: runs.progress })
        .from(runs)
        .where(eq(runs.id, input.runId))
    )[0];
    if (!candidate || candidate.phase !== "running") return "not_running" as const;
    const activityMs = lastRunActivityMs({ ts: candidate.ts, progress: candidate.progress }, nowMs);
    if (activityMs !== null && nowMs - activityMs < input.runInactivityMs) return "activity_fresh" as const;

    const nowIso = now.toISOString();
    const progressGuard = candidate.progress === null ? isNull(runs.progress) : eq(runs.progress, candidate.progress);
    const updated = await tx
      .update(runs)
      .set({ phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR, ts: nowIso })
      // Carry the exact activity snapshot through the write. A heartbeat that
      // lands after the read changes ts/progress and makes this a benign CAS
      // loser rather than an erroneous reclaim.
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.phase, "running"),
          eq(runs.ts, candidate.ts),
          progressGuard,
        ),
      )
      .returning({ id: runs.id });
    if (updated.length === 0) {
      const current = (
        await tx
          .select({ phase: runs.phase, ts: runs.ts, progress: runs.progress })
          .from(runs)
          .where(eq(runs.id, input.runId))
      )[0];
      if (!current || current.phase !== "running") return "not_running" as const;
      const currentActivityMs = lastRunActivityMs({ ts: current.ts, progress: current.progress }, nowMs);
      if (currentActivityMs !== null && nowMs - currentActivityMs < input.runInactivityMs) return "activity_fresh" as const;
      return "activity_changed" as const;
    }
    const terminalized = await tx
      .update(runLeases)
      .set({ state: "terminal-grace", expiresAt: new Date(nowMs + TERMINAL_GRACE_MS).toISOString() })
      .where(and(eq(runLeases.runId, input.runId), eq(runLeases.state, "active")))
      .returning({ tokenHash: runLeases.tokenHash });
    if (terminalized.length !== 1) throw new ReclaimGuardLostError(input.runId);
    return "reclaimed" as const;
  });
}

// ---- poll-carried progress heartbeats (Phase 2) ----

/** Server-side size policy (ADR-002: the protocol pins SHAPE, the server pins
 *  SIZE — a schema-level cap would turn an oversized heartbeat into a 400 and
 *  kill the daemon's poll loop). The entries cap is DEFENSE-ONLY: fairness
 *  across >20 activities is the daemon's round-robin duty, not this slice's. */
export const PROGRESS_ENTRIES_CAP = 20;
export const PROGRESS_LABEL_CAP = 200;
/** A blank-after-cleaning label still refreshes the liveness stamp. */
export const PROGRESS_LABEL_FALLBACK = "working";

/** NUL-strip → trim → blank-fallback → cap (same family as cleanIdentityField).
 *  runId is deliberately NOT cleaned: it is only a WHERE key — no match, zero
 *  rows. */
function cleanProgressLabel(raw: string): string {
  const cleaned = raw.replace(/\0/g, "").trim();
  if (!cleaned) return PROGRESS_LABEL_FALLBACK;
  return cleaned.slice(0, PROGRESS_LABEL_CAP);
}

/**
 * Apply poll-carried progress heartbeats: ONE conditional UPDATE per entry —
 * `SET progress = {step, label, at} WHERE id=? AND machineId=? AND
 * phase='running'`.
 *
 *  - `at` comes from the injected clock (ONE snapshot for the whole batch —
 *    the daemon never supplies it). It is the sweep's liveness evidence via
 *    `lastRunActivityMs`, and because ONLY the server writes it, the
 *    anomalous-future guard there degrades to pure defense-in-depth.
 *  - The write NEVER touches `ts` — claim and report/reclaim CAS guards read
 *    `ts` as transition-time only.
 *  - The `machineId` conjunct is the authorization boundary; the `phase`
 *    conjunct makes late (done/canceled/reclaimed), foreign and unknown
 *    runIds all benign zero-row writes. Silence is the norm, not an error.
 *  - Deliberately NO transaction and NO CAS: arrival-order last-wins is the
 *    accepted semantic (a machine's healthy deployment has ONE daemon polling
 *    serially; same-token concurrent daemons are a misconfiguration, and
 *    per-step anti-rollback would buy nothing there). Duplicate runIds within
 *    one batch dedup last-wins via the Map; the first-20 slice is the
 *    defensive cap above.
 *  - A write failure PROPAGATES (fail-closed, same precedent as
 *    applyMachinePollContact): a silently swallowed heartbeat lets the sweep
 *    reclaim a long-running agent.
 */
export async function applyRunProgress(
  deps: LifecycleStoreDeps,
  input: { machineId: string; entries: RunProgress[] },
): Promise<void> {
  const byRunId = new Map<string, RunProgress>();
  for (const entry of input.entries) byRunId.set(entry.runId, entry);
  const at = deps.clock.now().toISOString();
  for (const entry of [...byRunId.values()].slice(0, PROGRESS_ENTRIES_CAP)) {
    await deps.db
      .update(runs)
      .set({ progress: { step: entry.step, label: cleanProgressLabel(entry.label), at } })
      .where(
        and(eq(runs.id, entry.runId), eq(runs.machineId, input.machineId), eq(runs.phase, "running")),
      );
  }
}
