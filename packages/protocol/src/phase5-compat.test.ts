/**
 * Phase 4 ↔ Phase 5 cross-version compatibility (Batch 1 AP12; Batch 2 slice 1
 * adds the delivery artifact config).
 *
 * The FROZEN Phase 4 readers below are self-contained zod copies of the
 * Phase 4 wire shapes. They deliberately do NOT import the current schemas —
 * a shared import would let a future Phase 5 edit silently "update" the old
 * reader and fake compatibility (同源漂移, same discipline as
 * phase4-compat.test.ts). If a Phase 5 change breaks one of these frozen
 * readers, that change is a wire-breaking change: stop.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createLoopRequestSchema, loopSummarySchema } from "./admin.js";
import { deliverySchema, pollRequestSchema, pollResponseSchema } from "./poll.js";
import { reportRequestSchema } from "./report.js";

// ---- frozen Phase 4 readers (DO NOT import the current schemas) ----

const frozenPollRequest = z.object({
  host: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  version: z.string().optional(),
  progress: z.array(z.object({ runId: z.string(), step: z.number().int().nonnegative(), label: z.string() })).optional(),
  wait: z.literal(true).optional(),
  availableSlots: z.union([z.literal(0), z.literal(1)]).optional(),
  capabilities: z.array(z.string()).optional(),
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
  goal: z.string().nullable().optional(),
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
  terminalProtocol: z.literal(1).optional(),
});

const frozenPollResponse = z.object({
  deliveries: z.array(frozenDelivery),
  requiredCapabilities: z.array(z.string()).optional(),
});

// The Phase 4 terminal command union, minus the superRefine (the message-
// required refinement is write-side behavior, not reader shape — the compat
// question here is key stripping, not message semantics).
const frozenTerminalCommand = z.union([
  z.object({
    kind: z.literal("report"),
    status: z.enum(["new", "resolved", "nothing-new"]),
    message: z.string().optional(),
    state: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("finish"),
    reason: z.string(),
    message: z.string().optional(),
    state: z.unknown().optional(),
  }),
]);

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
  taskFileSyncError: z.enum(["missing", "unreadable", "outside_jail", "changed", "too_large"]).optional(),
  terminal: frozenTerminalCommand.optional(),
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

const frozenCreateLoopRequest = z.object({
  machineId: z.string().regex(/^m-[0-9a-f]{16}$/),
  name: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
  taskFile: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  goal: z.string().min(1).nullable().optional(),
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
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  lastRun: z.unknown(),
  cron: z.string().nullable().optional(),
  timezone: z.string().optional(),
  nextFireAt: z.iso.datetime({ offset: true }).nullable().optional(),
  goal: z.string().nullable().optional(),
  completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  completionReason: z.string().nullable().optional(),
  taskFileSyncedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  taskFileSyncAttemptedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  taskFileSyncError: z.enum(["missing", "unreadable", "outside_jail", "changed", "too_large"]).nullable().optional(),
});

// ---- Phase 5 goldens (what the NEW peer actually sends) ----

const PHASE5_POLL_REQUEST = {
  host: "mbp",
  version: "0.3.0",
  capabilities: ["terminal-journal-v1", "artifact-sync-v1"],
  availableSlots: 0,
  watchDigest: "f".repeat(64),
} as const;

const PHASE5_WATCH_ITEM = {
  loopId: "loop-01",
  artifactDir: "dist",
  workdir: "/home/dev/project",
  roots: ["/home/dev"],
  configRevision: 2,
} as const;

const PHASE5_REPORT = {
  runId: "r_01",
  ok: true,
  outcome: "exec",
  message: "shipped",
  terminal: { kind: "finish", reason: "goal met", message: "shipped" },
  durationMs: 9_000,
  artifactSnapshotId: "am_01",
  artifactSyncError: "sync_failed",
} as const;

const PHASE5_DELIVERY = {
  runId: "r_01",
  runToken: `rk_${"b2".repeat(16)}`,
  role: "exec",
  loop: {
    id: "loop-01",
    name: "nightly",
    workdir: "/home/dev/project",
    taskFile: null,
    workflow: null,
    model: null,
    allowControl: true,
    artifact: { dir: "dist", configRevision: 2 },
  },
  prevState: null,
  roots: ["/home/dev"],
  systemPrompt: "",
  task: "do the thing",
} as const;

const PHASE5_LOOP_SUMMARY = {
  id: "loop-01",
  machineId: "m-0123456789abcdef",
  name: "nightly",
  workdir: null,
  taskFile: "/tmp/TASK.md",
  agent: "claude-code",
  allowControl: true,
  enabled: false,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  lastRun: null,
  cron: "0 3 * * *",
  timezone: "UTC",
  nextFireAt: null,
  goal: "triage the issue queue",
  completedAt: null,
  completionReason: null,
  taskFileSyncedAt: null,
  taskFileSyncAttemptedAt: null,
  taskFileSyncError: null,
  artifactDir: "dist",
} as const;

describe("AP12: a frozen Phase 4 reader strips every Phase 5 addition", () => {
  it("poll request: watchDigest strips away; the Phase 4 fields survive", () => {
    const parsed = frozenPollRequest.parse(PHASE5_POLL_REQUEST);
    expect(parsed).not.toHaveProperty("watchDigest");
    expect(parsed.capabilities).toEqual(["terminal-journal-v1", "artifact-sync-v1"]);
  });

  it("poll response: watch/watchDigest strip away; deliveries stay intact", () => {
    const parsed = frozenPollResponse.parse({
      deliveries: [],
      watch: [PHASE5_WATCH_ITEM],
      watchDigest: "f".repeat(64),
    });
    expect(parsed).not.toHaveProperty("watch");
    expect(parsed).not.toHaveProperty("watchDigest");
    expect(parsed.deliveries).toEqual([]);
  });

  it("report: artifactSnapshotId/artifactSyncError strip away; terminal survives", () => {
    const parsed = frozenReportRequest.parse(PHASE5_REPORT);
    expect(parsed).not.toHaveProperty("artifactSnapshotId");
    expect(parsed).not.toHaveProperty("artifactSyncError");
    expect(parsed.terminal).toEqual({ kind: "finish", reason: "goal met", message: "shipped" });
  });

  it("create loop request: artifactDir strips away; goal survives", () => {
    const parsed = frozenCreateLoopRequest.parse({ machineId: "m-0123456789abcdef", goal: "g", artifactDir: "dist" });
    expect(parsed).not.toHaveProperty("artifactDir");
    expect(parsed.goal).toBe("g");
  });

  it("loop summary: artifactDir strips away; the Phase 4 additive fields survive", () => {
    const parsed = frozenLoopSummary.parse(PHASE5_LOOP_SUMMARY);
    expect(parsed).not.toHaveProperty("artifactDir");
    expect(parsed.goal).toBe("triage the issue queue");
    expect(parsed.cron).toBe("0 3 * * *");
  });

  it("delivery: the loop's artifact config strips away; the rest of the delivery survives", () => {
    const parsed = frozenPollResponse.parse({ deliveries: [PHASE5_DELIVERY] });
    const delivery = parsed.deliveries[0];
    expect(delivery?.loop).not.toHaveProperty("artifact");
    expect(delivery?.loop.id).toBe("loop-01");
    expect(delivery?.runId).toBe("r_01");
    expect(delivery?.roots).toEqual(["/home/dev"]);
  });
});

describe("AP12: the current reader still accepts Phase 4 goldens (fields absent)", () => {
  it("poll / report / create / summary all parse without any Phase 5 field", () => {
    expect(pollRequestSchema.parse({ host: "mbp", capabilities: ["terminal-journal-v1"] })).toEqual({
      host: "mbp",
      capabilities: ["terminal-journal-v1"],
    });
    expect(pollResponseSchema.parse({ deliveries: [], requiredCapabilities: ["terminal-journal-v1"] })).toEqual({
      deliveries: [],
      requiredCapabilities: ["terminal-journal-v1"],
    });
    expect(
      reportRequestSchema.parse({ ok: true, terminal: { kind: "finish", reason: "goal met" }, taskFileContent: "# T" }),
    ).not.toHaveProperty("artifactSnapshotId");
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", goal: "g" })).toEqual({
      machineId: "m-0123456789abcdef",
      goal: "g",
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
      goal: null,
      completedAt: null,
      completionReason: null,
      taskFileSyncedAt: null,
      taskFileSyncAttemptedAt: null,
      taskFileSyncError: null,
    });
    expect(summary).not.toHaveProperty("artifactDir");
  });

  it("delivery: the current reader still accepts a Phase 4 delivery (no artifact config)", () => {
    const { artifact: _artifact, ...phase4Loop } = PHASE5_DELIVERY.loop;
    const parsed = deliverySchema.parse({ ...PHASE5_DELIVERY, loop: phase4Loop });
    expect(parsed.loop).not.toHaveProperty("artifact");
    expect(parsed.loop.id).toBe("loop-01");
    expect(parsed.runToken).toBe(`rk_${"b2".repeat(16)}`);
  });
});
