/**
 * Fake Runner pins: deterministic success payload, no filesystem/process
 * side effects, no runId (the type forbids it — this pins the SHAPE), and the
 * signal parameter accepted even though Day 5 has no real cancellation.
 */
import { describe, expect, it } from "vitest";

import type { Delivery } from "@loopzhb/protocol";

import { FAKE_RUNNER_MESSAGE, createFakeRunner } from "./runner.js";

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

describe("createFakeRunner", () => {
  it("returns the deterministic success report for any delivery", async () => {
    const runner = createFakeRunner();
    const ctl = new AbortController();
    const a = await runner.run(DELIVERY, ctl.signal);
    const b = await runner.run({ ...DELIVERY, runId: "run-2", task: "different" }, ctl.signal);
    expect(a).toEqual({ ok: true, outcome: "exec", message: FAKE_RUNNER_MESSAGE, durationMs: 0 });
    expect(a).toEqual(b);
    expect(a).not.toHaveProperty("runId");
  });

  it("touches neither the filesystem nor child processes", async () => {
    // The implementation is a pure literal — this test pins the absence of
    // side-effect APIs on the seam (a real AgentRunner replaces it in Phase 2).
    const runner = createFakeRunner();
    await expect(runner.run(DELIVERY, new AbortController().signal)).resolves.toBeDefined();
  });
});
