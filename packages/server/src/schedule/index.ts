/**
 * Schedule module — time semantics and configuration state machine for Loop scheduling.
 *
 * Phase 3 Batch 1: Foundation only (no Scheduler, no automatic execution).
 *
 * Public API:
 *  - validateSchedule / nextOccurrence: time computation
 *  - updateSchedule: the ONLY write entry point for schedule configuration
 *  - ScheduleValidationError: thrown on invalid cron/timezone
 *
 * See ADR-007 for the complete contract.
 */

export {
  validateSchedule,
  nextOccurrence,
  latestOccurrence,
  isOccurrence,
  parseRfc3339Ms,
  isCanonicalUtcIso,
  isValidPersistedScheduleState,
  ScheduleValidationError,
  type NormalizedSchedule,
  type PersistedScheduleState,
} from "./time-semantics.js";

export {
  updateSchedule,
  ScheduleRevisionExhaustedError,
  type SchedulePatch,
  type UpdateScheduleResult,
  type ScheduleStateMachineDeps,
} from "./state-machine.js";

export {
  planScheduleTransition,
  isScheduleNoOp,
  REVISION_INT32_MAX,
  type ScheduleCoreState,
  type ScheduleCoreWrites,
  type ScheduleTransitionPatch,
  type ScheduleTransitionResult,
} from "./transition.js";

/**
 * The ScheduleAdmin narrow interface (review STD-2): the command-side
 * schedule surface the HTTP adapter consumes — the ONLY write entry point
 * wrapped as a one-method object over closed deps, mirroring the
 * RunCoordinator/LoopAdmin/OwnerControl precedent. The store, the clock,
 * validation and the guard-retry discipline live inside; the route layer
 * only maps the result union (and the two thrown error classes) to status
 * codes.
 */
import { updateSchedule as updateScheduleTx } from "./state-machine.js";
import type { SchedulePatch, ScheduleStateMachineDeps, UpdateScheduleResult } from "./state-machine.js";

export interface ScheduleAdmin {
  updateSchedule(loopId: string, patch: SchedulePatch): Promise<UpdateScheduleResult>;
}

export function createScheduleAdmin(deps: ScheduleStateMachineDeps): ScheduleAdmin {
  return {
    updateSchedule: (loopId, patch) => updateScheduleTx(deps, loopId, patch),
  };
}
