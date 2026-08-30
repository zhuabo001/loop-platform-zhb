/**
 * The loop-admin DEEP MODULE (goal §5): the local management surface behind
 * the `/api/machines` + `/api/loops*` routes. It owns machine lookup, loop
 * creation, existence checks, safe view mapping and deterministic list
 * queries — and nothing else. Run lifecycle writes stay with the
 * RunCoordinator: this module NEVER enqueues, claims, reports, or touches
 * run_leases (the trigger route calls `coordinator.enqueueExecRun` directly).
 *
 * Dependencies are injected as ONE object: `db` (lifecycle owned by boot),
 * `clock` (the ONLY time source — loop rows are stamped by the writer, ADR-003
 * 决策 5), and `newLoopId` (identity generation; production mints
 * `loop-${randomUUID()}`, tests inject a deterministic factory).
 *
 * Length ceilings live HERE, not in the wire schema (ADR-002 决策 4: caps are
 * server policy — the protocol pins shape/value-domain, the server pins size).
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { CreateLoopRequest, LoopSummary, MachineSummary, RunSummary } from "@loopzhb/protocol";

import type { Db } from "../db/index.js";
import { loops, machines, runs, type Loop } from "../db/schema.js";
import { getMachine } from "../store/machines.js";
import { getLoop } from "../store/runs.js";
import type { Clock } from "../time.js";
import { validateSchedule } from "../schedule/index.js";
import { LoopValidationError } from "./errors.js";
import {
  nextFireAtIso,
  toLoopSummary,
  toMachineSummary,
  toRunSummary,
  type RunSummaryRow,
} from "./views.js";

/** Server-side length ceilings (goal §2). Exceeding ⇒ LoopValidationError. */
export const LOOP_NAME_CAP = 255;
export const LOOP_PATH_CAP = 4096;
export const SCHEDULE_FIELD_CAP = 255;

/** Observation-surface page caps (goal §4): fixed, no pagination params in
 *  Phase 1. The SQL ORDER BY lands BEFORE the LIMIT — sort-then-truncate is
 *  pinned by tests. */
export const MACHINE_LIST_CAP = 100;
export const LOOP_LIST_CAP = 100;
export const RUN_LIST_CAP = 50;

/** Explicit DB projections for the JSON observation surface: large, unopened
 *  or sensitive columns (runs.transcript/artifacts/usage/session/state,
 *  loops.workflow/model/state/task-file content, machines.tokenHash/roots)
 *  never enter application memory. A column added to a heart table later is
 *  excluded by DEFAULT until a query opts in; the key sets are pinned to the
 *  wire DTOs by a structural test in list.test.ts. */
export const machineSummaryColumns = {
  id: machines.id,
  name: machines.name,
  hostname: machines.hostname,
  platform: machines.platform,
  arch: machines.arch,
  daemonVersion: machines.daemonVersion,
  lastSeen: machines.lastSeen,
  createdAt: machines.createdAt,
} as const;

export const loopSummaryColumns = {
  id: loops.id,
  machineId: loops.machineId,
  name: loops.name,
  workdir: loops.workdir,
  taskFile: loops.taskFile,
  agent: loops.agent,
  allowControl: loops.allowControl,
  enabled: loops.enabled,
  createdAt: loops.createdAt,
  updatedAt: loops.updatedAt,
  cron: loops.cron,
  timezone: loops.timezone,
  /** Phase 4 observation fields (ADR-009): safe to expose — no credentials,
   *  no file content. goalRevision stays internal (it is a concurrency token,
   *  not observability). */
  goal: loops.goal,
  completedAt: loops.completedAt,
  completionReason: loops.completionReason,
  taskFileSyncedAt: loops.taskFileSyncedAt,
  taskFileSyncAttemptedAt: loops.taskFileSyncAttemptedAt,
  taskFileSyncError: loops.taskFileSyncError,
} as const;

export const runSummaryColumns = {
  id: runs.id,
  loopId: runs.loopId,
  machineId: runs.machineId,
  phase: runs.phase,
  role: runs.role,
  ts: runs.ts,
  outcome: runs.outcome,
  status: runs.status,
  message: runs.message,
  error: runs.error,
  durationMs: runs.durationMs,
  progress: runs.progress,
} as const;

export interface LoopAdminDeps {
  db: Db;
  clock: Clock;
  newLoopId(): string;
}

/** Production loop-id factory (wired by src/start.ts): `loop-<uuid>`. */
export function newUuidLoopId(): string {
  return `loop-${randomUUID()}`;
}

export type CreateLoopResult =
  | {
      created: true;
      /** The wire-safe view — the HTTP response body. */
      loop: LoopSummary;
      /** The inserted full row — for the schedule-commit seam ONLY (the
       *  scheduler's reconcile needs scheduleRevision/activation, which the
       *  wire view deliberately lacks). Never serialized to a response. */
      row: Loop;
    }
  | { created: false; reason: "machine_not_found" };

export function createLoopAdmin(deps: LoopAdminDeps) {
  return {
    /**
     * Create a loop bound to an ALREADY-REGISTERED machine. Validation order
     * is deliberate: caps (400) before the machine lookup (404) before the
     * single INSERT — any failure is zero-write by construction.
     *
     * Phase 1 pins `agent`/`allowControl`/`enabled` explicitly rather than
     * relying on DDL defaults: the values are this batch's fixed policy, and
     * not-yet-open caller fields never reach the row (tolerant-reader strip
     * happened at the route; only declared fields arrive here).
     *
     * Phase 3 Batch 2: Supports cron/timezone for scheduled loops. Validates
     * schedule semantics before insertion. Sets scheduleRevision=0 and
     * scheduleActivatedAt for active scheduled loops.
     */
    async createLoop(input: CreateLoopRequest): Promise<CreateLoopResult> {
      if (input.name !== undefined && input.name.length > LOOP_NAME_CAP) {
        throw new LoopValidationError("name");
      }
      if (input.workdir !== undefined && input.workdir.length > LOOP_PATH_CAP) {
        throw new LoopValidationError("workdir");
      }
      if (input.taskFile !== undefined && input.taskFile.length > LOOP_PATH_CAP) {
        throw new LoopValidationError("taskFile");
      }
      if (input.cron !== undefined && input.cron.length > SCHEDULE_FIELD_CAP) {
        throw new LoopValidationError("cron");
      }
      if (input.timezone !== undefined && input.timezone.length > SCHEDULE_FIELD_CAP) {
        throw new LoopValidationError("timezone");
      }

      const machine = await getMachine(deps.db, input.machineId);
      if (!machine) return { created: false as const, reason: "machine_not_found" as const };

      // Validate and normalize schedule if provided. A timezone WITHOUT a cron
      // still passes through the shared validator (dummy-cron form, same rule
      // as updateSchedule) — a manual-only loop persists its timezone, so an
      // invalid one must be rejected here rather than at first schedule PATCH.
      const timezone = input.timezone ?? "UTC";
      let normalizedCron: string | null = null;
      let normalizedTimezone = timezone;

      if (input.cron !== undefined) {
        const normalized = validateSchedule(input.cron, timezone);
        normalizedCron = normalized.cron;
        normalizedTimezone = normalized.timezone;
      } else if (input.timezone !== undefined) {
        normalizedTimezone = validateSchedule("0 0 * * *", timezone).timezone;
      }

      const nowIso = deps.clock.now().toISOString();
      const isActive = normalizedCron !== null; // enabled=true by default

      // Insert with a FULL-row returning: the wire view is mapped from the row,
      // and the row itself feeds the schedule-commit seam (no post-commit
      // re-read — a failed re-read would turn a committed create into a 500).
      const inserted: Loop[] = await deps.db
        .insert(loops)
        .values({
          id: deps.newLoopId(),
          machineId: input.machineId,
          name: input.name ?? null,
          workdir: input.workdir ?? null,
          taskFile: input.taskFile ?? null,
          agent: "claude-code",
          allowControl: true,
          enabled: true,
          cron: normalizedCron,
          timezone: normalizedTimezone,
          scheduleRevision: 0,
          scheduleActivatedAt: isActive ? nowIso : null,
          lastScheduledAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .returning();

      const row = inserted[0]!;

      return { created: true as const, loop: toLoopSummary(row, null, nextFireAtIso(row, deps.clock.now())), row };
    },

    /** `name ASC, id ASC`, capped — the machine picker for loop creation. */
    async listMachines(): Promise<MachineSummary[]> {
      const rows = await deps.db
        .select(machineSummaryColumns)
        .from(machines)
        .orderBy(asc(machines.name), asc(machines.id))
        .limit(MACHINE_LIST_CAP);
      return rows.map(toMachineSummary);
    },

    /**
     * `updatedAt DESC, id ASC`, capped. Each loop's `lastRun` is its latest
     * EXEC run by `ts DESC, id DESC`. PostgreSQL DISTINCT ON performs the
     * top-1-per-loop selection in the database, so this query returns at most
     * LOOP_LIST_CAP rows regardless of Run history size. Non-exec roles never
     * appear — they are Phase 3's surface, and `ts` is the last TRANSITION time
     * (ADR-003 决策 6), so a run re-enters the top after a lifecycle write.
     *
     * Phase 3 Batch 2: Computes nextFireAt for active scheduled loops.
     */
    async listLoops(): Promise<LoopSummary[]> {
      const loopRows = await deps.db
        .select(loopSummaryColumns)
        .from(loops)
        .orderBy(desc(loops.updatedAt), asc(loops.id))
        .limit(LOOP_LIST_CAP);
      if (loopRows.length === 0) return [];

      const runRows = await deps.db
        .selectDistinctOn([runs.loopId], runSummaryColumns)
        .from(runs)
        .where(
          and(
            inArray(
              runs.loopId,
              loopRows.map((l) => l.id),
            ),
            eq(runs.role, "exec"),
          ),
        )
        .orderBy(asc(runs.loopId), desc(runs.ts), desc(runs.id));
      const latestByLoop = new Map<string, RunSummaryRow>(runRows.map((row) => [row.loopId, row]));

      const now = deps.clock.now();
      return loopRows.map((row) => {
        const lastRun = latestByLoop.get(row.id);
        return toLoopSummary(row, lastRun ? toRunSummary(lastRun) : null, nextFireAtIso(row, now));
      });
    },

    /**
     * Single-loop summary by id (the PATCH /schedule response shape):
     * the summary row plus its latest EXEC run and computed nextFireAt.
     * `undefined` when the loop does not exist.
     */
    async getLoopSummary(loopId: string): Promise<LoopSummary | undefined> {
      const row = (
        await deps.db.select(loopSummaryColumns).from(loops).where(eq(loops.id, loopId)).limit(1)
      )[0];
      if (!row) return undefined;

      const lastRunRows = await deps.db
        .select(runSummaryColumns)
        .from(runs)
        .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec")))
        .orderBy(desc(runs.ts), desc(runs.id))
        .limit(1);

      const lastRun = lastRunRows[0];
      return toLoopSummary(row, lastRun ? toRunSummary(lastRun) : null, nextFireAtIso(row, deps.clock.now()));
    },

    /** `ts DESC, id DESC`, capped; `undefined` when the loop does not exist
     *  (the route's 404). All phases/roles are listed — superseded
     *  (`canceled/skipped`) runs stay visible (goal §4). */
    async listRuns(loopId: string): Promise<RunSummary[] | undefined> {
      if ((await getLoop(deps.db, loopId)) === undefined) return undefined;
      const rows = await deps.db
        .select(runSummaryColumns)
        .from(runs)
        .where(eq(runs.loopId, loopId))
        .orderBy(desc(runs.ts), desc(runs.id))
        .limit(RUN_LIST_CAP);
      return rows.map(toRunSummary);
    },
  };
}

export type LoopAdmin = ReturnType<typeof createLoopAdmin>;
