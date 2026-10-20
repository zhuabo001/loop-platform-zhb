/**
 * Team-scoped observation queries (Phase 5 Batch 3 slice 5, ADR-011 决策 24):
 * MG3 (A/B/unclaimed isolation), MG4 (filter BEFORE order/limit — the whole
 * point of pushing the predicate into SQL) and MG5 (loop creation binds the
 * machine to the session team).
 */
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops } from "../db/schema.js";
import { FakeClock, seedLoop, seedMachine, seedRun, TEST_TEAM_ID } from "../testkit/index.js";
import { createLoopAdmin, LOOP_LIST_CAP, MACHINE_LIST_CAP, type LoopAdmin } from "./index.js";

const TEAM_B = "t-ffffffffffffffff";
const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let admin: LoopAdmin;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  let n = 0;
  admin = createLoopAdmin({ db, clock: new FakeClock(), newLoopId: () => `loop-${++n}` });
}

const iso = (seconds: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + seconds * 1000).toISOString();

describe("MG3: list isolation across A / B / unclaimed", () => {
  it("machines and loops show only the session team's rows", async () => {
    await fresh();
    await seedMachine(db, "m-a", { name: "a", teamId: TEST_TEAM_ID });
    await seedMachine(db, "m-b", { name: "b", teamId: TEAM_B });
    await seedMachine(db, "m-unclaimed", { name: "u" }); // teamId null
    await seedLoop(db, { id: "loop-a", machineId: "m-a" });
    await seedLoop(db, { id: "loop-b", machineId: "m-b" });
    await seedLoop(db, { id: "loop-u", machineId: "m-unclaimed" });

    expect((await admin.listMachines(TEST_TEAM_ID)).map((m) => m.id)).toEqual(["m-a"]);
    expect((await admin.listMachines(TEAM_B)).map((m) => m.id)).toEqual(["m-b"]);
    expect((await admin.listLoops(TEST_TEAM_ID)).map((l) => l.id)).toEqual(["loop-a"]);
    expect((await admin.listLoops(TEAM_B)).map((l) => l.id)).toEqual(["loop-b"]);

    // Run lists: the join IS the ownership check — a foreign loop is the same
    // `undefined` as a missing one.
    await seedRun(db, { id: "run-a", loopId: "loop-a", machineId: "m-a" });
    expect((await admin.listRuns("loop-a", TEST_TEAM_ID))!.map((r) => r.id)).toEqual(["run-a"]);
    expect(await admin.listRuns("loop-a", TEAM_B)).toBeUndefined();
    expect(await admin.listRuns("loop-b", TEST_TEAM_ID)).toBeUndefined();
    expect(await admin.listRuns("loop-u", TEST_TEAM_ID)).toBeUndefined();

    // The single summary is scoped the same way.
    expect(await admin.getLoopSummary("loop-a", TEST_TEAM_ID)).toBeDefined();
    expect(await admin.getLoopSummary("loop-a", TEAM_B)).toBeUndefined();
    expect(await admin.getLoopSummary("loop-u", TEST_TEAM_ID)).toBeUndefined();
  });

  it("the Dashboard's temporary unscoped read still sees every loop", async () => {
    await fresh();
    await seedMachine(db, "m-b", { teamId: TEAM_B });
    await seedMachine(db, "m-u");
    await seedLoop(db, { id: "loop-b", machineId: "m-b" });
    await seedLoop(db, { id: "loop-u", machineId: "m-u" });
    expect((await admin.listLoopsUnscoped()).map((l) => l.id).sort()).toEqual(["loop-b", "loop-u"]);
  });
});

describe("MG4: filtering happens BEFORE ordering and limiting", () => {
  it("a team's only loop survives 100+ newer rows from another team", async () => {
    await fresh();
    await seedMachine(db, "m-a", { name: "zz-a", teamId: TEST_TEAM_ID });
    await seedMachine(db, "m-b", { name: "aa-b", teamId: TEAM_B });
    for (let i = 0; i < LOOP_LIST_CAP; i += 1) {
      await seedLoop(db, {
        id: `loop-b-${String(i).padStart(3, "0")}`,
        machineId: "m-b",
        updatedAt: iso(1000 + i),
      });
    }
    await seedLoop(db, { id: "loop-a", machineId: "m-a", updatedAt: iso(1) });

    const list = await admin.listLoops(TEST_TEAM_ID);
    expect(list.map((l) => l.id)).toEqual(["loop-a"]);
  });

  it("a team's machine survives 100 better-sorting rows from another team", async () => {
    await fresh();
    for (let i = 0; i < MACHINE_LIST_CAP; i += 1) {
      await seedMachine(db, `m-b-${String(i).padStart(3, "0")}`, {
        name: `a${String(i).padStart(3, "0")}`,
        teamId: TEAM_B,
      });
    }
    await seedMachine(db, "m-a", { name: "zz-a", teamId: TEST_TEAM_ID });

    expect((await admin.listMachines(TEST_TEAM_ID)).map((m) => m.id)).toEqual(["m-a"]);
  });
});

describe("MG5: loop creation binds the machine to the session team", () => {
  it("accepts an own machine and refuses foreign, unclaimed and missing ones with zero writes", async () => {
    await fresh();
    await seedMachine(db, "m-a", { teamId: TEST_TEAM_ID });
    await seedMachine(db, "m-b", { teamId: TEAM_B });
    await seedMachine(db, "m-u"); // unclaimed

    const created = await admin.createLoop({ machineId: "m-a", taskFile: "/srv/TASK.md" }, TEST_TEAM_ID);
    expect(created.created).toBe(true);

    for (const machineId of ["m-b", "m-u", "m-missing"]) {
      const refused = await admin.createLoop({ machineId, taskFile: "/srv/TASK.md" }, TEST_TEAM_ID);
      expect(refused, machineId).toEqual({ created: false, reason: "machine_not_found" });
    }

    // Only the one successful create exists — and it is bound to m-a.
    const rows = await db.select().from(loops).orderBy(loops.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.machineId).toBe("m-a");
  });
});
