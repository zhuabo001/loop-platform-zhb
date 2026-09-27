/**
 * The Dashboard READ module (Phase 4 Batch 3 plan §2 切片一): ONE narrow,
 * read-only seam answering "what does the local Dashboard show right now".
 *
 * It owns no HTTP concern (slice 2 mounts the routes and owns CSRF + loopback
 * gating) and no lifecycle write — it only reads. Two reads here are NEW: the
 * batched active-Run lookup across ALL roles, and capabilities by the machine
 * ids of THIS page's loops. Everything else is reused verbatim from the admin
 * observation surface, so the Dashboard can never grow a second, divergent
 * definition of "the latest Run", the loop ordering, or the safe projection.
 *
 * Read discipline (plan §2):
 *  - the Loop page IS `admin.listLoops()` — `updatedAt DESC, id ASC`, the
 *    100-row cap, the safe field projection, `lastRun` (latest EXEC run by
 *    `ts DESC, id DESC`) and `nextFireAt` are all inherited, not re-derived;
 *  - active state is read SEPARATELY and in BATCH, covering every role, and is
 *    never inferred from `lastRun` (a loop can have a finished latest exec Run
 *    while an OLDER Run is still running);
 *  - capability comes from the machine ids ON THIS PAGE — never from the
 *    separately-truncated machine list, and never by comparing version strings
 *    (ADR-009 决策 7: membership only).
 */
import { and, asc, desc, inArray } from "drizzle-orm";

import { hasTerminalJournalV1, type LoopSummary, type RunRole, type RunSummary } from "@loopzhb/protocol";

import { LOOP_LIST_CAP, runSummaryColumns, type LoopAdmin } from "../admin/index.js";
import { toRunSummary } from "../admin/views.js";
import type { Db } from "../db/index.js";
import { machines, runs } from "../db/schema.js";
import type { Clock } from "../time.js";
import { classifyDisplayLifecycle } from "./view.js";

/** The four ADR-009 决策 1 primary statuses under the FIXED priority
 *  Completed > Paused > (goal === null ? Open : Closed). The goal dimension
 *  stays independently readable through `DashboardLoop.loop.goal`. */
export type LoopLifecycle = "open" | "closed" | "paused" | "completed";

/** One in-flight Run as the page shows it: the safe wire projection (mapped by
 *  the shared `toRunSummary`, so `progress.at` normalization cannot drift)
 *  narrowed to the two non-terminal phases the query selects. */
export interface DashboardActiveRun {
  id: string;
  role: RunRole;
  phase: "pending" | "running";
  /** Last lifecycle transition (ADR-003 决策 6), not a creation time. */
  ts: string;
  progress: { step: number; label: string; at: string | null } | null;
  message: string | null;
  error: string | null;
}

export interface DashboardLoop {
  /** The reused wire-safe view — already carries `lastRun` and `nextFireAt`. */
  loop: LoopSummary;
  lifecycle: LoopLifecycle;
  /** Deliberately TWO buckets: when pending and running coexist the page shows
   *  both (plan §2), and a late running Run can outlive completion. */
  pending: DashboardActiveRun[];
  running: DashboardActiveRun[];
  /** `terminal-journal-v1` membership for THIS loop's machine. false when the
   *  machine declared a snapshot without it, declared nothing (null), or has no
   *  row at all — all three fail safe to the page's upgrade hint. */
  terminalJournalV1: boolean;
}

export interface DashboardSnapshot {
  /** One Clock read for the whole page. */
  generatedAt: string;
  loops: DashboardLoop[];
  /** The page's row cap; the page states its display range from this. */
  listCap: number;
}

export interface DashboardReadDeps {
  /** Narrow read seam to the existing observation surface — the Dashboard
   *  never reaches past `listLoops` into the admin module's writes. */
  admin: Pick<LoopAdmin, "listLoops">;
  db: Db;
  clock: Clock;
}

export interface DashboardRead {
  snapshot(): Promise<DashboardSnapshot>;
}

/** The one phase filter this module selects on. */
const ACTIVE_PHASES = ["pending", "running"] as const;

function toActiveRun(run: RunSummary): DashboardActiveRun {
  // The WHERE clause already pinned the phase set; this narrows the TYPE
  // without a cast and stays correct if the query ever widens.
  if (run.phase !== "pending" && run.phase !== "running") {
    throw new Error("active-run read returned a terminal phase");
  }
  return {
    id: run.id,
    role: run.role,
    phase: run.phase,
    ts: run.ts,
    progress: run.progress,
    message: run.message,
    error: run.error,
  };
}

export function createDashboardRead(deps: DashboardReadDeps): DashboardRead {
  return {
    async snapshot(): Promise<DashboardSnapshot> {
      const generatedAt = deps.clock.now().toISOString();
      const loopSummaries = await deps.admin.listLoops();
      if (loopSummaries.length === 0) {
        // Nothing to enrich: the two batched reads below are skipped rather
        // than issued with empty IN lists.
        return { generatedAt, loops: [], listCap: LOOP_LIST_CAP };
      }

      const loopIds = loopSummaries.map((l) => l.id);
      // Deduped: several loops usually share one machine.
      const machineIds = [...new Set(loopSummaries.map((l) => l.machineId))];

      // Exactly two batched statements — never one per loop, and never a
      // per-loop history scan.
      const [activeRows, capabilityRows] = await Promise.all([
        deps.db
          .select(runSummaryColumns)
          .from(runs)
          .where(and(inArray(runs.loopId, loopIds), inArray(runs.phase, [...ACTIVE_PHASES])))
          .orderBy(asc(runs.loopId), desc(runs.ts), desc(runs.id)),
        // id + capabilities ONLY: tokenHash/roots never leave the database.
        deps.db
          .select({ id: machines.id, capabilities: machines.capabilities })
          .from(machines)
          .where(inArray(machines.id, machineIds)),
      ]);

      const activeByLoop = new Map<string, { pending: DashboardActiveRun[]; running: DashboardActiveRun[] }>();
      for (const row of activeRows) {
        const active = toActiveRun(toRunSummary(row));
        let bucket = activeByLoop.get(row.loopId);
        if (bucket === undefined) {
          bucket = { pending: [], running: [] };
          activeByLoop.set(row.loopId, bucket);
        }
        if (active.phase === "pending") bucket.pending.push(active);
        else bucket.running.push(active);
      }

      const capabilityByMachine = new Map<string, string[] | null>();
      for (const row of capabilityRows) capabilityByMachine.set(row.id, row.capabilities);

      return {
        generatedAt,
        listCap: LOOP_LIST_CAP,
        loops: loopSummaries.map((loop) => {
          const active = activeByLoop.get(loop.id) ?? { pending: [], running: [] };
          return {
            loop,
            lifecycle: classifyDisplayLifecycle(loop),
            pending: active.pending,
            running: active.running,
            // A missing machine row yields undefined ⇒ false (fail-safe hint).
            terminalJournalV1: hasTerminalJournalV1(capabilityByMachine.get(loop.machineId)),
          };
        }),
      };
    },
  };
}
