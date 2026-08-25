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
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import type { Loop } from "../db/schema.js";
import { loops } from "../db/schema.js";
import type { Clock } from "../time.js";
import { ScheduleValidationError, validateSchedule } from "./time-semantics.js";

/**
 * Partial schedule configuration update.
 */
export interface SchedulePatch {
  /** Cron expression (null = clear to manual-only, undefined = no change). */
  cron?: string | null;
  /** IANA timezone (undefined = no change). */
  timezone?: string;
  /** Enabled flag (undefined = no change). */
  enabled?: boolean;
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

    // 2. Validate patch values BEFORE normalization (length checks, basic format)
    if (patch.cron !== undefined && patch.cron !== null) {
      if (patch.cron.length > 255) {
        throw new ScheduleValidationError("cron", "cron must not exceed 255 characters");
      }
      if (patch.cron.includes("\0")) {
        throw new ScheduleValidationError("cron", "cron must not contain NUL character");
      }
    }

    if (patch.timezone !== undefined) {
      if (patch.timezone.length > 255) {
        throw new ScheduleValidationError("timezone", "timezone must not exceed 255 characters");
      }
      if (patch.timezone.includes("\0")) {
        throw new ScheduleValidationError("timezone", "timezone must not contain NUL character");
      }
    }

    // 3. Normalize the patch
    const normalizedPatch = normalizePatch(currentLoop, patch);

    // 4. Check if this is semantically a no-op
    if (isNoOp(currentLoop, normalizedPatch)) {
      return { found: true, changed: false, loop: currentLoop };
    }

    // 5. Validate final configuration (cron and timezone semantics)
    const finalCron = normalizedPatch.cron !== undefined ? normalizedPatch.cron : currentLoop.cron;
    const finalTimezone = normalizedPatch.timezone !== undefined ? normalizedPatch.timezone : currentLoop.timezone;
    const finalEnabled = normalizedPatch.enabled !== undefined ? normalizedPatch.enabled : currentLoop.enabled;

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

    // 5. Calculate new state
    const now = deps.clock.now();
    const nowIso = now.toISOString();

    // Increment revision on any effective change
    const newRevision = currentLoop.scheduleRevision + 1;

    // Clear watermark on any config change
    const newLastScheduledAt = null;

    // Set activation timestamp if becoming active, clear if becoming inactive
    const isActive = finalEnabled && finalCron !== null;
    const newScheduleActivatedAt = isActive ? nowIso : null;

    // 6. Apply the update
    const updates: Partial<Loop> = {
      scheduleRevision: newRevision,
      updatedAt: nowIso,
      lastScheduledAt: newLastScheduledAt,
      scheduleActivatedAt: newScheduleActivatedAt,
    };

    if (normalizedPatch.cron !== undefined) {
      updates.cron = normalizedPatch.cron;
    }
    if (normalizedPatch.timezone !== undefined) {
      updates.timezone = normalizedPatch.timezone;
    }
    if (normalizedPatch.enabled !== undefined) {
      updates.enabled = normalizedPatch.enabled;
    }

    const [updatedLoop] = await tx.update(loops).set(updates).where(eq(loops.id, loopId)).returning();

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
function normalizePatch(currentLoop: Loop, patch: SchedulePatch): SchedulePatch {
  const normalized: SchedulePatch = {};

  if (patch.cron !== undefined) {
    if (patch.cron === null) {
      // Explicit null = clear to manual-only
      normalized.cron = null;
    } else {
      // Normalize whitespace
      normalized.cron = patch.cron.trim().replace(/\s+/g, " ");
    }
  }

  if (patch.timezone !== undefined) {
    normalized.timezone = patch.timezone.trim();
  }

  if (patch.enabled !== undefined) {
    normalized.enabled = patch.enabled;
  }

  return normalized;
}

/**
 * Checks if a normalized patch is semantically a no-op (no effective changes).
 *
 * A patch is a no-op if:
 *  - It's empty (no fields specified), OR
 *  - All specified fields are semantically equal to current values
 */
function isNoOp(currentLoop: Loop, normalizedPatch: SchedulePatch): boolean {
  // Empty patch is a no-op
  if (
    normalizedPatch.cron === undefined &&
    normalizedPatch.timezone === undefined &&
    normalizedPatch.enabled === undefined
  ) {
    return true;
  }

  // Check each field for semantic equality
  if (normalizedPatch.cron !== undefined) {
    if (normalizedPatch.cron !== currentLoop.cron) {
      return false;
    }
  }

  if (normalizedPatch.timezone !== undefined) {
    if (normalizedPatch.timezone !== currentLoop.timezone) {
      return false;
    }
  }

  if (normalizedPatch.enabled !== undefined) {
    if (normalizedPatch.enabled !== currentLoop.enabled) {
      return false;
    }
  }

  // All specified fields are equal
  return true;
}
