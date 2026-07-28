/**
 * Report: POST /machine/report — the daemon's run finalize.
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

import { RUN_OUTCOMES } from "./enums.js";

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
  /** Latest content of the loop's task file (durable context+log doc). */
  taskFileContent: z.string().optional(),
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
