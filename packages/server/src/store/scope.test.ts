/**
 * Ownership-chain reads (Phase 5 Batch 3 slice 5, ADR-011 决策 24/25).
 *
 * The invariant under test is the ONE derivation: run → loop → machine → team.
 * `runs.machineId` is a redundant copy and must NOT decide ownership — the
 * disagreement case below is the regression for that.
 */
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { seedClaimedMachineById, seedLoop, seedMachine, seedRun, TEST_TEAM_ID } from "../testkit/index.js";
import { getLoopTeam, getRunTeam, teamMatches } from "./scope.js";

const handles: DbHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await closeDb(handle);
});

async function fresh(): Promise<Db> {
  const handle = await openMigratedDb();
  handles.push(handle);
  return handle.db;
}

describe("getLoopTeam", () => {
  it("resolves a claimed machine's team", async () => {
    const db = await fresh();
    await seedClaimedMachineById(db, "m-own");
    await seedLoop(db, { id: "loop-own", machineId: "m-own" });

    expect(await getLoopTeam(db, "loop-own")).toEqual({ found: true, teamId: TEST_TEAM_ID });
  });

  it("reports an UNCLAIMED machine's loop as teamId null (not a match)", async () => {
    const db = await fresh();
    await seedMachine(db, "m-unclaimed");
    await seedLoop(db, { id: "loop-unclaimed", machineId: "m-unclaimed" });

    expect(await getLoopTeam(db, "loop-unclaimed")).toEqual({ found: true, teamId: null });
    expect(teamMatches(null, TEST_TEAM_ID)).toBe(false);
  });

  it("is found:false for a missing loop AND for an orphan loop (no machine row)", async () => {
    const db = await fresh();
    await seedLoop(db, { id: "loop-orphan", machineId: "m-never-seeded" });

    expect(await getLoopTeam(db, "loop-missing")).toEqual({ found: false });
    expect(await getLoopTeam(db, "loop-orphan")).toEqual({ found: false });
  });
});

describe("getRunTeam", () => {
  it("derives the team through the run's LOOP, not runs.machineId", async () => {
    const db = await fresh();
    await seedClaimedMachineById(db, "m-own");
    await seedMachine(db, "m-other");
    await seedLoop(db, { id: "loop-own", machineId: "m-own" });
    // The denormalized copy points elsewhere on purpose.
    await seedRun(db, { id: "run-1", loopId: "loop-own", machineId: "m-other" });

    expect(await getRunTeam(db, "run-1")).toEqual({ found: true, teamId: TEST_TEAM_ID });
  });

  it("folds a missing run and an orphan chain into found:false", async () => {
    const db = await fresh();
    await seedLoop(db, { id: "loop-orphan", machineId: "m-never-seeded" });
    await seedRun(db, { id: "run-orphan", loopId: "loop-orphan", machineId: "m-never-seeded" });

    expect(await getRunTeam(db, "run-missing")).toEqual({ found: false });
    expect(await getRunTeam(db, "run-orphan")).toEqual({ found: false });
  });

  it("reports an unclaimed loop's run as teamId null", async () => {
    const db = await fresh();
    await seedMachine(db, "m-unclaimed");
    await seedLoop(db, { id: "loop-unclaimed", machineId: "m-unclaimed" });
    await seedRun(db, { id: "run-unclaimed", loopId: "loop-unclaimed", machineId: "m-unclaimed" });

    expect(await getRunTeam(db, "run-unclaimed")).toEqual({ found: true, teamId: null });
  });
});

describe("teamMatches", () => {
  it("is true only for a non-null exact match", () => {
    expect(teamMatches(TEST_TEAM_ID, TEST_TEAM_ID)).toBe(true);
    expect(teamMatches(TEST_TEAM_ID, "t-ffffffffffffffff")).toBe(false);
    expect(teamMatches(null, TEST_TEAM_ID)).toBe(false);
    expect(teamMatches("", "")).toBe(false);
  });
});
