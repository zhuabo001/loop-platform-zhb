/**
 * Schedule transition PURE CORE (ADR-009 决策 5) — the single computation of
 * revision / activation / watermark patches for every schedule-relevant Loop
 * transition.
 *
 * Extracted from `state-machine.ts` so that Phase 4 Reopen computes the SAME
 * patch as a schedule PATCH and the two can never drift. This module is pure:
 * no I/O, no clock (the caller supplies `nowIso`), no validation of cron or
 * timezone syntax (the caller validates through `time-semantics.ts` and hands
 * over a NORMALIZED patch).
 *
 * Transition rules (ADR-007 决策 4, unchanged by the extraction):
 *  - empty or semantically-equal patch → noop, zero writes
 *  - any effective change → scheduleRevision+1, updatedAt=now, lastScheduledAt=null
 *  - active (enabled && cron!=null) → scheduleActivatedAt=now, else null
 *
 * Revision exhaustion (ADR-009 决策 4): at the PostgreSQL int32 ceiling the
 * core returns `schedule_revision_exhausted` with ZERO writes — the DB error
 * path must never be the behavior. Batch 2 maps this to a stable HTTP
 * conflict at the management routes; the Finish path folds it into
 * `invalid_loop_state`.
 */

/** PostgreSQL int32 upper bound — scheduleRevision/goalRevision live in
 *  `integer` columns and may never overflow or wrap. */
export const REVISION_INT32_MAX = 2_147_483_647;

/** The schedule-relevant slice of a Loop row the core needs. */
export interface ScheduleCoreState {
  cron: string | null;
  timezone: string;
  enabled: boolean;
  scheduleRevision: number;
}

/** A NORMALIZED schedule patch (cron/timezone already validated). */
export interface ScheduleTransitionPatch {
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
}

/** The Loop write-set an effective transition produces. */
export interface ScheduleCoreWrites {
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
  scheduleRevision: number;
  scheduleActivatedAt: string | null;
  lastScheduledAt: null;
  updatedAt: string;
}

export type ScheduleTransitionResult =
  | { kind: "noop" }
  | { kind: "schedule_revision_exhausted" }
  | { kind: "changed"; writes: ScheduleCoreWrites };

/** True when every specified field equals the current value (or nothing is
 *  specified at all). */
export function isScheduleNoOp(current: ScheduleCoreState, patch: ScheduleTransitionPatch): boolean {
  if (patch.cron !== undefined && patch.cron !== current.cron) return false;
  if (patch.timezone !== undefined && patch.timezone !== current.timezone) return false;
  if (patch.enabled !== undefined && patch.enabled !== current.enabled) return false;
  return true;
}

/**
 * Compute the Loop writes for a normalized schedule patch. Deterministic and
 * total: every input maps to exactly one of noop / exhausted / changed.
 */
export function planScheduleTransition(
  current: ScheduleCoreState,
  patch: ScheduleTransitionPatch,
  nowIso: string,
): ScheduleTransitionResult {
  if (isScheduleNoOp(current, patch)) return { kind: "noop" };
  if (current.scheduleRevision >= REVISION_INT32_MAX) return { kind: "schedule_revision_exhausted" };

  const finalCron = patch.cron !== undefined ? patch.cron : current.cron;
  const finalEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  const isActive = finalEnabled && finalCron !== null;

  const writes: ScheduleCoreWrites = {
    scheduleRevision: current.scheduleRevision + 1,
    scheduleActivatedAt: isActive ? nowIso : null,
    lastScheduledAt: null,
    updatedAt: nowIso,
  };
  if (patch.cron !== undefined) writes.cron = patch.cron;
  if (patch.timezone !== undefined) writes.timezone = patch.timezone;
  if (patch.enabled !== undefined) writes.enabled = patch.enabled;
  return { kind: "changed", writes };
}
