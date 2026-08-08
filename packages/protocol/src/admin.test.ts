import { describe, expect, it } from "vitest";

import {
  createLoopRequestSchema,
  createLoopResponseSchema,
  loopListResponseSchema,
  loopSummarySchema,
  MACHINE_ID_RE,
  machineListResponseSchema,
  machineSummarySchema,
  runListResponseSchema,
  runProgressSnapshotSchema,
  runSummarySchema,
  triggerRunResponseSchema,
} from "./admin.js";

const GOLDEN_MACHINE_SUMMARY = {
  id: "m-0123456789abcdef",
  name: "mbp",
  hostname: "mbp.local",
  platform: "darwin",
  arch: "arm64",
  daemonVersion: "0.1.0",
  lastSeen: "2026-08-08T01:02:03.000Z",
  createdAt: "2026-08-08T00:00:00.000Z",
} as const;

const GOLDEN_RUN_SUMMARY = {
  id: "r_01",
  loopId: "loop-01",
  machineId: "m-0123456789abcdef",
  phase: "done",
  role: "exec",
  ts: "2026-08-08T01:02:03.000Z",
  outcome: "exec",
  status: null,
  message: "fake runner completed",
  error: null,
  durationMs: 12,
  progress: null,
} as const;

const GOLDEN_LOOP_SUMMARY = {
  id: "loop-01",
  machineId: "m-0123456789abcdef",
  name: "react-doctor",
  workdir: "/home/dev/project",
  taskFile: "/home/dev/project/loops/react-doctor/README.md",
  agent: "claude-code",
  allowControl: true,
  enabled: true,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T01:00:00.000Z",
  lastRun: GOLDEN_RUN_SUMMARY,
} as const;

describe("createLoopRequestSchema", () => {
  it("round-trips a full create body", () => {
    const body = {
      machineId: "m-0123456789abcdef",
      name: "react-doctor",
      workdir: "/home/dev/project",
      taskFile: "/home/dev/project/loops/react-doctor/README.md",
    };
    expect(createLoopRequestSchema.parse(body)).toEqual(body);
  });

  it("parses a machineId-only body (name/workdir/taskFile optional)", () => {
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef" })).toEqual({
      machineId: "m-0123456789abcdef",
    });
  });

  it("accepts only `m-<16 lowercase hex>` machine ids (malformed ⇒ 400 at the boundary)", () => {
    const good = ["m-0123456789abcdef", `m-${"0".repeat(16)}`, `m-${"f".repeat(16)}`];
    for (const machineId of good) {
      expect(createLoopRequestSchema.parse({ machineId }).machineId).toBe(machineId);
      expect(MACHINE_ID_RE.test(machineId)).toBe(true);
    }
    const bad = [
      "0123456789abcdef", // missing prefix
      "m-0123456789abcde", // 15 hex chars
      "m-0123456789abcdef0", // 17 hex chars
      "m-0123456789ABCDEF", // uppercase
      "m-0123456789abcdeg", // non-hex
      "",
    ];
    for (const machineId of bad) {
      expect(() => createLoopRequestSchema.parse({ machineId })).toThrow();
    }
  });

  it("rejects empty and NUL-bearing declared strings; absent is fine", () => {
    for (const field of ["name", "workdir", "taskFile"] as const) {
      expect(() =>
        createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", [field]: "" }),
      ).toThrow();
      expect(() =>
        createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", [field]: "a\0b" }),
      ).toThrow();
    }
  });

  it("strips not-yet-open fields — declaring them on the wire buys NO effect (ADR-002 决策 6)", () => {
    const parsed = createLoopRequestSchema.parse({
      machineId: "m-0123456789abcdef",
      workflow: "return true",
      model: "claude-opus",
      agent: "codex",
      enabled: false,
      state: { hijack: true },
    });
    expect(parsed).toEqual({ machineId: "m-0123456789abcdef" });
  });
});

describe("summary schemas pin explicit nullability (no omitted keys)", () => {
  it("round-trips the golden summaries", () => {
    expect(machineSummarySchema.parse(GOLDEN_MACHINE_SUMMARY)).toEqual(GOLDEN_MACHINE_SUMMARY);
    expect(runSummarySchema.parse(GOLDEN_RUN_SUMMARY)).toEqual(GOLDEN_RUN_SUMMARY);
    expect(loopSummarySchema.parse(GOLDEN_LOOP_SUMMARY)).toEqual(GOLDEN_LOOP_SUMMARY);
  });

  it("accepts a freshly-created loop view (nullables null, lastRun null)", () => {
    const fresh = {
      ...GOLDEN_LOOP_SUMMARY,
      name: null,
      workdir: null,
      taskFile: null,
      lastRun: null,
    };
    expect(loopSummarySchema.parse(fresh)).toEqual(fresh);
  });

  it("rejects omitted nullable fields — nullability is fixed by the DTO, not the DB row", () => {
    const { lastRun: _lastRun, ...noLastRun } = GOLDEN_LOOP_SUMMARY;
    expect(() => loopSummarySchema.parse(noLastRun)).toThrow();
    const { outcome: _outcome, ...noOutcome } = GOLDEN_RUN_SUMMARY;
    expect(() => runSummarySchema.parse(noOutcome)).toThrow();
  });

  it("rejects a negative or fractional durationMs (基础值域, ADR-002 决策 4 例外)", () => {
    for (const durationMs of [-1, 1.5]) {
      expect(() => runSummarySchema.parse({ ...GOLDEN_RUN_SUMMARY, durationMs })).toThrow();
    }
  });

  it("runProgressSnapshot pins the server-stamped `at` (null allowed, absent rejected)", () => {
    expect(runProgressSnapshotSchema.parse({ step: 0, label: "x", at: null })).toEqual({
      step: 0,
      label: "x",
      at: null,
    });
    expect(() => runProgressSnapshotSchema.parse({ step: 0, label: "x" })).toThrow();
  });

  it("rejects non-ISO timestamps at every admin wire position", () => {
    expect(() => machineSummarySchema.parse({ ...GOLDEN_MACHINE_SUMMARY, createdAt: "not-a-date" })).toThrow();
    expect(() => machineSummarySchema.parse({ ...GOLDEN_MACHINE_SUMMARY, lastSeen: "yesterday" })).toThrow();
    expect(() => loopSummarySchema.parse({ ...GOLDEN_LOOP_SUMMARY, createdAt: "someday" })).toThrow();
    expect(() => loopSummarySchema.parse({ ...GOLDEN_LOOP_SUMMARY, updatedAt: "soon" })).toThrow();
    expect(() => runSummarySchema.parse({ ...GOLDEN_RUN_SUMMARY, ts: "later" })).toThrow();
    expect(() => runProgressSnapshotSchema.parse({ step: 0, label: "x", at: "eventually" })).toThrow();
  });

  it("accepts ISO datetimes with an explicit offset", () => {
    expect(
      machineSummarySchema.parse({ ...GOLDEN_MACHINE_SUMMARY, lastSeen: "2026-08-08T09:02:03+08:00" }).lastSeen,
    ).toBe("2026-08-08T09:02:03+08:00");
  });
});

describe("response envelopes", () => {
  it("round-trips the list envelopes (incl. empty)", () => {
    expect(machineListResponseSchema.parse({ machines: [] })).toEqual({ machines: [] });
    expect(machineListResponseSchema.parse({ machines: [GOLDEN_MACHINE_SUMMARY] })).toEqual({
      machines: [GOLDEN_MACHINE_SUMMARY],
    });
    expect(loopListResponseSchema.parse({ loops: [GOLDEN_LOOP_SUMMARY] })).toEqual({
      loops: [GOLDEN_LOOP_SUMMARY],
    });
    expect(runListResponseSchema.parse({ runs: [GOLDEN_RUN_SUMMARY] })).toEqual({
      runs: [GOLDEN_RUN_SUMMARY],
    });
    expect(createLoopResponseSchema.parse({ loop: GOLDEN_LOOP_SUMMARY })).toEqual({
      loop: GOLDEN_LOOP_SUMMARY,
    });
  });

  it("triggerRunResponse covers exactly the 202 and 200-noop bodies", () => {
    const enqueued = { enqueued: true as const, runId: "r_01", supersededRunIds: ["r_00"] };
    expect(triggerRunResponseSchema.parse(enqueued)).toEqual(enqueued);
    const noop = { enqueued: false as const, reason: "running_exists" as const };
    expect(triggerRunResponseSchema.parse(noop)).toEqual(noop);
    // loop_not_found is NOT a success body — it is the flat 404 apiError.
    expect(() =>
      triggerRunResponseSchema.parse({ enqueued: false, reason: "loop_not_found" }),
    ).toThrow();
  });
});
