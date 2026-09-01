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
