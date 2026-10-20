/**
 * Team-scope ownership reads (Phase 5 Batch 3 slice 5, ADR-011 决策 24/25).
 *
 * There is exactly ONE ownership derivation in this batch:
 *
 *   Run → its Loop → that Loop's Machine → the Machine's Team
 *
 * `runs.machineId` is a redundant copy written at enqueue time; it is NOT an
 * ownership input (the management chain must agree with the scheduler, the
 * enqueue gate and the Artifact attribution, all of which go through the loop).
 *
 * `found: false` folds three different failures into one fail-closed answer —
 * the run/loop row is missing, the machine row is missing (an orphan), or the
 * join produced nothing. Callers turn it into the flat 404; distinguishing the
 * three would leak existence across team scopes.
 *
 * The projection is deliberately narrow: `{ teamId }` only, so a scope check
 * never brings `token_hash` or a Run's large columns into application memory.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { loops, machines, runs } from "../db/schema.js";

export type TeamOwnership = { found: false } | { found: true; teamId: string | null };

/** The team that owns a Loop (through its Machine), or `found: false`. */
export async function getLoopTeam(db: Db, loopId: string): Promise<TeamOwnership> {
  const rows = await db
    .select({ teamId: machines.teamId })
    .from(loops)
    .innerJoin(machines, eq(machines.id, loops.machineId))
    .where(eq(loops.id, loopId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? { found: false } : { found: true, teamId: row.teamId };
}

/** The team that owns a Run, derived through its Loop (never `runs.machineId`). */
export async function getRunTeam(db: Db, runId: string): Promise<TeamOwnership> {
  const rows = await db
    .select({ teamId: machines.teamId })
    .from(runs)
    .innerJoin(loops, eq(loops.id, runs.loopId))
    .innerJoin(machines, eq(machines.id, loops.machineId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? { found: false } : { found: true, teamId: row.teamId };
}

/** The ONE ownership predicate shared by the HTTP gates and the Artifact reads.
 *  An Unclaimed Machine (`teamId === null`) matches no session team. */
export function teamMatches(teamId: string | null, sessionTeamId: string): boolean {
  return teamId !== null && teamId !== "" && sessionTeamId !== "" && teamId === sessionTeamId;
}
