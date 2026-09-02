/**
 * The LifecycleAdmin narrow interface (review STD-2): the command-side
 * lifecycle surface the HTTP adapter consumes — goal, task-file retarget,
 * reopen — as THREE methods over a closed deps object, mirroring the
 * RunCoordinator/LoopAdmin/OwnerControl precedent (the store, the clock and
 * the retry discipline live INSIDE; the route layer only maps result unions
 * to status codes). Deliberately separate from LoopAdmin: that is the
 * read/observation surface; these are commands with their own evolution
 * rate.
 */
import {
  reopenLoop,
  updateGoal,
  updateTaskFile,
  type LifecycleOpsDeps,
  type ReopenLoopResult,
  type UpdateGoalResult,
  type UpdateTaskFileResult,
} from "./ops.js";

/** The narrow lifecycle-command surface (review STD-2) — see the module
 *  header. `LifecycleOpsDeps` (db/clock/hooks) is re-exported so assemblers
 *  and tests never import the ops module directly. */
export interface LifecycleAdmin {
  updateGoal(loopId: string, command: { goal: string | null }): Promise<UpdateGoalResult>;
  updateTaskFile(loopId: string, taskFile: string): Promise<UpdateTaskFileResult>;
  reopenLoop(loopId: string): Promise<ReopenLoopResult>;
}

export type LifecycleAdminDeps = LifecycleOpsDeps;

/** The TEST-ONLY interleaving seam, re-exported so assemblers (start.ts)
 *  and race tests never import the ops module directly. */
export type { LifecycleOpsHooks } from "./ops.js";

export function createLifecycleAdmin(deps: LifecycleOpsDeps): LifecycleAdmin {
  return {
    updateGoal: (loopId, command) => updateGoal(deps, loopId, command),
    updateTaskFile: (loopId, taskFile) => updateTaskFile(deps, loopId, taskFile),
    reopenLoop: (loopId) => reopenLoop(deps, loopId),
  };
}
