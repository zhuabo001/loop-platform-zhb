/**
 * Phase 4 wire shape tests (plan P1/P2): every new field is additive-optional,
 * terminal union branches parse their goldens, and malformed terminal commands
 * fail at the boundary. These are SHAPE tests — value policy lives in
 * terminal-policy.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  createLoopRequestSchema,
  loopSummarySchema,
  reopenLoopRequestSchema,
  updateGoalRequestSchema,
  updateTaskFileRequestSchema,
} from "./admin.js";
import { deliverySchema, pollRequestSchema, pollResponseSchema } from "./poll.js";
import { isStrictJsonValue } from "./json.js";
import {
  reportRequestSchema,
  TASK_FILE_SYNC_ERRORS,
  terminalCommandSchema,
} from "./report.js";

const MINIMAL_LOOP = {
  id: "l_01",
  name: "loop",
  workdir: null,
  taskFile: null,
  workflow: null,
  model: null,
  allowControl: true,
} as const;

const MINIMAL_LOOP_SUMMARY = {
  id: "loop-01",
  machineId: "m-0123456789abcdef",
  name: null,
  workdir: null,
  taskFile: null,
  agent: "claude-code",
  allowControl: true,
  enabled: true,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  lastRun: null,
} as const;

describe("P1: every Phase 4 field is additive-optional", () => {
  it("poll request parses with and without capabilities", () => {
    expect(pollRequestSchema.parse({})).toEqual({});
    expect(pollRequestSchema.parse({ capabilities: ["terminal-journal-v1"] })).toEqual({
      capabilities: ["terminal-journal-v1"],
    });
  });

  it("poll response parses with and without requiredCapabilities", () => {
    expect(pollResponseSchema.parse({ deliveries: [] })).toEqual({ deliveries: [] });
    expect(pollResponseSchema.parse({ deliveries: [], requiredCapabilities: ["terminal-journal-v1"] })).toEqual({
      deliveries: [],
      requiredCapabilities: ["terminal-journal-v1"],
    });
  });

  it("delivery parses with and without terminalProtocol / loop.goal", () => {
    const base = {
      runId: "r",
      runToken: `rk_${"b2".repeat(16)}`,
      role: "exec",
      loop: { ...MINIMAL_LOOP },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "t",
    } as const;
    expect(deliverySchema.parse(base)).toEqual(base);
    const v1 = deliverySchema.parse({
      ...base,
      terminalProtocol: 1,
      loop: { ...MINIMAL_LOOP, goal: "ship it" },
    });
    expect(v1.terminalProtocol).toBe(1);
    expect(v1.loop.goal).toBe("ship it");
    // goal is nullable on the wire (Open Loop made explicit)
    expect(deliverySchema.parse({ ...base, loop: { ...MINIMAL_LOOP, goal: null } }).loop.goal).toBeNull();
  });

  it("terminalProtocol only admits the literal 1", () => {
    const base = {
      runId: "r",
      runToken: "rk_x",
      role: "exec",
      loop: { ...MINIMAL_LOOP },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "t",
    } as const;
    expect(() => deliverySchema.parse({ ...base, terminalProtocol: 0 })).toThrow();
    expect(() => deliverySchema.parse({ ...base, terminalProtocol: 2 })).toThrow();
  });

  it("report parses with and without terminal / taskFileSyncError", () => {
    expect(reportRequestSchema.parse({ ok: true })).toEqual({ ok: true });
    const parsed = reportRequestSchema.parse({
      ok: true,
      terminal: { kind: "report", status: "nothing-new" },
      taskFileSyncError: "missing",
    });
    expect(parsed.terminal).toEqual({ kind: "report", status: "nothing-new" });
    expect(parsed.taskFileSyncError).toBe("missing");
  });

  it("create loop accepts goal (string or explicit null); management DTOs parse", () => {
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", goal: "g" }).goal).toBe("g");
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", goal: null }).goal).toBeNull();
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef" })).not.toHaveProperty("goal");
    expect(updateGoalRequestSchema.parse({ goal: null })).toEqual({ goal: null });
    expect(updateGoalRequestSchema.parse({ goal: "g" })).toEqual({ goal: "g" });
    expect(() => updateGoalRequestSchema.parse({})).toThrow(); // key is required, value nullable
    expect(updateTaskFileRequestSchema.parse({ taskFile: "/t/TASK.md" })).toEqual({ taskFile: "/t/TASK.md" });
    expect(reopenLoopRequestSchema.parse({})).toEqual({});
  });

  it("loop summary carries the Phase 4 observation fields optionally", () => {
    expect(loopSummarySchema.parse(MINIMAL_LOOP_SUMMARY)).toEqual(MINIMAL_LOOP_SUMMARY);
    const full = loopSummarySchema.parse({
      ...MINIMAL_LOOP_SUMMARY,
      goal: "g",
      completedAt: "2026-08-30T00:00:00.000Z",
      completionReason: "done",
      taskFileSyncedAt: "2026-08-30T00:00:00.000Z",
      taskFileSyncAttemptedAt: "2026-08-30T01:00:00.000Z",
      taskFileSyncError: "changed",
    });
    expect(full.goal).toBe("g");
    expect(full.taskFileSyncError).toBe("changed");
    expect(() => loopSummarySchema.parse({ ...MINIMAL_LOOP_SUMMARY, taskFileSyncError: "bogus" })).toThrow();
  });
});

describe("P2: terminal union shape", () => {
  it("pins the task-file sync error enum verbatim", () => {
    expect([...TASK_FILE_SYNC_ERRORS]).toEqual(["missing", "unreadable", "outside_jail", "changed", "too_large"]);
  });

  it("round-trips every legal branch", () => {
    const goldens = [
      { kind: "report", status: "new", message: "found 3 issues" },
      { kind: "report", status: "resolved", message: "all fixed", state: { prs: [42] } },
      { kind: "report", status: "nothing-new" },
      { kind: "report", status: "nothing-new", message: "optional anyway" },
      { kind: "finish", reason: "goal met" },
      { kind: "finish", reason: "goal met", message: "shipped in #42", state: {} },
    ] as const;
    for (const golden of goldens) {
      expect(terminalCommandSchema.parse(golden)).toEqual(golden);
    }
  });

  it("report/new and report/resolved REQUIRE message; nothing-new does not", () => {
    expect(() => terminalCommandSchema.parse({ kind: "report", status: "new" })).toThrow();
    expect(() => terminalCommandSchema.parse({ kind: "report", status: "resolved" })).toThrow();
    expect(terminalCommandSchema.parse({ kind: "report", status: "nothing-new" })).toEqual({
      kind: "report",
      status: "nothing-new",
    });
  });

  it("finish REQUIRES reason; message stays optional", () => {
    expect(() => terminalCommandSchema.parse({ kind: "finish" })).toThrow();
    expect(terminalCommandSchema.parse({ kind: "finish", reason: "r" })).toEqual({ kind: "finish", reason: "r" });
  });

  it("rejects unknown kinds and statuses", () => {
    expect(() => terminalCommandSchema.parse({ kind: "evolve", status: "new", message: "m" })).toThrow();
    expect(() => terminalCommandSchema.parse({ kind: "report", status: "stuck", message: "m" })).toThrow();
  });

  it("preserves a top-level __proto__ own property — success must never silently DROP a legal key", () => {
    // A record-based schema rebuilds the object by assignment, and assigning
    // __proto__ sets the PROTOTYPE: the wire would report success while the
    // parsed state had lost a legal key. The schema must pass the input
    // through by identity instead.
    const state = JSON.parse('{"__proto__":{"marker":1},"keep":2}');
    expect(Object.keys(state).sort()).toEqual(["__proto__", "keep"]);
    const result = reportRequestSchema.safeParse({
      ok: true,
      terminal: { kind: "report", status: "nothing-new", state },
      taskFileContent: "x",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.data.terminal as { kind: "report"; state: Record<string, unknown> };
    expect(Object.getPrototypeOf(parsed.state)).toBe(Object.prototype);
    expect(Object.keys(parsed.state).sort()).toEqual(["__proto__", "keep"]);
    expect(Object.prototype.hasOwnProperty.call(parsed.state, "__proto__")).toBe(true);
    expect(parsed.state["__proto__"]).toEqual({ marker: 1 });
  });

  it("rejects non-object state at the boundary (policy re-checks it too)", () => {
    for (const state of [[], null, "s", 42]) {
      expect(() => terminalCommandSchema.parse({ kind: "report", status: "nothing-new", state })).toThrow();
    }
  });

  it("rejects pathologically DEEP state as a stable schema failure — never a thrown RangeError", () => {
    // Far beyond any engine's JSON.stringify recursion limit; built
    // iteratively. The wire schema is non-recursive, so safeParse must return
    // { success: false } (→ HTTP 400, lease untouched), not throw.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200_000; i++) deep = { next: deep };
    const result = reportRequestSchema.safeParse({
      ok: true,
      terminal: { kind: "report", status: "nothing-new", state: deep },
      taskFileContent: "x",
    });
    expect(result.success).toBe(false);
  });

  it("turns a revoked Proxy into a stable schema failure", () => {
    const pair = Proxy.revocable({}, {});
    pair.revoke();
    expect(
      reportRequestSchema.safeParse({
        ok: true,
        terminal: { kind: "report", status: "nothing-new", state: pair.proxy },
        taskFileContent: "x",
      }).success,
    ).toBe(false);
  });

  it("validates a shared DAG without expanding every reference during stringify", () => {
    let leafReads = 0;
    const leaf = {
      get value(): number {
        leafReads++;
        return 1;
      },
    };
    let state: Record<string, unknown> = leaf;
    for (let depth = 0; depth < 20; depth++) state = { left: state, right: state };

    const result = reportRequestSchema.safeParse({
      ok: true,
      terminal: { kind: "report", status: "nothing-new", state },
      taskFileContent: "x",
    });
    expect(result.success).toBe(true);
    expect(leafReads).toBe(1);
  });

  it("still rejects a deep unique branch when another branch contains sharing", () => {
    const shared = { value: 1 };
    let deep: unknown = 1;
    for (let depth = 0; depth < 8_000; depth++) deep = [deep];
    const result = reportRequestSchema.safeParse({
      ok: true,
      terminal: {
        kind: "report",
        status: "nothing-new",
        state: { left: shared, right: shared, deep },
      },
      taskFileContent: "x",
    });
    expect(result.success).toBe(false);
  });

  it("does not let inherited array index setters alter strict JSON traversal", () => {
    let inheritedSetterCalls = 0;
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      get() {
        return undefined;
      },
      set() {
        inheritedSetterCalls++;
      },
    });
    let valid: boolean;
    let sparseValid: boolean;
    try {
      valid = isStrictJsonValue({ list: [2] });
      sparseValid = isStrictJsonValue({ list: new Array(1) });
    } finally {
      Reflect.deleteProperty(Array.prototype, "0");
    }
    expect(valid!).toBe(true);
    expect(sparseValid!).toBe(false);
    expect(inheritedSetterCalls).toBe(0);
  });

  it("rejects state stringify would mangle, without recursing into it", () => {
    // Non-JSON nested values are a wire rejection now (stack-safe), not a
    // policy-later surprise.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      reportRequestSchema.safeParse({ ok: true, terminal: { kind: "report", status: "nothing-new", state: cyclic } })
        .success,
    ).toBe(false);
  });

  it("distinguishes absent state from an explicit empty object", () => {
    const absent = terminalCommandSchema.parse({ kind: "report", status: "nothing-new" });
    expect(absent).not.toHaveProperty("state");
    const empty = terminalCommandSchema.parse({ kind: "report", status: "nothing-new", state: {} });
    expect(empty.state).toEqual({});
  });

  it("strips unknown keys INSIDE the terminal command (tolerant at every level)", () => {
    const parsed = terminalCommandSchema.parse({
      kind: "report",
      status: "new",
      message: "m",
      futureField: { nested: [1] },
    });
    expect(parsed).toEqual({ kind: "report", status: "new", message: "m" });
  });

  it("rejects an unknown taskFileSyncError value", () => {
    expect(() => reportRequestSchema.parse({ ok: true, taskFileSyncError: "exploded" })).toThrow();
  });
});
