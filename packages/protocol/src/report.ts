/**
 * Report: POST /api/machine/report — the daemon's run finalize.
 *
 * Auth is the run lease (`Authorization: Bearer <rk_…>`); the server resolves
 * the run from the LEASE, so `runId` in the body is a mere echo (ignored for
 * lookup). Field set mirrors the reference report body
 * (loop-platform packages/daemon/src/runner.ts `ReportBody`,
 * packages/server/src/gateway/index.ts:1291-1316).
 *
 * NOT in this body (different surfaces, later phases): `status`/`state` (the
 * in-run `loopany report --status/--state` CLI verb writes those) and
 * watch/sync manifests.
 */
import { z } from "zod";

import { RUN_OUTCOMES, RUN_STATUSES } from "./enums.js";
import { jsonObjectSchema } from "./json.js";

/** The outcome subset a daemon may CLAIM. `error`/`skipped` are server-assigned
 *  (sweep reclaim / supersede), never reportable. */
export const REPORT_OUTCOMES = ["direct", "silent", "exec", "evolve"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];
export const reportOutcomeSchema = z.enum(REPORT_OUTCOMES);

/** Compile-time guard: the claimable set must stay a subset of RunOutcome. */
const _reportOutcomesAreRunOutcomes: readonly (typeof RUN_OUTCOMES)[number][] = REPORT_OUTCOMES;
void _reportOutcomesAreRunOutcomes;

/** A file the run's agent session created or edited (transcript-derived). */
export const runArtifactSchema = z.object({
  path: z.string(),
  kind: z.enum(["created", "edited"]),
});
export type RunArtifact = z.infer<typeof runArtifactSchema>;

/** One slimmed step of the run's execution trace. */
export const transcriptStepSchema = z.object({
  kind: z.enum(["text", "tool", "result"]),
  text: z.string().optional(),
  /** Tool name (kind === "tool"). */
  name: z.string().optional(),
  /** Compact JSON of the tool input (kind === "tool"). */
  input: z.string().optional(),
});
export type TranscriptStep = z.infer<typeof transcriptStepSchema>;

/** Agent-reported cost/usage for the run. All optional — an older daemon or a
 *  timed-out run reports none. */
export const costReportSchema = z.object({
  usd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  numTurns: z.number().int().nonnegative().optional(),
});
export type CostReport = z.infer<typeof costReportSchema>;

// ---- Phase 4 terminal command (ADR-009; dormant until Batch 2 wires it) ----

/** Why a task-file sync failed — the daemon's stable classification set. */
export const TASK_FILE_SYNC_ERRORS = ["missing", "unreadable", "outside_jail", "changed", "too_large"] as const;
export type TaskFileSyncError = (typeof TASK_FILE_SYNC_ERRORS)[number];
export const taskFileSyncErrorSchema = z.enum(TASK_FILE_SYNC_ERRORS);

/** terminal report variant: `new`/`resolved` MUST carry a message (enforced
 *  by the refinement on `terminalCommandSchema`); `nothing-new` may omit it. */
export const terminalReportCommandSchema = z.object({
  kind: z.literal("report"),
  status: z.enum(RUN_STATUSES),
  message: z.string().optional(),
  state: jsonObjectSchema.optional(),
});
export type TerminalReportCommand = z.infer<typeof terminalReportCommandSchema>;

/** terminal finish variant: `reason` is REQUIRED (non-empty is policy, not
 *  schema); message is optional and falls back to the reason server-side. */
export const terminalFinishCommandSchema = z.object({
  kind: z.literal("finish"),
  reason: z.string(),
  message: z.string().optional(),
  state: jsonObjectSchema.optional(),
});
export type TerminalFinishCommand = z.infer<typeof terminalFinishCommandSchema>;

/** The terminal command a v1 success report must carry: the daemon's Journal
 *  record, discriminated on `kind`. `state` (top-level JSON object, shape
 *  only — value policy lives in terminal-policy.ts) rides either variant. */
export const terminalCommandSchema = z
  .union([terminalReportCommandSchema, terminalFinishCommandSchema])
  .superRefine((cmd, ctx) => {
    if (cmd.kind === "report" && cmd.status !== "nothing-new" && cmd.message === undefined) {
      ctx.addIssue({ code: "custom", message: "message is required for new/resolved", path: ["message"] });
    }
  });
export type TerminalCommand = z.infer<typeof terminalCommandSchema>;

export const reportRequestSchema = z.object({
  /** Echo only — the lease resolved from the Bearer token is authoritative. */
  runId: z.string().optional(),
  ok: z.boolean(),
  outcome: reportOutcomeSchema.optional(),
  /** Final one-line message (workflow's direct message, or the run summary). */
  message: z.string().optional(),
  /** Failure detail; absent on failure ⇒ the server writes a generic reason. */
  error: z.string().optional(),
  /** Agent's terminal text — used only as a message fallback. */
  finalText: z.string().optional(),
  /** Workflow cursor (free-form) → persisted as loop.state for the next run. */
  cursor: z.unknown().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Agent session id on the machine (locates the local transcript). */
  sessionId: z.string().optional(),
  /** Latest content of the loop's task file (durable context+log doc). Phase 4
   *  reinterprets it for v1 reports: with `terminal` present it is THE task
   *  file sync result — exactly one of content / `taskFileSyncError`
   *  (terminal-policy.ts). */
  taskFileContent: z.string().optional(),
  /** Why the task-file sync failed (v1 reports; mutually exclusive with
   *  `taskFileContent` — enforced by policy, not schema). */
  taskFileSyncError: taskFileSyncErrorSchema.optional(),
  /** Phase 4 terminal command (ADR-009). Authoritative ONLY for leases minted
   *  with terminalProtocolVersion=1; a v0 lease ignores it entirely. */
  terminal: terminalCommandSchema.optional(),
  artifacts: z.array(runArtifactSchema).optional(),
  transcript: z.array(transcriptStepSchema).optional(),
  cost: costReportSchema.optional(),
  /** Total agent invocations — sent only when > 1 (transient-failure resume). */
  attempts: z.number().int().positive().optional(),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const reportResponseSchema = z.object({
  ok: z.literal(true),
  /** Present only when this report was the ONE reconciling wake-report for a
   *  sweep-reclaimed (terminal-grace) run — see ADR-001 T5. */
  reconciled: z.boolean().optional(),
});
export type ReportResponse = z.infer<typeof reportResponseSchema>;
