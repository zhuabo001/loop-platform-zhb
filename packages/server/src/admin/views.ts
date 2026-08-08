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

export function toMachineSummary(row: Machine): MachineSummary {
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

export function toRunSummary(row: Run): RunSummary {
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

export function toLoopSummary(row: Loop, lastRun: RunSummary | null): LoopSummary {
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
  };
}
