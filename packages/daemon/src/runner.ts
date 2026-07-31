/**
 * The Runner seam (plan §3) — the minimal interface the Phase 2 real
 * AgentRunner will replace. The Runner returns everything EXCEPT `runId`:
 * the daemon's orchestration layer owns run identity and writes
 * `delivery.runId` unconditionally, so a Runner can never report against the
 * wrong run.
 *
 * The Fake Runner proves the Day-5 loop end to end with a deterministic
 * success: no filesystem, no child process, no interpretation of
 * task/workflow/workdir/runToken. Its `outcome: "exec"` is WIRE-COMPAT only —
 * Phase 1's persisted `done/exec` comes from the server's write rule (the
 * daemon-claimed outcome is never persisted), so integration assertions must
 * not assume the daemon's claim lands.
 */
import type { Delivery, ReportRequest } from "@loopzhb/protocol";

export type RunnerReport = Omit<ReportRequest, "runId">;

export interface AgentRunner {
  run(delivery: Delivery, signal: AbortSignal): Promise<RunnerReport>;
}

export const FAKE_RUNNER_MESSAGE = "fake runner completed";

export function createFakeRunner(): AgentRunner {
  return {
    run(_delivery: Delivery, _signal: AbortSignal): Promise<RunnerReport> {
      return Promise.resolve({
        ok: true,
        outcome: "exec",
        message: FAKE_RUNNER_MESSAGE,
        durationMs: 0,
      });
    },
  };
}
