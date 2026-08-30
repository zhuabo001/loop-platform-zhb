/**
 * Loop lifecycle PURE KERNEL (Phase 4, ADR-009) — the single source for the
 * domain decisions Batch 2 will wire to transactions:
 *
 *  - persisted-snapshot invariant validation (fail-closed reads)
 *  - primary status classification (Completed > Paused > Open/Closed)
 *  - Goal normalization / update plans (noop / rejection / patch)
 *  - Finish eligibility with the fixed classification order
 *  - Reopen plans (reusing the schedule transition core)
 *  - the v1 final-Report decision + write-plan
 *
 * Everything here is pure: no DB, no Clock (callers pass `nowIso`), no HTTP
 * mapping, no credential resolution, no capability persistence, no Scheduler
 * reconcile. Batch 1 deliberately does NOT wire this module into any handler,
 * coordinator or store (休眠边界, ADR-009 决策 11).
 */
import {
  normalizeGoal,
  validateFinishReason,
  validateTaskFileSyncResult,
  validateTerminalMessage,
  validateTerminalState,
  type GoalValidationFailure,
  type JsonObject,
  type ReportRequest,
  type RunRole,
  type RunStatus,
  type TaskFileSyncError,
} from "@loopzhb/protocol";

import type { Loop, NewRun, Run } from "../db/schema.js";
import { buildReportWriteSet } from "../store/report.js";
import { planScheduleTransition, REVISION_INT32_MAX } from "../schedule/transition.js";

// ---- snapshots ----

/** The lifecycle slice of a Loop row. */
export type LoopLifecycleSnapshot = Pick<
  Loop,
  | "goal"
  | "goalRevision"
  | "completedAt"
  | "completionReason"
  | "enabled"
  | "cron"
  | "timezone"
  | "scheduleRevision"
>;

/** The additional Loop fields a v1 report write-plan reads. */
export type LoopReportSnapshot = LoopLifecycleSnapshot &
  Pick<
    Loop,
    | "state"
    | "taskFileContent"
    | "taskFileSyncedAt"
    | "taskFileSyncAttemptedAt"
    | "taskFileSyncError"
  >;

/** The Run/Lease authorization snapshot a finish decision needs. */
export interface LeaseAuthSnapshot {
  role: RunRole;
  canFinish: boolean;
  /** The loop goalRevision captured at claim time. */
  goalRevision: number;
  terminalProtocolVersion: number;
}

// ---- invariant + classification (ADR-009 决策 1/3) ----

export type LoopPrimaryStatus = "completed" | "paused" | "open" | "closed";

/**
 * The persisted-state invariant, mirroring the loops_completion_ck CHECK plus
 * the parts a CHECK cannot express: revisions are int32-safe integers and a
 * persisted goal is its OWN normalization (write paths normalize; a violation
 * means the row was damaged outside them). The domain kernel re-validates
 * every snapshot it reads — the database constraint is the second line, never
 * the only business judgment.
 */
export function isValidLoopSnapshot(loop: LoopLifecycleSnapshot): boolean {
  for (const revision of [loop.goalRevision, loop.scheduleRevision]) {
    if (!Number.isInteger(revision) || revision < 0 || revision > REVISION_INT32_MAX) return false;
  }
  if (loop.goal !== null) {
    const normalized = normalizeGoal(loop.goal);
    if (!normalized.ok || normalized.goal !== loop.goal) return false;
  }
  if (loop.completedAt === null && loop.completionReason === null) return true;
  return (
    loop.goal !== null &&
    loop.completedAt !== null &&
    loop.completionReason !== null &&
    loop.enabled === false
  );
}

/** Thrown when a READ snapshot violates the persisted-state invariant —
 *  fail-closed: corrupt rows must never flow into domain decisions. */
export class LoopInvariantViolationError extends Error {
  constructor() {
    super("loop snapshot violates the completion/goal/revision invariant");
    this.name = "LoopInvariantViolationError";
  }
}

/** The primary status by FIXED priority: Completed > Paused > Open/Closed.
 *  The goal dimension stays independently readable (`goal === null` ⇔ Open). */
export function classifyLoop(loop: LoopLifecycleSnapshot): LoopPrimaryStatus {
  if (!isValidLoopSnapshot(loop)) throw new LoopInvariantViolationError();
  if (loop.completedAt !== null) return "completed";
  if (!loop.enabled) return "paused";
  return loop.goal === null ? "open" : "closed";
}

// ---- goal update plan (ADR-009 决策 2) ----

export type GoalUpdateRejection =
  | "invalid_loop_state"
  | "loop_completed"
  | "goal_revision_exhausted"
  | GoalValidationFailure;

export interface GoalPatch {
  goal: string | null;
  goalRevision: number;
  updatedAt: string;
}

export type GoalUpdatePlan =
  | { kind: "noop" }
  | { kind: "rejected"; reason: GoalUpdateRejection }
  | { kind: "changed"; writes: GoalPatch };

/**
 * Plan a goal set/clear. Deterministic rejection order: corrupt snapshot →
 * completed (goal is read-only until Reopen — even an equal-value write) →
 * policy (trim/empty/NUL/single-line/bytes) → equal-value noop → revision
 * exhaustion. A `null` command value clears to an Open Loop; clearing never
 * resets the revision.
 */
export function planGoalUpdate(
  loop: LoopLifecycleSnapshot,
  command: { goal: string | null },
  nowIso: string,
): GoalUpdatePlan {
  if (!isValidLoopSnapshot(loop)) return { kind: "rejected", reason: "invalid_loop_state" };
  if (loop.completedAt !== null) return { kind: "rejected", reason: "loop_completed" };

  let normalized: string | null;
  if (command.goal === null) {
    normalized = null;
  } else {
    const result = normalizeGoal(command.goal);
    if (!result.ok) return { kind: "rejected", reason: result.failure };
    normalized = result.goal;
  }

  if (normalized === loop.goal) return { kind: "noop" };
  if (loop.goalRevision >= REVISION_INT32_MAX) return { kind: "rejected", reason: "goal_revision_exhausted" };
  return {
    kind: "changed",
    writes: { goal: normalized, goalRevision: loop.goalRevision + 1, updatedAt: nowIso },
  };
}

// ---- finish (ADR-009 决策 4) ----

export type FinishClassification =
  | "invalid_loop_state"
  | "already_completed"
  | "finish_not_allowed"
  | "stale_goal";

/** The Loop writes a LEGAL finish produces (the completion + schedule patch —
 *  state/task-file promotion is the report write-plan's concern, not this
 *  eligibility decision's). */
export interface CompletionWrites {
  completedAt: string;
  completionReason: string;
  enabled: false;
  scheduleRevision: number;
  scheduleActivatedAt: null;
  lastScheduledAt: null;
  updatedAt: string;
}

export type FinishPlan =
  | { kind: "allowed"; writes: CompletionWrites }
  | { kind: "rejected"; classification: FinishClassification };

/**
 * Finish eligibility + completion patch. The classification order is FIXED —
 * the first matching guard is the unique result:
 *  1. invalid_loop_state  — the persisted snapshot violates the invariant
 *  2. already_completed   — the loop is legally completed
 *  3. finish_not_allowed  — non-exec role, canFinish=false, or an Open Loop
 *  4. stale_goal          — the lease's captured goalRevision ≠ the current one
 * `enabled=false` (Paused) is NOT itself a rejection: a manual exec run of a
 * Paused Closed loop may finish.
 */
export function planFinish(
  loop: LoopLifecycleSnapshot,
  lease: Pick<LeaseAuthSnapshot, "role" | "canFinish" | "goalRevision">,
  reason: string,
  nowIso: string,
): FinishPlan {
  if (!isValidLoopSnapshot(loop)) return { kind: "rejected", classification: "invalid_loop_state" };
  if (loop.completedAt !== null) return { kind: "rejected", classification: "already_completed" };
  if (lease.role !== "exec" || !lease.canFinish || loop.goal === null) {
    return { kind: "rejected", classification: "finish_not_allowed" };
  }
  if (lease.goalRevision !== loop.goalRevision) return { kind: "rejected", classification: "stale_goal" };

  // The completion patch always bumps scheduleRevision (completion stops all
  // future scheduling). At the int32 ceiling the transition is impossible —
  // folded into invalid_loop_state, never a DB overflow (ADR-009 决策 4).
  if (loop.scheduleRevision >= REVISION_INT32_MAX) {
    return { kind: "rejected", classification: "invalid_loop_state" };
  }
  return {
    kind: "allowed",
    writes: {
      completedAt: nowIso,
      completionReason: reason,
      enabled: false,
      scheduleRevision: loop.scheduleRevision + 1,
      scheduleActivatedAt: null,
      lastScheduledAt: null,
      updatedAt: nowIso,
    },
  };
}

// ---- reopen (ADR-009 决策 5) ----

export type ReopenPlan =
  | { kind: "rejected"; reason: "invalid_loop_state" | "loop_not_completed" | "schedule_revision_exhausted" }
  | {
      kind: "changed";
      writes: {
        completedAt: null;
        completionReason: null;
        enabled: true;
        scheduleRevision: number;
        scheduleActivatedAt: string | null;
        lastScheduledAt: null;
        updatedAt: string;
      };
    };

/**
 * Reopen a Completed loop: clear the completion pair, re-enable, and re-arm
 * the schedule through the SAME pure core a schedule PATCH uses (revision+1,
 * fresh activation boundary when cron is set, watermark cleared) — never
 * backfilling occurrences missed while completed. goal/goalRevision/state/
 * task-file snapshot/cron/timezone/run history all stay.
 */
export function planReopen(loop: LoopLifecycleSnapshot, nowIso: string): ReopenPlan {
  if (!isValidLoopSnapshot(loop)) return { kind: "rejected", reason: "invalid_loop_state" };
  if (loop.completedAt === null) return { kind: "rejected", reason: "loop_not_completed" };

  // A completed loop has enabled=false, so {enabled:true} is always an
  // effective change for the core — revision bump + activation re-arm.
  const transition = planScheduleTransition(loop, { enabled: true }, nowIso);
  if (transition.kind === "schedule_revision_exhausted") {
    return { kind: "rejected", reason: "schedule_revision_exhausted" };
  }
  if (transition.kind !== "changed") {
    // Unreachable given enabled=false above — fail closed if the invariant
    // ever lets a contradiction through.
    return { kind: "rejected", reason: "invalid_loop_state" };
  }
  return {
    kind: "changed",
    writes: {
      completedAt: null,
      completionReason: null,
      enabled: true,
      scheduleRevision: transition.writes.scheduleRevision,
      scheduleActivatedAt: transition.writes.scheduleActivatedAt,
      lastScheduledAt: null,
      updatedAt: nowIso,
    },
  };
}

// ---- v1 final report decision + write-plan (ADR-009 决策 6/7/8) ----

/** Stable run-failure classification when a structurally legal v1 success
 *  report violates terminal policy on a live v1 lease (ADR-009 决策 7). */
export const TERMINAL_PROTOCOL_INVALID = "terminal_protocol_invalid";

export interface RunTerminalWrites {
  phase: "done" | "error";
  outcome: "exec" | "error";
  status: RunStatus | null;
  message: string | null;
  error: string | null;
  /** This run's terminal state snapshot (null when the command carried none). */
  state: JsonObject | null;
}

/** The Loop write-set of an accepted v1 success report. Keys are PRESENT only
 *  when the corresponding write happens (no partial sync writes, ever). */
export interface LoopV1Writes {
  state?: JsonObject;
  taskFileContent?: string;
  taskFileSyncedAt?: string;
  taskFileSyncAttemptedAt: string;
  taskFileSyncError: TaskFileSyncError | null;
  updatedAt: string;
  /** Completion + schedule fields, present only on a legal finish. */
  completedAt?: string;
  completionReason?: string;
  enabled?: false;
  scheduleRevision?: number;
  scheduleActivatedAt?: null;
  lastScheduledAt?: null;
}

export type ReportWritePlan =
  | {
      /** v0 lease: Phase 3 semantics, terminal/state/sync ignored entirely. */
      kind: "v0";
      runWrites: Partial<NewRun>;
      loopWrites: null;
      deleteLease: true;
    }
  | {
      /** v1 ok=false: the old failure finalize; every Loop field untouched. */
      kind: "v1_failure";
      runWrites: Partial<NewRun>;
      loopWrites: null;
      deleteLease: true;
    }
  | {
      kind: "v1_success" | "v1_finish";
      runWrites: Partial<Omit<NewRun, "state">> & RunTerminalWrites;
      loopWrites: LoopV1Writes;
      deleteLease: true;
    }
  | {
      /** Structurally legal but policy-invalid v1 success → stable run failure,
       *  zero Loop writes, lease consumed. */
      kind: "terminal_protocol_invalid";
      runWrites: Partial<NewRun>;
      loopWrites: null;
      deleteLease: true;
    }
  | {
      /** A finish that failed eligibility → stable run failure with the fixed
       *  classification, zero Loop writes, lease consumed. */
      kind: "finish_rejected";
      classification: FinishClassification;
      runWrites: Partial<NewRun>;
      loopWrites: null;
      deleteLease: true;
    };

export interface ReportPlanInput {
  loop: LoopReportSnapshot;
  lease: LeaseAuthSnapshot;
  /** The run being finalized (the Phase 3 builder reads its message fallback). */
  run: Run;
  /** The PARSED wire body (schema-valid at the HTTP boundary already). */
  body: ReportRequest;
  nowIso: string;
}

/** A stable run failure with the classification as its error — the consumed
 *  report shape for terminal_protocol_invalid and rejected finishes. The wire
 *  response stays the ordinary finalize ack (ADR-009 决策 8). */
function stableRunFailure(
  run: Run,
  classification: string,
  nowIso: string,
): { runWrites: Partial<NewRun>; loopWrites: null; deleteLease: true } {
  return {
    runWrites: buildReportWriteSet({ ok: false, error: classification }, run, nowIso),
    loopWrites: null,
    deleteLease: true,
  };
}

/**
 * The v1/v0 report decision as a pure write-plan (ADR-009 决策 8). Batch 2
 * executes the returned plan inside the existing report transaction; nothing
 * here touches a database. Construction order is evaluation order: EVERY
 * guard runs before any plan object exists, so a failing step can never leave
 * a partially-constructed (partially committable) plan.
 */
export function planReportWrites(input: ReportPlanInput): ReportWritePlan {
  const { loop, lease, run, body, nowIso } = input;

  // v0 lease: unconditionally Phase 3 — even a request carrying terminal.
  // (A lease version that is neither 0 nor 1 is corrupt data: fail closed
  // into the stable-invalid classification rather than guessing semantics.)
  if (lease.terminalProtocolVersion === 0) {
    return { kind: "v0", runWrites: buildReportWriteSet(body, run, nowIso), loopWrites: null, deleteLease: true };
  }
  if (lease.terminalProtocolVersion !== 1) {
    return { kind: "terminal_protocol_invalid", ...stableRunFailure(run, TERMINAL_PROTOCOL_INVALID, nowIso) };
  }

  // v1 failure: the old failure收口 — terminal/state/sync extensions ignored.
  if (!body.ok) {
    return { kind: "v1_failure", runWrites: buildReportWriteSet(body, run, nowIso), loopWrites: null, deleteLease: true };
  }

  // v1 success: terminal command is mandatory and must pass policy.
  const terminal = body.terminal;
  if (terminal === undefined) {
    return { kind: "terminal_protocol_invalid", ...stableRunFailure(run, TERMINAL_PROTOCOL_INVALID, nowIso) };
  }
  const textCheck =
    terminal.kind === "finish"
      ? validateFinishReason(terminal.reason)
      : terminal.message !== undefined
        ? validateTerminalMessage(terminal.message)
        : { ok: true as const };
  if (!textCheck.ok) {
    return { kind: "terminal_protocol_invalid", ...stableRunFailure(run, TERMINAL_PROTOCOL_INVALID, nowIso) };
  }
  if (terminal.state !== undefined && !validateTerminalState(terminal.state).ok) {
    return { kind: "terminal_protocol_invalid", ...stableRunFailure(run, TERMINAL_PROTOCOL_INVALID, nowIso) };
  }
  if (
    !validateTaskFileSyncResult({
      taskFileContent: body.taskFileContent,
      taskFileSyncError: body.taskFileSyncError,
    }).ok
  ) {
    return { kind: "terminal_protocol_invalid", ...stableRunFailure(run, TERMINAL_PROTOCOL_INVALID, nowIso) };
  }

  // Finish runs the fixed eligibility order BEFORE any Loop write is planned.
  let completion: CompletionWrites | null = null;
  if (terminal.kind === "finish") {
    const finish = planFinish(loop, lease, terminal.reason, nowIso);
    if (finish.kind === "rejected") {
      return {
        kind: "finish_rejected",
        classification: finish.classification,
        ...stableRunFailure(run, finish.classification, nowIso),
      };
    }
    completion = finish.writes;
  }

  // All guards passed — assemble the full write-plan (atomically executed by
  // the Batch 2 transaction; T7 pins that no partial plan can exist).
  const message =
    terminal.kind === "finish"
      ? (terminal.message ?? terminal.reason)
      : (terminal.message ?? null);
  const status: RunStatus = terminal.kind === "finish" ? "resolved" : terminal.status;

  const runWrites: Partial<Omit<NewRun, "state">> & RunTerminalWrites = {
    ...buildReportWriteSet(body, run, nowIso),
    phase: "done",
    outcome: "exec",
    status,
    message,
    error: null,
    state: terminal.state ?? null,
  };

  const loopWrites: LoopV1Writes = {
    ...(terminal.state !== undefined ? { state: terminal.state } : {}),
    ...(body.taskFileContent !== undefined
      ? { taskFileContent: body.taskFileContent, taskFileSyncedAt: nowIso }
      : {}),
    taskFileSyncAttemptedAt: nowIso,
    taskFileSyncError: body.taskFileSyncError ?? null,
    updatedAt: nowIso,
    ...(completion ?? {}),
  };

  return {
    kind: terminal.kind === "finish" ? "v1_finish" : "v1_success",
    runWrites,
    loopWrites,
    deleteLease: true,
  };
}
