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

import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import type { Loop } from "../db/schema.js";
import { loops } from "../db/schema.js";
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

/**
 * Result of a schedule update attempt.
 */
export type UpdateScheduleResult =
  | { found: false }
  | { found: true; changed: false; loop: Loop }
  | { found: true; changed: true; loop: Loop };

/**
 * Dependencies for the state machine.
 */
export interface ScheduleStateMachineDeps {
  db: Db;
  clock: Clock;
}

/**
 * Updates a Loop's schedule configuration.
 *
 * This is the ONLY entry point for schedule-related writes. All validation,
 * normalization, and state transitions happen in one atomic transaction.
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
  return deps.db.transaction(async (tx) => {
    // 1. Re-read the Loop within the transaction
    const [currentLoop] = await tx.select().from(loops).where(eq(loops.id, loopId)).limit(1);

    if (!currentLoop) {
      return { found: false };
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
      return { found: true, changed: false, loop: currentLoop };
    }
    if (transition.kind === "schedule_revision_exhausted") {
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

    // 5. Apply the core-computed patch.
    const [updatedLoop] = await tx.update(loops).set(transition.writes).where(eq(loops.id, loopId)).returning();

    if (!updatedLoop) {
      throw new Error(`Loop ${loopId} disappeared during transaction`);
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
