/**
 * Safe view mappers (goal §5 可靠性约束): every response row is built by
 * EXPLICITLY PICKING fields — never by spreading a DB row and deleting a few.
 * A new sensitive column added to a heart table must never leak into the
 * observation surface by default.
 *
 * Nullability is normalized to the wire DTOs (`@loopzhb/protocol` admin.ts):
 * explicit `null`, never an omitted key — e.g. the stored progress row's
 * optional `at` becomes `at: null`.
 */
import type { LoopSummary, MachineSummary, RunSummary } from "@loopzhb/protocol";

import type { Loop, Machine, Run } from "../db/schema.js";
import { nextOccurrence } from "../schedule/time-semantics.js";

/** The deliberately narrow row shapes observation queries may load: large,
 *  unopened or sensitive columns (runs.transcript/artifacts/usage/session/
 *  state, loops.workflow/model/state/task-file content, machines.tokenHash/
 *  roots) are excluded before data leaves the database — a column added to a
 *  heart table later is excluded by DEFAULT until a query opts in. */
export type MachineSummaryRow = Pick<
  Machine,
  "id" | "name" | "hostname" | "platform" | "arch" | "daemonVersion" | "lastSeen" | "createdAt"
>;

export type LoopSummaryRow = Pick<
  Loop,
  | "id"
  | "machineId"
  | "name"
  | "workdir"
  | "taskFile"
  | "agent"
  | "allowControl"
  | "enabled"
  | "createdAt"
  | "updatedAt"
  | "cron"
  | "timezone"
>;

export type RunSummaryRow = Pick<
  Run,
  | "id"
  | "loopId"
  | "machineId"
  | "phase"
  | "role"
  | "ts"
  | "outcome"
  | "status"
  | "message"
  | "error"
  | "durationMs"
  | "progress"
>;

export function toMachineSummary(row: MachineSummaryRow): MachineSummary {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    daemonVersion: row.daemonVersion,
    lastSeen: row.lastSeen,
    createdAt: row.createdAt,
  };
}

export function toRunSummary(row: RunSummaryRow): RunSummary {
  return {
    id: row.id,
    loopId: row.loopId,
    machineId: row.machineId,
    phase: row.phase,
    role: row.role,
    ts: row.ts,
    outcome: row.outcome,
    status: row.status,
    message: row.message,
    error: row.error,
    durationMs: row.durationMs,
    progress: row.progress
      ? { step: row.progress.step, label: row.progress.label, at: row.progress.at ?? null }
      : null,
  };
}

export function toLoopSummary(
  row: LoopSummaryRow,
  lastRun: RunSummary | null,
  nextFireAt: string | null = null
): LoopSummary {
  return {
    id: row.id,
    machineId: row.machineId,
    name: row.name,
    workdir: row.workdir,
    taskFile: row.taskFile,
    agent: row.agent,
    allowControl: row.allowControl,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRun,
    cron: row.cron ?? null,
    timezone: row.timezone,
    nextFireAt,
    // Phase 4 observation fields (goal/completion/task-file sync) are NOT
    // emitted while Batch 1 keeps them dormant (ADR-009 决策 11) — the
    // response stays byte-identical to Phase 3.
  };
}

/**
 * The ONE nextFireAt computation for the observation surface: the schedule's
 * next occurrence after `now`, or null for paused/manual-only loops. A schedule
 * that fails to compute (corrupted persisted state, DST discontinuity) degrades
 * to null rather than failing the whole response — persisted rows were already
 * validated on write, so a throw here is defensive depth, not a data error.
 */
export function nextFireAtIso(
  row: Pick<LoopSummaryRow, "enabled" | "cron" | "timezone">,
  now: Date,
): string | null {
  if (!row.enabled || row.cron === null) return null;
  try {
    const next = nextOccurrence({ cron: row.cron, timezone: row.timezone }, now);
    return next === null ? null : next.toISOString();
  } catch {
    return null;
  }
}
