/**
 * Phase 4 Batch 1 — T group: the final-report decision/write-plan (ADR-009
 * 决策 8, plan §3). The plan is PURE: Batch 2 will execute it inside the
 * existing report transaction. Real DB-fault/CAS interleaving tests are
 * Batch 2 wiring work (pinned in the ADR); what T7 pins here is that a plan
 * is either complete or nonexistent — no partial plan can be committed.
 *
 *  T1  v0 lease ignores terminal/state/sync → identical to the Phase 3 builder
 *  T2  v1 ok=false ignores extensions → old failure finalize, zero Loop writes
 *  T3  v1 success: state absent vs {} vs non-empty
 *  T4  task-file sync success vs error — never a partial sync write
 *  T5  legal finish: the full Run/Loop/Lease write-set
 *  T6  every finish classification → Run failure + lease retire only
 *  T7  interruption model: a failing guard leaves NO committable partial plan
 *  T8  wire-legal but policy-invalid v1 success → terminal_protocol_invalid
 */
import { describe, expect, it } from "vitest";

import type { ReportRequest } from "@loopzhb/protocol";

import type { Run } from "../db/schema.js";
import { buildReportWriteSet } from "../store/report.js";
import {
  planReportWrites,
  TERMINAL_PROTOCOL_INVALID,
  type LoopReportSnapshot,
  type LeaseAuthSnapshot,
} from "./index.js";

const NOW = "2026-08-31T00:00:00.000Z";

function baseLoop(overrides: Partial<LoopReportSnapshot> = {}): LoopReportSnapshot {
  return {
    goal: "triage the queue",
    goalRevision: 2,
    completedAt: null,
    completionReason: null,
    enabled: true,
    cron: "0 3 * * *",
    timezone: "UTC",
    scheduleRevision: 4,
    state: { cursor: 1 },
    taskFileContent: "# TASK v1",
    taskFileSyncedAt: "2026-08-30T00:00:00.000Z",
    taskFileSyncAttemptedAt: null,
    taskFileSyncError: null,
    ...overrides,
  };
}

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    loopId: "loop-1",
    machineId: "m-1",
    phase: "running",
    role: "exec",
    ts: "2026-08-30T23:59:00.000Z",
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
    progress: { step: 1, label: "working", at: "2026-08-30T23:59:30.000Z" },
    ...overrides,
  };
}

function v1Lease(overrides: Partial<LeaseAuthSnapshot> = {}): LeaseAuthSnapshot {
  return { role: "exec", canFinish: true, goalRevision: 2, terminalProtocolVersion: 1, ...overrides };
}

const SYNC_OK = { taskFileContent: "# TASK v2" } as const;

describe("T1: v0 lease — Phase 3 semantics, extensions ignored", () => {
  it("a v0 report carrying terminal/state/sync produces the Phase 3 write-set", () => {
    const body: ReportRequest = {
      ok: true,
      message: "done",
      durationMs: 100,
      terminal: { kind: "finish", reason: "goal met", state: { a: 1 } },
      taskFileContent: "# TASK v2",
    };
    const run = baseRun();
    const plan = planReportWrites({ loop: baseLoop(), lease: v1Lease({ terminalProtocolVersion: 0 }), run, body, nowIso: NOW });
    expect(plan.kind).toBe("v0");
    expect(plan.loopWrites).toBeNull();
    expect(plan.deleteLease).toBe(true);
    // EXACTLY the Phase 3 builder output — extensions never leak in.
    expect(plan.runWrites).toEqual(buildReportWriteSet(body, run, NOW));
    expect(plan.runWrites).not.toHaveProperty("status");
    expect(plan.runWrites).not.toHaveProperty("state");
  });
});

describe("T2: v1 ok=false — old failure finalize, extensions ignored", () => {
  it("produces the Phase 3 failure write-set and zero Loop writes", () => {
    const body: ReportRequest = {
      ok: false,
      error: "agent crashed",
      terminal: { kind: "finish", reason: "goal met", state: { a: 1 } },
      taskFileContent: "# TASK v2",
    };
    const run = baseRun();
    const plan = planReportWrites({ loop: baseLoop(), lease: v1Lease(), run, body, nowIso: NOW });
    expect(plan.kind).toBe("v1_failure");
    expect(plan.loopWrites).toBeNull();
    expect(plan.runWrites).toEqual(buildReportWriteSet(body, run, NOW));
  });
});

describe("T3: v1 success — state absent vs {} vs non-empty", () => {
  const report = (state?: unknown): ReportRequest => ({
    ok: true,
    terminal: { kind: "report", status: "new", message: "found 2", ...(state === undefined ? {} : { state: state as never }) },
    ...SYNC_OK,
  });

  it("absent state → no state key in either write-set (old loop state kept)", () => {
    const plan = planReportWrites({ loop: baseLoop(), lease: v1Lease(), run: baseRun(), body: report(), nowIso: NOW });
    if (plan.kind !== "v1_success") throw new Error("unreachable");
    expect(plan.loopWrites).not.toHaveProperty("state");
    expect(plan.runWrites.state).toBeNull();
  });

  it("{} → promotes an explicit empty object", () => {
    const plan = planReportWrites({ loop: baseLoop(), lease: v1Lease(), run: baseRun(), body: report({}), nowIso: NOW });
    if (plan.kind !== "v1_success") throw new Error("unreachable");
    expect(plan.loopWrites.state).toEqual({});
    expect(plan.runWrites.state).toEqual({});
  });

  it("a non-empty object promotes verbatim to both run and loop", () => {
    const state = { cursor: 2, seen: ["a", "b"] };
    const plan = planReportWrites({ loop: baseLoop(), lease: v1Lease(), run: baseRun(), body: report(state), nowIso: NOW });
    if (plan.kind !== "v1_success") throw new Error("unreachable");
    expect(plan.loopWrites.state).toEqual(state);
    expect(plan.runWrites.state).toEqual(state);
    expect(plan.runWrites.status).toBe("new");
    expect(plan.runWrites.message).toBe("found 2");
  });
});

describe("T4: task-file sync — success and error, never partial", () => {
  it("sync success writes content + syncedAt + attemptedAt and clears the old error", () => {
    const loop = baseLoop({ taskFileSyncError: "changed", taskFileSyncAttemptedAt: "2026-08-30T01:00:00.000Z" });
    const plan = planReportWrites({
      loop,
      lease: v1Lease(),
      run: baseRun(),
      body: { ok: true, terminal: { kind: "report", status: "nothing-new" }, taskFileContent: "# TASK v2" },
      nowIso: NOW,
    });
    if (plan.kind !== "v1_success") throw new Error("unreachable");
    expect(plan.loopWrites).toEqual({
      taskFileContent: "# TASK v2",
      taskFileSyncedAt: NOW,
      taskFileSyncAttemptedAt: NOW,
      taskFileSyncError: null,
      updatedAt: NOW,
    });
  });

  it("sync error writes ONLY attemptedAt + error — old content/syncedAt keys absent", () => {
    const plan = planReportWrites({
      loop: baseLoop(),
      lease: v1Lease(),
      run: baseRun(),
      body: { ok: true, terminal: { kind: "report", status: "nothing-new" }, taskFileSyncError: "too_large" },
      nowIso: NOW,
    });
    if (plan.kind !== "v1_success") throw new Error("unreachable");
    expect(plan.loopWrites).toEqual({
      taskFileSyncAttemptedAt: NOW,
      taskFileSyncError: "too_large",
      updatedAt: NOW,
    });
    expect(plan.loopWrites).not.toHaveProperty("taskFileContent");
    expect(plan.loopWrites).not.toHaveProperty("taskFileSyncedAt");
  });
});

describe("T5: legal finish — the full write-set in one plan", () => {
  it("finish with message, state and sync success", () => {
    const plan = planReportWrites({
      loop: baseLoop(),
      lease: v1Lease(),
      run: baseRun(),
      body: {
        ok: true,
        terminal: { kind: "finish", reason: "queue empty", message: "all triaged", state: { done: true } },
        ...SYNC_OK,
      },
      nowIso: NOW,
    });
    if (plan.kind !== "v1_finish") throw new Error("unreachable");
    expect(plan.runWrites).toMatchObject({
      phase: "done",
      outcome: "exec",
      status: "resolved",
      message: "all triaged",
      error: null,
      state: { done: true },
      progress: null,
      ts: NOW,
    });
    expect(plan.loopWrites).toEqual({
      state: { done: true },
      taskFileContent: "# TASK v2",
      taskFileSyncedAt: NOW,
      taskFileSyncAttemptedAt: NOW,
      taskFileSyncError: null,
      completedAt: NOW,
      completionReason: "queue empty",
      enabled: false,
      scheduleRevision: 5,
      scheduleActivatedAt: null,
      lastScheduledAt: null,
      updatedAt: NOW,
    });
    expect(plan.deleteLease).toBe(true);
  });

  it("finish without message falls back to the reason for the run message", () => {
    const plan = planReportWrites({
      loop: baseLoop(),
      lease: v1Lease(),
      run: baseRun(),
      body: { ok: true, terminal: { kind: "finish", reason: "queue empty" }, ...SYNC_OK },
      nowIso: NOW,
    });
    if (plan.kind !== "v1_finish") throw new Error("unreachable");
    expect(plan.runWrites.message).toBe("queue empty");
  });

  it("a finish message at EXACTLY the 2000 UTF-8 byte ceiling is legal (A-1 positive boundary)", () => {
    const message = "é".repeat(1000); // 2000 UTF-8 bytes
    const plan = planReportWrites({
      loop: baseLoop(),
      lease: v1Lease(),
      run: baseRun(),
      body: { ok: true, terminal: { kind: "finish", reason: "queue empty", message }, ...SYNC_OK },
      nowIso: NOW,
    });
    if (plan.kind !== "v1_finish") throw new Error("unreachable");
    expect(plan.runWrites.message).toBe(message);
  });
});

describe("T6: every illegal finish classification → Run failure + lease retire, zero Loop writes", () => {
  const finishBody: ReportRequest = {
    ok: true,
    terminal: { kind: "finish", reason: "queue empty" },
    ...SYNC_OK,
  };

  const cases: Array<[string, LoopReportSnapshot, LeaseAuthSnapshot, string]> = [
    [
      "invalid_loop_state",
      baseLoop({ completedAt: NOW }), // half-completed snapshot
      v1Lease(),
      "invalid_loop_state",
    ],
    [
      "already_completed",
      baseLoop({ enabled: false, completedAt: NOW, completionReason: "r" }),
      v1Lease(),
      "already_completed",
    ],
    ["finish_not_allowed (role)", baseLoop(), v1Lease({ role: "evolve" }), "finish_not_allowed"],
    ["finish_not_allowed (cap)", baseLoop(), v1Lease({ canFinish: false }), "finish_not_allowed"],
    [
      "finish_not_allowed (open)",
      baseLoop({ goal: null, goalRevision: 3 }),
      v1Lease({ goalRevision: 3 }),
      "finish_not_allowed",
    ],
    ["stale_goal", baseLoop(), v1Lease({ goalRevision: 1 }), "stale_goal"],
  ];

  for (const [name, loop, lease, classification] of cases) {
    it(name, () => {
      const plan = planReportWrites({ loop, lease, run: baseRun(), body: finishBody, nowIso: NOW });
      if (plan.kind !== "finish_rejected") throw new Error(`expected finish_rejected, got ${plan.kind}`);
      expect(plan.classification).toBe(classification);
      expect(plan.loopWrites).toBeNull();
      expect(plan.deleteLease).toBe(true);
      expect(plan.runWrites).toMatchObject({ phase: "error", outcome: "error", error: classification, ts: NOW });
    });
  }
});

describe("T7: interruption model — a failing guard leaves no committable partial plan", () => {
  it("rejection plans are total: run failure + lease retire + zero loop writes, or nothing", () => {
    // Every guard-failure input still yields a COMPLETE consume-plan (run +
    // lease), never a plan with loop writes but no lease retire, etc.
    const badFinish: ReportRequest = { ok: true, terminal: { kind: "finish", reason: "r" }, ...SYNC_OK };
    const plan = planReportWrites({
      loop: baseLoop(), // stale lease below
      lease: v1Lease({ goalRevision: 0 }),
      run: baseRun(),
      body: badFinish,
      nowIso: NOW,
    });
    expect(Object.keys(plan).sort()).toEqual(["classification", "deleteLease", "kind", "loopWrites", "runWrites"].sort());
    if (plan.kind !== "finish_rejected") throw new Error("unreachable");
    expect(plan.loopWrites).toBeNull();
  });

  it("the planner never throws across the malformed-but-wire-legal matrix", () => {
    const bodies: ReportRequest[] = [
      { ok: true }, // no terminal
      { ok: true, terminal: { kind: "report", status: "nothing-new" } }, // no sync result
      { ok: true, terminal: { kind: "report", status: "nothing-new" }, ...SYNC_OK, taskFileSyncError: "missing" }, // both
      { ok: true, terminal: { kind: "finish", reason: "" }, ...SYNC_OK }, // empty reason (wire-legal)
      { ok: true, terminal: { kind: "report", status: "new", message: "m" }, ...SYNC_OK },
      { ok: false, error: "x" },
    ];
    for (const lease of [v1Lease(), v1Lease({ terminalProtocolVersion: 0 }), v1Lease({ terminalProtocolVersion: 2 })]) {
      for (const body of bodies) {
        const plan = planReportWrites({ loop: baseLoop(), lease, run: baseRun(), body, nowIso: NOW });
        // Totality: every plan is one atomic unit — run writes and the lease
        // retire always appear together; loop writes are all-or-nothing.
        expect(plan.deleteLease).toBe(true);
        expect(plan.runWrites).toBeDefined();
        if (plan.loopWrites !== null) {
          expect(plan.kind === "v1_success" || plan.kind === "v1_finish").toBe(true);
        }
      }
    }
  });
});

describe("T8: wire-legal but policy-invalid v1 success → terminal_protocol_invalid", () => {
  const invalidBodies: Array<[string, ReportRequest]> = [
    ["terminal missing", { ok: true, ...SYNC_OK }],
    ["message with NUL", { ok: true, terminal: { kind: "report", status: "new", message: "a\0b" }, ...SYNC_OK }],
    [
      "message over 2000 UTF-8 bytes",
      { ok: true, terminal: { kind: "report", status: "new", message: "é".repeat(1001) }, ...SYNC_OK },
    ],
    ["empty finish reason", { ok: true, terminal: { kind: "finish", reason: "" }, ...SYNC_OK }],
    // A-1: the finish's OPTIONAL message passes the same policy as a report's.
    [
      "finish message with NUL",
      { ok: true, terminal: { kind: "finish", reason: "goal met", message: "bad\0message" }, ...SYNC_OK },
    ],
    [
      "finish message over 2000 UTF-8 bytes",
      { ok: true, terminal: { kind: "finish", reason: "goal met", message: "m".repeat(2001) }, ...SYNC_OK },
    ],
    [
      "finish message multibyte over ceiling",
      { ok: true, terminal: { kind: "finish", reason: "goal met", message: "é".repeat(1001) }, ...SYNC_OK },
    ],
    [
      "state over 64 KiB compact",
      {
        ok: true,
        terminal: { kind: "report", status: "nothing-new", state: { data: "x".repeat(65_536) } },
        ...SYNC_OK,
      },
    ],
    [
      "state with a PG-unwritable string (NUL)",
      { ok: true, terminal: { kind: "report", status: "nothing-new", state: { x: "a\0b" } }, ...SYNC_OK },
    ],
    ["both sync results", { ok: true, terminal: { kind: "report", status: "nothing-new" }, ...SYNC_OK, taskFileSyncError: "missing" }],
    ["no sync result", { ok: true, terminal: { kind: "report", status: "nothing-new" } }],
    ["content over 256 KiB", { ok: true, terminal: { kind: "report", status: "nothing-new" }, taskFileContent: "x".repeat(262_145) }],
    [
      "content not PG-representable (NUL)",
      { ok: true, terminal: { kind: "report", status: "nothing-new" }, taskFileContent: "binary \0 content" },
    ],
  ];

  for (const [name, body] of invalidBodies) {
    it(name, () => {
      const plan = planReportWrites({ loop: baseLoop(), lease: v1Lease(), run: baseRun(), body, nowIso: NOW });
      if (plan.kind !== "terminal_protocol_invalid") throw new Error(`expected terminal_protocol_invalid, got ${plan.kind}`);
      expect(plan.loopWrites).toBeNull();
      expect(plan.deleteLease).toBe(true);
      expect(plan.runWrites).toMatchObject({ phase: "error", outcome: "error", error: TERMINAL_PROTOCOL_INVALID });
    });
  }

  it("a lease version that is neither 0 nor 1 is corrupt — stable invalid, never a guess", () => {
    const plan = planReportWrites({
      loop: baseLoop(),
      lease: v1Lease({ terminalProtocolVersion: 2 }),
      run: baseRun(),
      body: { ok: true, terminal: { kind: "report", status: "nothing-new" }, ...SYNC_OK },
      nowIso: NOW,
    });
    expect(plan.kind).toBe("terminal_protocol_invalid");
    expect(plan.loopWrites).toBeNull();
  });
});

describe("SP-3: EVERY v1 success branch fail-closes on a corrupt persisted loop snapshot", () => {
  const reportBody: ReportRequest = {
    ok: true,
    terminal: { kind: "report", status: "nothing-new" },
    ...SYNC_OK,
  };

  const corruptLoops: Array<[string, LoopReportSnapshot]> = [
    ["half-completed (completedAt without reason)", baseLoop({ completedAt: NOW })],
    ["completed but enabled", baseLoop({ enabled: true, completedAt: NOW, completionReason: "r" })],
    ["completed with a policy-invalid reason", baseLoop({ enabled: false, completedAt: NOW, completionReason: "" })],
    ["untrimmed persisted goal", baseLoop({ goal: " g", goalRevision: 1 })],
    ["negative goalRevision", baseLoop({ goalRevision: -1 })],
    ["goalRevision beyond int32", baseLoop({ goalRevision: 2_147_483_648 })],
    ["fractional scheduleRevision", baseLoop({ scheduleRevision: 1.5 })],
  ];

  for (const [name, loop] of corruptLoops) {
    it(`${name} → loop_state_invalid: Run failure + lease retire, ZERO Loop writes`, () => {
      const plan = planReportWrites({ loop, lease: v1Lease(), run: baseRun(), body: reportBody, nowIso: NOW });
      if (plan.kind !== "loop_state_invalid") throw new Error(`expected loop_state_invalid, got ${plan.kind}`);
      expect(plan.loopWrites).toBeNull();
      expect(plan.deleteLease).toBe(true);
      expect(plan.runWrites).toMatchObject({ phase: "error", outcome: "error", error: "invalid_loop_state" });
    });
  }

  it("a FINISH against a corrupt snapshot keeps the finish_rejected shape with invalid_loop_state", () => {
    const plan = planReportWrites({
      loop: baseLoop({ completedAt: NOW }), // half-completed
      lease: v1Lease(),
      run: baseRun(),
      body: { ok: true, terminal: { kind: "finish", reason: "goal met" }, ...SYNC_OK },
      nowIso: NOW,
    });
    if (plan.kind !== "finish_rejected") throw new Error(`expected finish_rejected, got ${plan.kind}`);
    expect(plan.classification).toBe("invalid_loop_state");
    expect(plan.loopWrites).toBeNull();
  });
});
