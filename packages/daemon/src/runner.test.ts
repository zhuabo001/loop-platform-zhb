/**
 * Fake Runner pins: deterministic success payload, no filesystem/process
 * side effects, no runId (the type forbids it — this pins the SHAPE), and the
 * signal parameter accepted even though Day 5 has no real cancellation.
 */
import { describe, expect, it } from "vitest";

import type { Delivery } from "@loopzhb/protocol";

import { FAKE_RUNNER_MESSAGE, createFakeRunner, type RunnerContext } from "./runner.js";

const DELIVERY: Delivery = {
  runId: "run-1",
  runToken: "rk_tok_run-1",
  role: "exec",
  loop: { id: "loop-1", name: "Loop", workdir: null, taskFile: null, workflow: null, model: null, allowControl: false },
  prevState: null,
  roots: [],
  systemPrompt: "",
  task: "do it",
};

function testCtx(): RunnerContext {
  return { signal: new AbortController().signal, onProgress: () => {} };
}

describe("createFakeRunner", () => {
  it("returns the deterministic success report for any delivery", async () => {
    const runner = createFakeRunner();
    const a = await runner.run(DELIVERY, testCtx());
    const b = await runner.run({ ...DELIVERY, runId: "run-2", task: "different" }, testCtx());
    expect(a).toEqual({ ok: true, outcome: "exec", message: FAKE_RUNNER_MESSAGE, durationMs: 0 });
    expect(a).toEqual(b);
    expect(a).not.toHaveProperty("runId");
  });

  it("touches neither the filesystem nor child processes", async () => {
    // The implementation is a pure literal — this test pins the absence of
    // side-effect APIs on the seam (a real AgentRunner replaces it in Phase 2).
    const runner = createFakeRunner();
    await expect(runner.run(DELIVERY, testCtx())).resolves.toBeDefined();
  });

  it("adapts to the RunnerContext seam WITHOUT emitting progress — signature-only change, behavior pinned", async () => {
    const runner = createFakeRunner();
    let progressed = 0;
    const report = await runner.run(DELIVERY, {
      signal: new AbortController().signal,
      onProgress: () => {
        progressed += 1;
      },
    });
    expect(report.ok).toBe(true);
    expect(progressed).toBe(0);
  });
});
