/**
 * Schedule configuration state machine — the ONLY write entry point for
 * schedule-related Loop fields.
 *
 * All schedule configuration changes (cron, timezone, enabled) must flow through
 * `updateSchedule`. This function centralizes:
 *  - Validation and normalization
 *  - Revision tracking
 *  - Activation boundary management
 *  - Watermark lifecycle
 *
 * State transition rules (ADR-007 decision 4):
 *  - Empty or semantically-equal patch: zero writes (revision/updatedAt/activation/watermark unchanged)
 *  - Any effective config change: scheduleRevision+1, updatedAt=now, lastScheduledAt=null
 *  - Becomes active (enabled=true && cron!=null): scheduleActivatedAt=now
 *  - Becomes paused or manual-only: scheduleActivatedAt=null
 *  - Pause preserves cron/timezone; clear-cron preserves enabled/timezone
 *  - Re-enable establishes new activation boundary; does NOT backfill paused occurrences
 *  - Loop not found: {found: false}, no writes
 *  - Validation/DB error: full rollback
 *
 * Invariants:
 *  - next_run_at remains null (write-closed in Phase 3)
 *  - No Run records are ever created by this function
 *  - Batch 2 management API MUST use this entry point, not reimplement logic
 *
 * See ADR-007 for the complete state-machine contract.
 *
 * Phase 4 Batch 1: the revision/activation/watermark computation lives in the
 * pure core `./transition.ts` (ADR-009 决策 5) — this adapter keeps the DB
 * transaction, the Clock, and cron/timezone validation, and the core computes
 * the patch. Phase 3 behavior is unchanged (parity-pinned by the C-group and
 * the D9 equivalence tests).
 */

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/index.js";
import type { Loop } from "../db/schema.js";
import { loops } from "../db/schema.js";
import { withGuardRetry } from "../store/guard-retry.js";
import type { Clock } from "../time.js";
import { validateSchedule } from "./time-semantics.js";
import { planScheduleTransition, type ScheduleTransitionPatch } from "./transition.js";

/**
 * Partial schedule configuration update.
 */
export type SchedulePatch = ScheduleTransitionPatch;

/** Thrown when scheduleRevision reached the PostgreSQL int32 ceiling — the
 *  pure core refuses the transition with zero writes (ADR-009 决策 4). Batch 2
 *  maps this to a stable HTTP conflict at the management routes; it must never
 *  surface as a database overflow 500. */
export class ScheduleRevisionExhaustedError extends Error {
  constructor(readonly loopId: string) {
    super(`schedule revision exhausted for loop ${loopId}`);
    this.name = "ScheduleRevisionExhaustedError";
  }
}

/** The guarded schedule write observed zero rows — a competitor committed
 *  between the authoritative resolve and the write (review SPEC-3: this write
 *  previously had NO guard at all). Rolls back; the shared retry re-runs
 *  once on fresh state. */
class ScheduleGuardLostError extends Error {
  constructor(readonly loopId: string) {
    super(`schedule guard lost for loop ${loopId}`);
    this.name = "ScheduleGuardLostError";
  }
}

/** The schedule guard lost AGAIN on the single bounded re-resolve — surfaces
 *  as a retryable 500; no partial state was ever committed. */
export class ScheduleRaceLostError extends Error {
  constructor(readonly loopId: string) {
    super(`schedule guard did not settle for loop ${loopId}`);
    this.name = "ScheduleRaceLostError";
  }
}

/**
 * Result of a schedule update attempt. The `conflict: "loop_completed"`
 * variant is the Phase 4 guard: a Completed loop's cron/timezone stay
 * editable (it remains paused either way), but re-enabling it is refused —
 * only Reopen restores scheduling (ADR-009 决策 10: mapped to 409
 * `loop_completed` at the route). It carries `changed: false` and the
 * untouched row so callers that only narrow on found/changed keep compiling
 * and behave exactly like a no-op; the route checks `conflict` FIRST.
 */
export type UpdateScheduleResult =
  | { found: false }
  | { found: true; conflict: "loop_completed"; changed: false; loop: Loop }
  | { found: true; changed: false; loop: Loop }
  | { found: true; changed: true; loop: Loop };

/**
 * Dependencies for the state machine.
 */
export interface ScheduleStateMachineDeps {
  db: Db;
  clock: Clock;
  /** TEST-ONLY committed-interleaving seam. The resolved row is protected by
   *  the same revision CAS as production, so a competitor committed here
   *  must make this attempt lose and trigger the bounded fresh re-resolve. */
  hooks?: {
    afterScheduleLoopResolve?(loopId: string): void | Promise<void>;
  };
}

/**
 * Updates a Loop's schedule configuration.
 *
 * This is the ONLY entry point for schedule-related writes. Each attempt
 * resolves and validates one authoritative Loop snapshot, then applies an
 * effective transition in a short `id + revision` CAS transaction. A guard
 * loss rolls that attempt back and triggers one bounded fresh re-resolve;
 * no-op/conflict outcomes verify the same revision before returning.
 *
 * @param deps - Database and clock dependencies
 * @param loopId - Loop identifier
 * @param patch - Partial configuration update
 * @returns Result indicating whether the Loop was found and whether changes were made
 * @throws ScheduleValidationError if cron or timezone is invalid
 */
export async function updateSchedule(
  deps: ScheduleStateMachineDeps,
  loopId: string,
  patch: SchedulePatch,
): Promise<UpdateScheduleResult> {
  return withGuardRetry(
    () => updateScheduleOnce(deps, loopId, patch),
    (err) => err instanceof ScheduleGuardLostError,
    (err) => new ScheduleRaceLostError((err as ScheduleGuardLostError).loopId),
  );
}

async function updateScheduleOnce(
  deps: ScheduleStateMachineDeps,
  loopId: string,
  patch: SchedulePatch,
): Promise<UpdateScheduleResult> {
  // Resolve before the short write transaction, matching claim/enqueue's OCC
  // discipline. The id+revision CAS below makes every decision from this row
  // conditional on it remaining authoritative.
  const [currentLoop] = await deps.db.select().from(loops).where(eq(loops.id, loopId)).limit(1);

  if (!currentLoop) {
    return { found: false };
  }
  await deps.hooks?.afterScheduleLoopResolve?.(loopId);

  // A zero-write outcome still needs a linearization point: verify the
  // observed revision immediately before returning. If a competitor changed
  // the row after resolve, retry and reclassify against the fresh state.
  const verifyUnchanged = async (): Promise<void> => {
    const [sameRevision] = await deps.db
      .select({ id: loops.id })
      .from(loops)
      .where(and(eq(loops.id, loopId), eq(loops.revision, currentLoop.revision)))
      .limit(1);
    if (!sameRevision) throw new ScheduleGuardLostError(loopId);
  };

  // Phase 4 Completed guard: only Reopen may re-enable a Completed loop.
  if (currentLoop.completedAt !== null && patch.enabled === true) {
    await verifyUnchanged();
    return { found: true, conflict: "loop_completed", changed: false, loop: currentLoop };
  }

  // 2. Validate raw values before semantic no-op comparison, then normalize
  // through the shared time-semantics entry point so field limits and syntax
  // have one owner.
  const normalizedPatch = normalizeAndValidatePatch(currentLoop, patch);

  // 3. The pure core decides: noop (zero writes), exhausted (zero writes +
  // stable signal), or the revision/activation/watermark patch.
  const nowIso = deps.clock.now().toISOString();
  const transition = planScheduleTransition(currentLoop, normalizedPatch, nowIso);
  if (transition.kind === "noop") {
    await verifyUnchanged();
    return { found: true, changed: false, loop: currentLoop };
  }
  if (transition.kind === "schedule_revision_exhausted") {
    await verifyUnchanged();
    throw new ScheduleRevisionExhaustedError(loopId);
  }

  // 4. Validate final configuration (cron and timezone semantics)
  const finalCron = normalizedPatch.cron !== undefined ? normalizedPatch.cron : currentLoop.cron;
  const finalTimezone = normalizedPatch.timezone !== undefined ? normalizedPatch.timezone : currentLoop.timezone;

  // Always validate cron and timezone together when either changes OR when timezone changes for manual-only
  // This prevents manual-only loops from persisting invalid timezones
  if (finalCron !== null) {
    // Scheduled loop: validate both cron and timezone
    validateSchedule(finalCron, finalTimezone);
  } else if (normalizedPatch.timezone !== undefined) {
    // Manual-only loop with timezone change: validate timezone alone
    // We validate with a dummy cron to check timezone validity
    validateSchedule("0 0 * * *", finalTimezone);
  }

  // 5. Apply the core-computed patch in a short write transaction — guarded
  // on the revision the authoritative resolve observed (review SPEC-3): any
  // competing loops write (retarget, finish, callback watermark, claim bump,
  // …) committed between resolve and here loses the guard, and the shared
  // retry re-plans from the fresh row. The bump keeps the unified invariant:
  // EVERY loops write increments it.
  return deps.db.transaction(async (tx) => {
    const [updatedLoop] = await tx
      .update(loops)
      .set({ ...transition.writes, revision: sql`${loops.revision} + 1` })
      .where(and(eq(loops.id, loopId), eq(loops.revision, currentLoop.revision)))
      .returning();

    if (!updatedLoop) {
      throw new ScheduleGuardLostError(loopId);
    }

    return { found: true, changed: true, loop: updatedLoop };
  });
}

/**
 * Normalizes a patch by applying validation and whitespace normalization
 * to cron and timezone fields.
 */
function normalizeAndValidatePatch(currentLoop: Loop, patch: SchedulePatch): SchedulePatch {
  const normalized: SchedulePatch = {};
  const changesCron = patch.cron !== undefined;
  const changesTimezone = patch.timezone !== undefined;

  let normalizedSchedule: ReturnType<typeof validateSchedule> | null = null;
  if (changesCron || changesTimezone) {
    const candidateCron = changesCron ? patch.cron : currentLoop.cron;
    const candidateTimezone = changesTimezone ? patch.timezone! : currentLoop.timezone;

    // Manual-only schedules still carry a real timezone. A fixed dummy cron
    // lets the shared validator normalize and validate that timezone without
    // inventing a second timezone-only ruleset.
    normalizedSchedule = validateSchedule(candidateCron ?? "0 0 * * *", candidateTimezone);
  }

  if (patch.cron !== undefined) {
    if (patch.cron === null) {
      // Explicit null = clear to manual-only
      normalized.cron = null;
    } else {
      normalized.cron = normalizedSchedule!.cron;
    }
  }

  if (patch.timezone !== undefined) {
    normalized.timezone = normalizedSchedule!.timezone;
  }

  if (patch.enabled !== undefined) {
    normalized.enabled = patch.enabled;
  }

  return normalized;
}
