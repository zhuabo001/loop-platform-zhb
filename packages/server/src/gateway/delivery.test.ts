/**
 * buildExecTask / buildDelivery — the Delivery content contract (A-07):
 * `systemPrompt` is EXACTLY ""; the task is one of two minimal one-pass
 * templates (with / without taskFile), every interpolated value JSON-encoded
 * so hostile names can't break the line structure, and no capability the
 * Phase 1 server doesn't honor is advertised.
 */
import { describe, expect, it } from "vitest";

import { deliverySchema } from "@loopzhb/protocol";

import type { Loop, Run } from "../db/schema.js";
import { buildDelivery, buildExecTask } from "./delivery.js";

const loopBase: Loop = {
  id: "loop_01",
  machineId: "m-test",
  name: "react-doctor",
  workdir: "/home/dev/project",
  taskFile: "/home/dev/project/loops/react-doctor/README.md",
  taskFileContent: null,
  taskFileSyncedAt: null,
  workflow: null,
  model: null,
  allowControl: true,
  agent: "claude-code",
  enabled: true,
  state: null,
  cron: null,
  timezone: "UTC",
  nextRunAt: null,
  scheduleRevision: 0,
  scheduleActivatedAt: null,
  lastScheduledAt: null,
  goal: null,
  goalRevision: 0,
  completedAt: null,
  completionReason: null,
  taskFileSyncAttemptedAt: null,
  taskFileSyncError: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const runBase: Run = {
  id: "run-1",
  loopId: "loop_01",
  machineId: "m-test",
  phase: "running",
  role: "exec",
  ts: "2026-07-01T00:00:00.000Z",
  outcome: null,
  status: null,
  message: null,
  durationMs: null,
  error: null,
  state: null,
  sessionId: null,
  costUsd: null,
  usage: null,
  artifacts: null,
  transcript: null,
  progress: null,
};

describe("buildExecTask", () => {
  it("renders the with-taskFile template exactly (A-07)", () => {
    expect(buildExecTask(loopBase)).toBe(
      [
        "[loop run]",
        'Loop id: "loop_01"',
        'Loop name: "react-doctor"',
        'Read the task file first: "/home/dev/project/loops/react-doctor/README.md"',
        "Do the work it describes.",
        "Run once, then stop.",
      ].join("\n"),
    );
  });

  it("renders the no-taskFile template exactly (A-07)", () => {
    expect(buildExecTask({ ...loopBase, taskFile: null })).toBe(
      [
        "[loop run]",
        'Loop id: "loop_01"',
        'Loop name: "react-doctor"',
        "No task file is configured; this delivery has no real-agent task source.",
        "Run once, then stop.",
      ].join("\n"),
    );
  });

  it("falls back to the loop id for the display name when name is null", () => {
    const task = buildExecTask({ ...loopBase, name: null });
    expect(task).toContain('Loop name: "loop_01"');
  });

  it("JSON-encodes hostile values so they cannot break the template's line structure", () => {
    const task = buildExecTask({
      ...loopBase,
      id: 'loop_"evil"\ninject',
      name: "na`me\nwith\nnewlines",
      taskFile: '/tmp/x"\nrun --other',
    });
    // Every value rides JSON string encoding: embedded newlines/quotes stay
    // escaped inside their single template line.
    const lines = task.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('Loop id: "loop_\\"evil\\"\\ninject"');
    expect(lines[2]).toBe('Loop name: "na`me\\nwith\\nnewlines"');
    expect(lines[3]).toBe('Read the task file first: "/tmp/x\\"\\nrun --other"');
    expect(task).toContain("Run once, then stop.");
  });

  it("never advertises unimplemented in-run verbs or capabilities", () => {
    for (const task of [buildExecTask(loopBase), buildExecTask({ ...loopBase, taskFile: null })]) {
      expect(task).not.toMatch(/loopany|finish|report --|evolve|edit|workflow|artifact|cron/i);
    }
  });
});

describe("buildDelivery", () => {
  it("assembles the full protocol field set and passes deliverySchema", () => {
    const delivery = buildDelivery({ loop: loopBase, run: runBase, roots: ["/home/dev"], runToken: "rk_testcred_1" });
    expect(delivery).toEqual({
      runId: "run-1",
      runToken: "rk_testcred_1",
      role: "exec",
      loop: {
        id: "loop_01",
        name: "react-doctor",
        workdir: "/home/dev/project",
        taskFile: "/home/dev/project/loops/react-doctor/README.md",
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
      },
      prevState: null,
      roots: ["/home/dev"],
      systemPrompt: "",
      task: buildExecTask(loopBase),
    });
    expect(deliverySchema.parse(delivery)).toEqual(delivery);
  });

  it("carries the loop's workflow cursor as prevState (opaque passthrough)", () => {
    const state = { cursor: 3, note: "opaque" };
    const delivery = buildDelivery({ loop: { ...loopBase, state }, run: runBase, roots: [], runToken: "rk_x" });
    expect(delivery.prevState).toEqual(state);
  });

  it("uses the loop id for the DTO name when the friendly name is null/empty", () => {
    for (const name of [null, ""] as const) {
      const delivery = buildDelivery({ loop: { ...loopBase, name }, run: runBase, roots: [], runToken: "rk_x" });
      expect(delivery.loop.name).toBe("loop_01");
    }
  });
});
