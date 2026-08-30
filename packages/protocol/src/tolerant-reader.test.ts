import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { apiErrorSchema } from "./errors.js";
import {
  cancelRunRequestSchema,
  cancelRunResponseSchema,
  createLoopRequestSchema,
  createLoopResponseSchema,
  loopListResponseSchema,
  loopSummarySchema,
  machineListResponseSchema,
  machineSummarySchema,
  reopenLoopRequestSchema,
  reopenLoopResponseSchema,
  runListResponseSchema,
  runProgressSnapshotSchema,
  runSummarySchema,
  triggerRunRequestSchema,
  triggerRunResponseSchema,
  updateGoalRequestSchema,
  updateGoalResponseSchema,
  updateTaskFileRequestSchema,
  updateTaskFileResponseSchema,
} from "./admin.js";
import {
  deliveryLoopSchema,
  deliverySchema,
  pollRequestSchema,
  pollResponseSchema,
  runProgressSchema,
} from "./poll.js";
import {
  costReportSchema,
  reportRequestSchema,
  reportResponseSchema,
  runArtifactSchema,
  terminalFinishCommandSchema,
  terminalReportCommandSchema,
  transcriptStepSchema,
} from "./report.js";

/**
 * ADR-002 决策 1：每一个 object schema 都是 tolerant reader——未知键剥离，
 * 永不 strict。若任何一个 schema 退化为 z.strictObject（或等价行为），
 * 本套件变红。此处的覆盖是穷尽的：protocol 导出的每个 object schema 都有
 * 一行（mutation-tested：曾对 6 个未钉住的 schema 复现过 strictObject 逃逸）。
 */

const MINIMAL_LOOP = {
  id: "l_01",
  name: "loop",
  workdir: null,
  taskFile: null,
  workflow: null,
  model: null,
  allowControl: true,
} as const;

const MINIMAL_RUN_SUMMARY = {
  id: "r_01",
  loopId: "loop-01",
  machineId: "m-0123456789abcdef",
  phase: "pending",
  role: "exec",
  ts: "2026-08-08T00:00:00.000Z",
  outcome: null,
  status: null,
  message: null,
  error: null,
  durationMs: null,
  progress: null,
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

const CASES: ReadonlyArray<readonly [string, z.ZodTypeAny, Record<string, unknown>]> = [
  ["pollRequestSchema", pollRequestSchema, {}],
  ["runProgressSchema", runProgressSchema, { runId: "r", step: 0, label: "x" }],
  ["deliveryLoopSchema", deliveryLoopSchema, { ...MINIMAL_LOOP }],
  [
    "deliverySchema",
    deliverySchema,
    {
      runId: "r",
      runToken: `rk_${"b2".repeat(16)}`,
      role: "exec",
      loop: { ...MINIMAL_LOOP },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "t",
    },
  ],
  ["pollResponseSchema", pollResponseSchema, { deliveries: [] }],
  ["reportRequestSchema", reportRequestSchema, { ok: true }],
  ["runArtifactSchema", runArtifactSchema, { path: "p", kind: "created" }],
  ["transcriptStepSchema", transcriptStepSchema, { kind: "text" }],
  ["costReportSchema", costReportSchema, {}],
  ["reportResponseSchema", reportResponseSchema, { ok: true }],
  ["apiErrorSchema", apiErrorSchema, { error: "e" }],
  ["createLoopRequestSchema", createLoopRequestSchema, { machineId: "m-0123456789abcdef" }],
  ["machineSummarySchema", machineSummarySchema, {
    id: "m-0123456789abcdef",
    name: "mbp",
    hostname: null,
    platform: null,
    arch: null,
    daemonVersion: null,
    lastSeen: null,
    createdAt: "2026-08-08T00:00:00.000Z",
  }],
  ["runProgressSnapshotSchema", runProgressSnapshotSchema, { step: 0, label: "x", at: null }],
  ["runSummarySchema", runSummarySchema, { ...MINIMAL_RUN_SUMMARY }],
  ["loopSummarySchema", loopSummarySchema, { ...MINIMAL_LOOP_SUMMARY }],
  ["createLoopResponseSchema", createLoopResponseSchema, { loop: { ...MINIMAL_LOOP_SUMMARY } }],
  ["triggerRunRequestSchema", triggerRunRequestSchema, {}],
  [
    "triggerRunResponseSchema(enqueued)",
    triggerRunResponseSchema,
    { enqueued: true, runId: "r_01", supersededRunIds: [] },
  ],
  [
    "triggerRunResponseSchema(running-noop)",
    triggerRunResponseSchema,
    { enqueued: false, reason: "running_exists" },
  ],
  ["cancelRunRequestSchema", cancelRunRequestSchema, {}],
  ["cancelRunResponseSchema(canceled)", cancelRunResponseSchema, { canceled: true }],
  [
    "cancelRunResponseSchema(not-cancelable)",
    cancelRunResponseSchema,
    { canceled: false, reason: "not_cancelable" },
  ],
  ["machineListResponseSchema", machineListResponseSchema, { machines: [] }],
  ["loopListResponseSchema", loopListResponseSchema, { loops: [] }],
  ["runListResponseSchema", runListResponseSchema, { runs: [] }],
  // Phase 4 additions (ADR-009): terminal command variants + declared-but-
  // dormant management DTOs. `terminalCommandSchema` itself is a union (the
  // discriminant is `kind`); its OBJECT variants are listed here.
  ["terminalReportCommandSchema", terminalReportCommandSchema, { kind: "report", status: "nothing-new" }],
  ["terminalFinishCommandSchema", terminalFinishCommandSchema, { kind: "finish", reason: "r" }],
  ["updateGoalRequestSchema", updateGoalRequestSchema, { goal: null }],
  ["updateGoalResponseSchema", updateGoalResponseSchema, { loop: { ...MINIMAL_LOOP_SUMMARY } }],
  ["updateTaskFileRequestSchema", updateTaskFileRequestSchema, { taskFile: "/tmp/TASK.md" }],
  ["updateTaskFileResponseSchema", updateTaskFileResponseSchema, { loop: { ...MINIMAL_LOOP_SUMMARY } }],
  ["reopenLoopRequestSchema", reopenLoopRequestSchema, {}],
  ["reopenLoopResponseSchema", reopenLoopResponseSchema, { loop: { ...MINIMAL_LOOP_SUMMARY } }],
];

describe("tolerant reader: EVERY exported object schema strips unknown keys", () => {
  for (const [name, schema, minimal] of CASES) {
    it(`${name} strips an unknown key instead of rejecting`, () => {
      const parsed = schema.parse({ ...minimal, __futureField: { nested: [1, 2] } });
      expect(parsed).toEqual(minimal);
      expect(parsed).not.toHaveProperty("__futureField");
    });
  }

  it("covers every object schema — adding a new one requires a row here", () => {
    // Guard against a FUTURE schema silently escaping this suite: the case list
    // is reviewed whenever a schema is added (CI review checklist, ADR-002).
    expect(CASES.length).toBe(34);
  });
});
