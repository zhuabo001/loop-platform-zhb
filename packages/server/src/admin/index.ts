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

import type { CreateLoopRequest, LoopSummary } from "@loopzhb/protocol";

import type { Db } from "../db/index.js";
import { loops } from "../db/schema.js";
import { getMachine } from "../store/machines.js";
import { getLoop } from "../store/runs.js";
import type { Clock } from "../time.js";
import { LoopValidationError } from "./errors.js";
import { toLoopSummary } from "./views.js";

/** Server-side length ceilings (goal §2). Exceeding ⇒ LoopValidationError. */
export const LOOP_NAME_CAP = 255;
export const LOOP_PATH_CAP = 4096;

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
      const inserted = await deps.db
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
        .returning();
      return { created: true as const, loop: toLoopSummary(inserted[0]!, null) };
    },

    /** Existence check for routes that 404 on an unknown loop. */
    async loopExists(loopId: string): Promise<boolean> {
      return (await getLoop(deps.db, loopId)) !== undefined;
    },
  };
}

export type LoopAdmin = ReturnType<typeof createLoopAdmin>;
