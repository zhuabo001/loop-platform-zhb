/**
 * Phase 3 ↔ Phase 4 cross-version compatibility (plan P4/P5).
 *
 * The FROZEN Phase 3 readers below are self-contained zod copies of the
 * Phase 3 wire shapes. They deliberately do NOT import the current schemas —
 * a shared import would let a future Phase 4 edit silently "update" the old
 * reader and fake compatibility (同源漂移). If a Phase 4 change breaks one of
 * these frozen readers, that change is a wire-breaking change: stop.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiErrorSchema, LOOP_COMPLETED_CODE, LOOP_NOT_COMPLETED_CODE } from "./errors.js";
import { pollRequestSchema, pollResponseSchema } from "./poll.js";
import { reportRequestSchema } from "./report.js";
import { createLoopRequestSchema, loopSummarySchema, triggerRunResponseSchema } from "./admin.js";

// ---- frozen Phase 3 readers (DO NOT import the current schemas) ----

const frozenPollRequest = z.object({
  host: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  version: z.string().optional(),
  progress: z.array(z.object({ runId: z.string(), step: z.number().int().nonnegative(), label: z.string() })).optional(),
  wait: z.literal(true).optional(),
  availableSlots: z.union([z.literal(0), z.literal(1)]).optional(),
});

const frozenDeliveryLoop = z.object({
  id: z.string(),
  name: z.string(),
  workdir: z.string().nullable(),
  taskFile: z.string().nullable(),
  workflow: z.string().nullable(),
  model: z.string().nullable(),
  allowControl: z.boolean(),
  agent: z.enum(["claude-code", "codex", "grok"]).optional(),
});

const frozenDelivery = z.object({
  runId: z.string(),
  runToken: z.string(),
  role: z.enum(["exec", "evolve", "edit"]),
  loop: frozenDeliveryLoop,
  prevState: z.unknown(),
  roots: z.array(z.string()),
  systemPrompt: z.string(),
  task: z.string(),
});

const frozenPollResponse = z.object({ deliveries: z.array(frozenDelivery) });

const frozenReportRequest = z.object({
  runId: z.string().optional(),
  ok: z.boolean(),
  outcome: z.enum(["direct", "silent", "exec", "evolve"]).optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  finalText: z.string().optional(),
  cursor: z.unknown().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  taskFileContent: z.string().optional(),
  artifacts: z.array(z.object({ path: z.string(), kind: z.enum(["created", "edited"]) })).optional(),
  transcript: z
    .array(
      z.object({
        kind: z.enum(["text", "tool", "result"]),
        text: z.string().optional(),
        name: z.string().optional(),
        input: z.string().optional(),
      }),
    )
    .optional(),
  cost: z
    .object({
      usd: z.number().nonnegative().optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheCreationTokens: z.number().int().nonnegative().optional(),
      numTurns: z.number().int().nonnegative().optional(),
    })
    .optional(),
  attempts: z.number().int().positive().optional(),
});

const frozenLoopSummary = z.object({
  id: z.string(),
  machineId: z.string(),
  name: z.string().nullable(),
  workdir: z.string().nullable(),
  taskFile: z.string().nullable(),
  agent: z.enum(["claude-code", "codex", "grok"]),
  allowControl: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: z.unknown(),
  cron: z.string().nullable().optional(),
  timezone: z.string().optional(),
  nextFireAt: z.string().nullable().optional(),
});

const frozenCreateLoopRequest = z.object({
  machineId: z.string(),
  name: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
  taskFile: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});

/** Frozen Phase 3 trigger-run SUCCESS union — the point of P5 is that
 *  `loop_completed` must NEVER join it. */
const frozenTriggerRunResponse = z.union([
  z.object({ enqueued: z.literal(true), runId: z.string(), supersededRunIds: z.array(z.string()) }),
  z.object({ enqueued: z.literal(false), reason: z.literal("running_exists") }),
]);

// ---- Phase 4 goldens (what the NEW peer actually sends) ----

const PHASE4_POLL_REQUEST = {
  host: "mbp",
  platform: "darwin",
  arch: "arm64",
  version: "0.2.0",
  capabilities: ["terminal-journal-v1"],
  availableSlots: 1,
} as const;

const PHASE4_DELIVERY = {
  runId: "r_01",
  runToken: `rk_${"b2".repeat(16)}`,
  role: "exec",
  loop: {
    id: "l_01",
    name: "loop",
    workdir: null,
    taskFile: "/tmp/TASK.md",
    workflow: null,
    model: null,
    allowControl: true,
    agent: "claude-code",
    goal: "triage the issue queue",
  },
  prevState: { seen: 3 },
  roots: ["/tmp"],
  systemPrompt: "",
  task: "do the thing",
  terminalProtocol: 1,
} as const;

const PHASE4_REPORT = {
  runId: "r_01",
  ok: true,
  outcome: "exec",
  message: "shipped",
  terminal: { kind: "finish", reason: "goal met", message: "shipped", state: { prs: [42] } },
  taskFileSyncError: undefined, // content XOR error — content below
  taskFileContent: "# TASK\n...",
  durationMs: 12_000,
} as const;

const PHASE4_LOOP_SUMMARY = {
  id: "loop-01",
  machineId: "m-0123456789abcdef",
  name: "nightly",
  workdir: null,
  taskFile: "/tmp/TASK.md",
  agent: "claude-code",
  allowControl: true,
  enabled: false,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  lastRun: null,
  cron: "0 3 * * *",
  timezone: "UTC",
  nextFireAt: null,
  goal: "triage the issue queue",
  completedAt: "2026-08-30T00:00:00.000Z",
  completionReason: "goal met",
  taskFileSyncedAt: "2026-08-30T00:00:00.000Z",
  taskFileSyncAttemptedAt: "2026-08-30T00:00:00.000Z",
  taskFileSyncError: null,
} as const;

describe("P4: a frozen Phase 3 reader strips every Phase 4 addition", () => {
  it("poll request: capabilities strip away", () => {
    const parsed = frozenPollRequest.parse(PHASE4_POLL_REQUEST);
    expect(parsed).not.toHaveProperty("capabilities");
    expect(parsed.version).toBe("0.2.0");
  });

  it("delivery: terminalProtocol and loop.goal strip away", () => {
    const parsed = frozenPollResponse.parse({ deliveries: [PHASE4_DELIVERY] });
    expect(parsed.deliveries[0]).not.toHaveProperty("terminalProtocol");
    expect(parsed.deliveries[0]!.loop).not.toHaveProperty("goal");
    expect(parsed.deliveries[0]!.prevState).toEqual({ seen: 3 });
  });

  it("report: terminal and taskFileSyncError strip away; pre-declared taskFileContent survives", () => {
    const parsed = frozenReportRequest.parse(PHASE4_REPORT);
    expect(parsed).not.toHaveProperty("terminal");
    expect(parsed).not.toHaveProperty("taskFileSyncError");
    expect(parsed.taskFileContent).toBe("# TASK\n...");
    expect(parsed.ok).toBe(true);
  });

  it("loop summary: goal/completion/task-file-sync fields strip away", () => {
    const parsed = frozenLoopSummary.parse(PHASE4_LOOP_SUMMARY);
    for (const key of [
      "goal",
      "completedAt",
      "completionReason",
      "taskFileSyncedAt",
      "taskFileSyncAttemptedAt",
      "taskFileSyncError",
    ]) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(parsed.cron).toBe("0 3 * * *"); // Phase 3 fields intact
  });

  it("create loop request: goal strips away", () => {
    const parsed = frozenCreateLoopRequest.parse({ machineId: "m-0123456789abcdef", goal: "g", cron: "0 3 * * *" });
    expect(parsed).not.toHaveProperty("goal");
    expect(parsed.cron).toBe("0 3 * * *");
  });
});

describe("P4: the current reader still accepts Phase 3 goldens (fields absent)", () => {
  it("poll / report / summary / create all parse without any Phase 4 field", () => {
    expect(pollRequestSchema.parse({ host: "mbp", availableSlots: 1 })).toEqual({
      host: "mbp",
      availableSlots: 1,
    });
    expect(pollResponseSchema.parse({ deliveries: [] })).toEqual({ deliveries: [] });
    expect(reportRequestSchema.parse({ ok: false, error: "boom" })).toEqual({ ok: false, error: "boom" });
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef" })).toEqual({
      machineId: "m-0123456789abcdef",
    });
    const summary = loopSummarySchema.parse({
      id: "l",
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
      cron: null,
      timezone: "UTC",
      nextFireAt: null,
    });
    expect(summary).not.toHaveProperty("goal");
  });
});

describe("P5: loop_completed never joins the trigger success union", () => {
  it("BOTH the frozen Phase 3 reader AND the current schema reject a loop_completed reason literal", () => {
    const body = { enqueued: false, reason: "loop_completed" };
    expect(() => frozenTriggerRunResponse.parse(body)).toThrow();
    expect(() => triggerRunResponseSchema.parse(body)).toThrow();
  });

  it("the conflict rides the 409 apiError shape with a stable code", () => {
    const parsed = apiErrorSchema.parse({ error: "loop is completed", code: LOOP_COMPLETED_CODE });
    expect(parsed.code).toBe("loop_completed");
    expect(LOOP_COMPLETED_CODE).toBe("loop_completed");
    expect(LOOP_NOT_COMPLETED_CODE).toBe("loop_not_completed");
  });
});
