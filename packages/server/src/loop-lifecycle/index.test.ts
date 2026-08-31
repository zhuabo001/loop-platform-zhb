/**
 * Phase 4 Batch 1 — D group: the pure loop-lifecycle kernel (ADR-009).
 *
 *  D1  goal create/set/change/clear, trim normalization, equal-value noop
 *  D2  blank / NUL / CR / LF / 2000-vs-2001 ASCII bytes / multibyte UTF-8
 *  D3  goalRevision: 0 at creation, +1 per effective change, never reset,
 *      int32 ceiling rejection
 *  D4  primary-status priority + the goal dimension; every corrupt snapshot
 *  D5  completion-triple lockstep, one-to-one with the DB CHECK (M4)
 *  D6  legal finish matrix (Closed exec + canFinish + same revision; Paused
 *      Closed allowed)
 *  D7  the fixed classification order — combined guard failures return only
 *      the first cause
 *  D8  reopen accepts only Completed; preserves goal/revision/state/config;
 *      re-arms activation, clears watermark, never backfills
 *  D10 updatedAt + revision-exhaustion zero-write rules
 */
import { describe, expect, it } from "vitest";

import { REVISION_INT32_MAX } from "../schedule/transition.js";
import {
  classifyLoop,
  isValidLoopSnapshot,
  LoopInvariantViolationError,
  planFinish,
  planGoalUpdate,
  planReopen,
  type LoopLifecycleSnapshot,
} from "./index.js";

const NOW = "2026-08-31T00:00:00.000Z";

function baseLoop(overrides: Partial<LoopLifecycleSnapshot> = {}): LoopLifecycleSnapshot {
  return {
    goal: null,
    goalRevision: 0,
    completedAt: null,
    completionReason: null,
    enabled: true,
    cron: null,
    timezone: "UTC",
    scheduleRevision: 0,
    ...overrides,
  };
}

const EXEC_LEASE = { role: "exec" as const, canFinish: true, goalRevision: 0 };

describe("D1: goal create/set/change/clear plans", () => {
  it("set on an Open loop → changed with normalized goal and revision+1", () => {
    const plan = planGoalUpdate(baseLoop(), { goal: "  triage the queue  " }, NOW);
    expect(plan).toEqual({ kind: "changed", writes: { goal: "triage the queue", goalRevision: 1, updatedAt: NOW } });
  });

  it("change replaces the normalized value and bumps revision again", () => {
    const loop = baseLoop({ goal: "old goal", goalRevision: 1 });
    expect(planGoalUpdate(loop, { goal: "new goal" }, NOW)).toEqual({
      kind: "changed",
      writes: { goal: "new goal", goalRevision: 2, updatedAt: NOW },
    });
  });

  it("clear (null) writes null and bumps revision — never resets it", () => {
    const loop = baseLoop({ goal: "g", goalRevision: 5 });
    expect(planGoalUpdate(loop, { goal: null }, NOW)).toEqual({
      kind: "changed",
      writes: { goal: null, goalRevision: 6, updatedAt: NOW },
    });
  });

  it("clearing an already-Open loop is a noop", () => {
    expect(planGoalUpdate(baseLoop(), { goal: null }, NOW)).toEqual({ kind: "noop" });
  });

  it("equal-after-trim updates are noop (zero writes, zero revision)", () => {
    const loop = baseLoop({ goal: "triage", goalRevision: 3 });
    expect(planGoalUpdate(loop, { goal: "triage" }, NOW)).toEqual({ kind: "noop" });
    expect(planGoalUpdate(loop, { goal: "   triage\t" }, NOW)).toEqual({ kind: "noop" });
  });

  it("a Completed loop's goal is read-only — even an equal-value write conflicts", () => {
    const completed = baseLoop({
      goal: "g",
      goalRevision: 1,
      enabled: false,
      completedAt: NOW,
      completionReason: "done",
    });
    expect(planGoalUpdate(completed, { goal: "other" }, NOW)).toEqual({ kind: "rejected", reason: "loop_completed" });
    expect(planGoalUpdate(completed, { goal: "g" }, NOW)).toEqual({ kind: "rejected", reason: "loop_completed" });
    expect(planGoalUpdate(completed, { goal: null }, NOW)).toEqual({ kind: "rejected", reason: "loop_completed" });
  });
});

describe("D2: goal policy rejections through the plan", () => {
  it("blank after trim → empty", () => {
    expect(planGoalUpdate(baseLoop(), { goal: "   " }, NOW)).toEqual({ kind: "rejected", reason: "empty" });
  });
  it("NUL / CR / LF", () => {
    expect(planGoalUpdate(baseLoop(), { goal: "a\0b" }, NOW)).toEqual({ kind: "rejected", reason: "contains_nul" });
    expect(planGoalUpdate(baseLoop(), { goal: "a\rb" }, NOW)).toEqual({ kind: "rejected", reason: "not_single_line" });
    expect(planGoalUpdate(baseLoop(), { goal: "a\nb" }, NOW)).toEqual({ kind: "rejected", reason: "not_single_line" });
  });
  it("2000 ASCII bytes pass, 2001 fail; multibyte counts in UTF-8 bytes", () => {
    expect(planGoalUpdate(baseLoop(), { goal: "a".repeat(2000) }, NOW).kind).toBe("changed");
    expect(planGoalUpdate(baseLoop(), { goal: "a".repeat(2001) }, NOW)).toEqual({
      kind: "rejected",
      reason: "too_long",
    });
    expect(planGoalUpdate(baseLoop(), { goal: "é".repeat(1000) }, NOW).kind).toBe("changed");
    expect(planGoalUpdate(baseLoop(), { goal: "é".repeat(1001) }, NOW)).toEqual({
      kind: "rejected",
      reason: "too_long",
    });
  });
});

describe("D3: goalRevision counting", () => {
  it("creation revision is 0; each effective change adds exactly 1", () => {
    let loop = baseLoop();
    expect(loop.goalRevision).toBe(0);
    const p1 = planGoalUpdate(loop, { goal: "one" }, NOW);
    if (p1.kind !== "changed") throw new Error("unreachable");
    loop = baseLoop({ goal: p1.writes.goal, goalRevision: p1.writes.goalRevision });
    expect(loop.goalRevision).toBe(1);
    const p2 = planGoalUpdate(loop, { goal: null }, NOW); // clear: still +1
    if (p2.kind !== "changed") throw new Error("unreachable");
    expect(p2.writes.goalRevision).toBe(2);
    // noop does not increment
    expect(planGoalUpdate(baseLoop({ goal: null, goalRevision: 2 }), { goal: null }, NOW)).toEqual({ kind: "noop" });
  });

  it("int32 ceiling rejects without overflow or wrap", () => {
    const loop = baseLoop({ goal: "g", goalRevision: REVISION_INT32_MAX });
    expect(planGoalUpdate(loop, { goal: "other" }, NOW)).toEqual({
      kind: "rejected",
      reason: "goal_revision_exhausted",
    });
    // …but a noop at the ceiling is still a noop (no write needed)
    expect(planGoalUpdate(loop, { goal: "g" }, NOW)).toEqual({ kind: "noop" });
  });
});

describe("D4: primary status priority and the goal dimension", () => {
  it("classifies the four legal shapes by fixed priority", () => {
    expect(classifyLoop(baseLoop())).toBe("open");
    expect(classifyLoop(baseLoop({ goal: "g", goalRevision: 1 }))).toBe("closed");
    // Paused beats Open/Closed — the goal dimension stays readable
    expect(classifyLoop(baseLoop({ enabled: false }))).toBe("paused");
    expect(classifyLoop(baseLoop({ enabled: false, goal: "g", goalRevision: 1 }))).toBe("paused");
    // Completed beats everything
    expect(
      classifyLoop(baseLoop({ enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "r" })),
    ).toBe("completed");
  });

  it("throws fail-closed on every corrupt snapshot", () => {
    const corrupt: Array<[string, LoopLifecycleSnapshot]> = [
      ["completedAt without reason", baseLoop({ enabled: false, goal: "g", completedAt: NOW })],
      ["reason without completedAt", baseLoop({ completionReason: "r" })],
      ["completed without goal", baseLoop({ enabled: false, completedAt: NOW, completionReason: "r" })],
      [
        "completed but enabled",
        baseLoop({ enabled: true, goal: "g", completedAt: NOW, completionReason: "r" }),
      ],
      ["untrimmed persisted goal", baseLoop({ goal: " g", goalRevision: 1 })],
      ["negative goalRevision", baseLoop({ goalRevision: -1 })],
      ["fractional scheduleRevision", baseLoop({ scheduleRevision: 1.5 })],
      ["revision beyond int32", baseLoop({ goalRevision: REVISION_INT32_MAX + 1 })],
    ];
    for (const [name, snapshot] of corrupt) {
      expect(isValidLoopSnapshot(snapshot), name).toBe(false);
      expect(() => classifyLoop(snapshot), name).toThrow(LoopInvariantViolationError);
    }
  });

  it("a persisted completionReason must pass the terminal reason policy", () => {
    const completed = (completionReason: string) =>
      baseLoop({ enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason });
    // Empty, NUL, unpaired surrogate and over-ceiling reasons are NOT legal
    // persisted completions — the write path only stores policy-canonical
    // reasons, so these rows were damaged outside it.
    expect(isValidLoopSnapshot(completed(""))).toBe(false);
    expect(isValidLoopSnapshot(completed("a\0b"))).toBe(false);
    expect(isValidLoopSnapshot(completed("a\uD800b"))).toBe(false);
    expect(isValidLoopSnapshot(completed("x".repeat(2001)))).toBe(false);
    expect(isValidLoopSnapshot(completed("é".repeat(1001)))).toBe(false);
    // …and the exact boundaries stay legal (2000 UTF-8 bytes, newlines kept).
    expect(isValidLoopSnapshot(completed("x".repeat(2000)))).toBe(true);
    expect(isValidLoopSnapshot(completed("é".repeat(1000)))).toBe(true);
    expect(isValidLoopSnapshot(completed("line one\nline two"))).toBe(true);
  });
});

describe("D5: completion-triple lockstep mirrors the DB CHECK (M4)", () => {
  it("accepts exactly the legal combinations", () => {
    expect(isValidLoopSnapshot(baseLoop())).toBe(true); // open
    expect(isValidLoopSnapshot(baseLoop({ goal: "g", goalRevision: 1 }))).toBe(true); // closed
    expect(isValidLoopSnapshot(baseLoop({ enabled: false, goal: "g", goalRevision: 1 }))).toBe(true); // paused closed
    expect(
      isValidLoopSnapshot(baseLoop({ enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "r" })),
    ).toBe(true); // completed
  });

  it("rejects exactly the half-completed combinations the CHECK rejects", () => {
    expect(isValidLoopSnapshot(baseLoop({ completionReason: "r" }))).toBe(false);
    expect(isValidLoopSnapshot(baseLoop({ goal: "g", goalRevision: 1, completedAt: NOW }))).toBe(false);
    expect(isValidLoopSnapshot(baseLoop({ enabled: false, completedAt: NOW, completionReason: "r" }))).toBe(false);
    expect(
      isValidLoopSnapshot(baseLoop({ enabled: true, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "r" })),
    ).toBe(false);
    // …and the reason-policy violations the CHECK cannot express.
    expect(
      isValidLoopSnapshot(baseLoop({ enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "" })),
    ).toBe(false);
    expect(
      isValidLoopSnapshot(
        baseLoop({ enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "a\0b" }),
      ),
    ).toBe(false);
  });
});

describe("D6: legal finish matrix", () => {
  const closed = baseLoop({ goal: "g", goalRevision: 2, cron: "0 3 * * *", scheduleRevision: 4 });
  const lease = { ...EXEC_LEASE, goalRevision: 2 };

  it("Closed + exec + canFinish + matching revision → the full completion patch", () => {
    expect(planFinish(closed, lease, "goal met", NOW)).toEqual({
      kind: "allowed",
      writes: {
        completedAt: NOW,
        completionReason: "goal met",
        enabled: false,
        scheduleRevision: 5,
        scheduleActivatedAt: null,
        lastScheduledAt: null,
        updatedAt: NOW,
      },
    });
  });

  it("a Paused Closed loop's manual exec run may finish (enabled=false is not a rejection)", () => {
    const pausedClosed = baseLoop({ goal: "g", goalRevision: 2, enabled: false, cron: "0 3 * * *" });
    const plan = planFinish(pausedClosed, lease, "done", NOW);
    expect(plan.kind).toBe("allowed");
  });

  it("finish never touches goal/goalRevision/cron/timezone (no keys for them)", () => {
    const plan = planFinish(closed, lease, "goal met", NOW);
    if (plan.kind !== "allowed") throw new Error("unreachable");
    expect(plan.writes).not.toHaveProperty("goal");
    expect(plan.writes).not.toHaveProperty("goalRevision");
    expect(plan.writes).not.toHaveProperty("cron");
    expect(plan.writes).not.toHaveProperty("timezone");
  });
});

describe("D7: the fixed finish classification order returns only the first cause", () => {
  it("invalid_loop_state beats every other guard", () => {
    const corrupt = baseLoop({ goal: "g", completedAt: NOW }); // half-completed
    // also already-completed-ish, also stale revision — still invalid_loop_state
    expect(planFinish(corrupt, { ...EXEC_LEASE, goalRevision: 99 }, "r", NOW)).toEqual({
      kind: "rejected",
      classification: "invalid_loop_state",
    });
  });

  it("already_completed beats role/canFinish/stale guards", () => {
    const completed = baseLoop({
      enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "r",
    });
    expect(planFinish(completed, { role: "evolve", canFinish: false, goalRevision: 99 }, "r", NOW)).toEqual({
      kind: "rejected",
      classification: "already_completed",
    });
  });

  it("finish_not_allowed beats stale_goal — role, canFinish and Open each qualify", () => {
    const closed = baseLoop({ goal: "g", goalRevision: 2 });
    for (const lease of [
      { role: "evolve" as const, canFinish: true, goalRevision: 99 },
      { role: "exec" as const, canFinish: false, goalRevision: 99 },
    ]) {
      expect(planFinish(closed, lease, "r", NOW)).toEqual({
        kind: "rejected",
        classification: "finish_not_allowed",
      });
    }
    // Open loop: finish_not_allowed even with a matching revision
    expect(planFinish(baseLoop(), { ...EXEC_LEASE }, "r", NOW)).toEqual({
      kind: "rejected",
      classification: "finish_not_allowed",
    });
  });

  it("stale_goal is the last guard", () => {
    const closed = baseLoop({ goal: "g", goalRevision: 2 });
    expect(planFinish(closed, { ...EXEC_LEASE, goalRevision: 1 }, "r", NOW)).toEqual({
      kind: "rejected",
      classification: "stale_goal",
    });
  });

  it("schedule revision exhaustion folds into invalid_loop_state", () => {
    const closed = baseLoop({ goal: "g", goalRevision: 2, scheduleRevision: REVISION_INT32_MAX });
    expect(planFinish(closed, { ...EXEC_LEASE, goalRevision: 2 }, "r", NOW)).toEqual({
      kind: "rejected",
      classification: "invalid_loop_state",
    });
  });
});

describe("D8: reopen", () => {
  const completedScheduled = baseLoop({
    enabled: false,
    goal: "g",
    goalRevision: 2,
    completedAt: NOW,
    completionReason: "goal met",
    cron: "0 3 * * *",
    timezone: "Asia/Shanghai",
    scheduleRevision: 4,
  });

  it("accepts only a legally Completed loop", () => {
    expect(planReopen(baseLoop(), NOW)).toEqual({ kind: "rejected", reason: "loop_not_completed" });
    expect(planReopen(baseLoop({ enabled: false }), NOW)).toEqual({ kind: "rejected", reason: "loop_not_completed" });
    expect(planReopen(baseLoop({ completedAt: NOW }), NOW)).toEqual({ kind: "rejected", reason: "invalid_loop_state" });
  });

  it("clears completion, re-enables, re-arms the schedule through the shared core", () => {
    expect(planReopen(completedScheduled, NOW)).toEqual({
      kind: "changed",
      writes: {
        completedAt: null,
        completionReason: null,
        enabled: true,
        scheduleRevision: 5,
        scheduleActivatedAt: NOW, // cron present → fresh activation boundary
        lastScheduledAt: null,
        updatedAt: NOW,
      },
    });
  });

  it("manual-only completed loop reopens with no activation", () => {
    const manual = { ...completedScheduled, cron: null };
    const plan = planReopen(manual, NOW);
    if (plan.kind !== "changed") throw new Error("unreachable");
    expect(plan.writes.scheduleActivatedAt).toBeNull();
    expect(plan.writes.scheduleRevision).toBe(5);
  });

  it("preserves goal/revision/state/config by omission (no keys for them)", () => {
    const plan = planReopen(completedScheduled, NOW);
    if (plan.kind !== "changed") throw new Error("unreachable");
    for (const key of ["goal", "goalRevision", "cron", "timezone", "state", "taskFileContent"]) {
      expect(plan.writes).not.toHaveProperty(key);
    }
  });

  it("schedule revision exhaustion is its own stable rejection", () => {
    const exhausted = { ...completedScheduled, scheduleRevision: REVISION_INT32_MAX };
    expect(planReopen(exhausted, NOW)).toEqual({ kind: "rejected", reason: "schedule_revision_exhausted" });
  });
});

describe("D10: updatedAt and zero-write rules", () => {
  it("every effective write plan stamps updatedAt from the supplied nowIso", () => {
    const closed = baseLoop({ goal: "g", goalRevision: 1 });
    const goalPlan = planGoalUpdate(closed, { goal: "h" }, NOW);
    const finishPlan = planFinish(closed, { ...EXEC_LEASE, goalRevision: 1 }, "r", NOW);
    const reopenPlan = planReopen(
      baseLoop({ enabled: false, goal: "g", goalRevision: 1, completedAt: NOW, completionReason: "r" }),
      NOW,
    );
    if (goalPlan.kind !== "changed" || finishPlan.kind !== "allowed" || reopenPlan.kind !== "changed") {
      throw new Error("unreachable");
    }
    expect(goalPlan.writes.updatedAt).toBe(NOW);
    expect(finishPlan.writes.updatedAt).toBe(NOW);
    expect(reopenPlan.writes.updatedAt).toBe(NOW);
  });

  it("rejections and noops carry no writes at all", () => {
    expect(planGoalUpdate(baseLoop(), { goal: "  " }, NOW)).not.toHaveProperty("writes");
    expect(planGoalUpdate(baseLoop(), { goal: null }, NOW)).not.toHaveProperty("writes");
    expect(planFinish(baseLoop(), EXEC_LEASE, "r", NOW)).not.toHaveProperty("writes");
    expect(planReopen(baseLoop(), NOW)).not.toHaveProperty("writes");
  });
});
