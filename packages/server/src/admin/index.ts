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
import { loops, machines, runs } from "../db/schema.js";
import { getMachine } from "../store/machines.js";
import { getLoop } from "../store/runs.js";
import type { Clock } from "../time.js";
import { LoopValidationError } from "./errors.js";
import { toLoopSummary, toMachineSummary, toRunSummary, type LoopSummaryRow, type RunSummaryRow } from "./views.js";

/** Server-side length ceilings (goal §2). Exceeding ⇒ LoopValidationError. */
export const LOOP_NAME_CAP = 255;
export const LOOP_PATH_CAP = 4096;

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
  | { created: true; loop: LoopSummary }
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

      const machine = await getMachine(deps.db, input.machineId);
      if (!machine) return { created: false as const, reason: "machine_not_found" as const };

      const nowIso = deps.clock.now().toISOString();
      const inserted: LoopSummaryRow[] = await deps.db
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
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .returning(loopSummaryColumns);
      return { created: true as const, loop: toLoopSummary(inserted[0]!, null) };
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
      return loopRows.map((row) => {
        const lastRun = latestByLoop.get(row.id);
        return toLoopSummary(row, lastRun ? toRunSummary(lastRun) : null);
      });
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
