/**
 * The Runner seam (plan §3) — the minimal interface between the daemon's
 * orchestration layer and whatever executes a Delivery. The Runner returns
 * everything EXCEPT `runId`: the daemon's orchestration layer owns run
 * identity and writes `delivery.runId` unconditionally, so a Runner can never
 * report against the wrong run.
 *
 * Phase 2 batch 3 (plan §2.1) widens the seam from a bare AbortSignal to a
 * RunnerContext: the signal (shutdown/abort, unchanged) plus `onProgress`, a
 * RUNTIME-OWNED sink for runner-emitted progress labels. The runtime — never
 * the Runner — sanitizes each label and increments the run's step; the Runner
 * cannot set the step, replace the label of another run, or emit progress for
 * a run that has settled (late callbacks are ignored by the sink).
 *
 * The Fake Runner proves the Day-5 loop end to end with a deterministic
 * success: no filesystem, no child process, no interpretation of
 * task/workflow/workdir/runToken, and NO progress events (the batch-3
 * signature change is behavior-neutral for it). Its `outcome: "exec"` is
 * WIRE-COMPAT only — Phase 1's persisted `done/exec` comes from the server's
 * write rule (the daemon-claimed outcome is never persisted), so integration
 * assertions must not assume the daemon's claim lands.
 */
import type { Delivery, ReportRequest } from "@loopzhb/protocol";

export type RunnerReport = Omit<ReportRequest, "runId">;

/** The runtime-provided execution context for one run. */
export interface RunnerContext {
  /** Aborts on daemon shutdown; runners that spawn processes must wire it to
   *  their termination path (the Claude adapter feeds it to spawnWithTimeout). */
  signal: AbortSignal;
  /** Emit a free-form progress label for THIS run. The runtime strips NULs,
   *  collapses whitespace to a single line, caps the length, and increments
   *  the run's step per accepted event. Calls after the runner settled are
   *  ignored — runners do not need to tear down emitters defensively. */
  onProgress(label: string): void;
}

export interface AgentRunner {
  run(delivery: Delivery, context: RunnerContext): Promise<RunnerReport>;
}

export const FAKE_RUNNER_MESSAGE = "fake runner completed";

export function createFakeRunner(): AgentRunner {
  return {
    run(delivery: Delivery, _context: RunnerContext): Promise<RunnerReport> {
      // Phase 4 Batch 2: a v1 delivery's success report must carry a terminal
      // command and exactly one task-file sync result (the fake reads no files
      // and honestly reports the sync as missing). v0 deliveries keep the
      // byte-identical Phase 3 report.
      if (delivery.terminalProtocol === 1) {
        return Promise.resolve({
          ok: true,
          outcome: "exec",
          durationMs: 0,
          terminal: { kind: "report", status: "resolved", message: FAKE_RUNNER_MESSAGE },
          taskFileSyncError: "missing",
        });
      }
      return Promise.resolve({
        ok: true,
        outcome: "exec",
        message: FAKE_RUNNER_MESSAGE,
        durationMs: 0,
      });
    },
  };
}
