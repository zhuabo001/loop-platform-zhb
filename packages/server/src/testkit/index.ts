/**
 * Shared test fixtures — TEST-ONLY (excluded from the build via
 * tsconfig.build.json; nothing here ships in dist or package exports).
 *
 * Deterministic seams for the coordinator tests: a FakeClock, id/credential
 * factories with predictable sequences, and tiny row-seeding helpers so each
 * test states its fixture in one line.
 */
import { asc } from "drizzle-orm";

import type { RunCoordinatorDependencies } from "../coordinator/index.js";
import type { Db } from "../db/index.js";
import { loops, machines, runs, type NewLoop, type NewRun, type Run } from "../db/schema.js";
import type { Clock } from "../time.js";

export const FIXTURE_T0 = new Date("2026-07-29T00:00:00.000Z");

export class FakeClock implements Clock {
  private t: number;
  constructor(t: number | Date = FIXTURE_T0) {
    this.t = typeof t === "number" ? t : t.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  iso(): string {
    return this.now().toISOString();
  }
}

/** Deterministic id/credential factories: `run-1`, `run-2`, … and
 *  `rk_testcred_1`, … (shape-valid per `isRunTokenShape`). Determinism lets
 *  tests assert exact rows and force PK collisions for rollback injection. */
export function makeTestFactories(): Pick<RunCoordinatorDependencies, "newRunId" | "mintRunCredential"> {
  let runN = 0;
  let credN = 0;
  return {
    newRunId: () => `run-${++runN}`,
    mintRunCredential: () => `rk_testcred_${++credN}`,
  };
}

export function testDeps(
  db: Db,
  clock: Clock = new FakeClock(),
  overrides: Partial<RunCoordinatorDependencies> = {},
): RunCoordinatorDependencies {
  return { db, clock, ...makeTestFactories(), ...overrides };
}

export async function seedMachine(db: Db, id: string, tokenHash = `hash-${id}`): Promise<void> {
  await db.insert(machines).values({ id, name: "", tokenHash, createdAt: "2026-07-01T00:00:00.000Z" });
}

export async function seedLoop(db: Db, values: Partial<NewLoop> & { id: string }): Promise<void> {
  await db.insert(loops).values({
    machineId: "m-test",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...values,
  });
}

export async function seedRun(db: Db, values: Partial<NewRun> & { id: string }): Promise<void> {
  await db.insert(runs).values({
    loopId: "loop-1",
    machineId: "m-test",
    phase: "pending",
    role: "exec",
    ts: "2026-07-01T00:00:00.000Z",
    ...values,
  });
}

/** Whole-table snapshot, id-ordered — for exact "zero writes" assertions. */
export async function snapshotRuns(db: Db): Promise<Run[]> {
  return db.select().from(runs).orderBy(asc(runs.id));
}
