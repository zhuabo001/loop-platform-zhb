/**
 * Observation-surface queries (goal §4/§6.5): deterministic ordering BEFORE
 * truncation, exec-only `lastRun`, `ts`-as-last-transition re-ordering, and
 * exact field picks (no sensitive columns, explicit nulls).
 */
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines, runs, type NewMachine } from "../db/schema.js";
import { FakeClock, seedLoop, seedRun } from "../testkit/index.js";
import {
  createLoopAdmin,
  LOOP_LIST_CAP,
  MACHINE_LIST_CAP,
  RUN_LIST_CAP,
  type LoopAdmin,
} from "./index.js";

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

/** Machines with caller-chosen names (testkit's seedMachine fixes name=""). */
async function seedMachineRow(id: string, name: string, extra: Partial<NewMachine> = {}): Promise<void> {
  await db.insert(machines).values({ id, name, tokenHash: `hash-${id}`, createdAt: "2026-07-01T00:00:00.000Z", ...extra });
}

const iso = (seconds: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + seconds * 1000).toISOString();

describe("listMachines", () => {
  it("sorts name ASC then id ASC and picks exactly the summary fields", async () => {
    await fresh();
    await seedMachineRow("m-bbb", "alpha");
    await seedMachineRow("m-aaa", "alpha"); // same name ⇒ id ASC decides
    await seedMachineRow("m-ccc", "", { hostname: null, platform: null, arch: null, daemonVersion: null, lastSeen: null });

    const list = await admin.listMachines();
    expect(list.map((m) => m.id)).toEqual(["m-ccc", "m-aaa", "m-bbb"]); // "" < "alpha"
    expect(list[1]).toEqual({
      id: "m-aaa",
      name: "alpha",
      hostname: null,
      platform: null,
      arch: null,
      daemonVersion: null,
      lastSeen: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    // Exact key set — tokenHash/roots can never ride along.
    expect(Object.keys(list[1]!).sort()).toEqual(
      ["arch", "createdAt", "daemonVersion", "hostname", "id", "lastSeen", "name", "platform"].sort(),
    );
  });

  it("caps at 100 AFTER sorting — the sort-last row is the one dropped", async () => {
    await fresh();
    await seedMachineRow("m-zzz", "zzz"); // inserted FIRST, sorts LAST
    for (let i = 0; i < MACHINE_LIST_CAP; i += 1) {
      await seedMachineRow(`m-${String(i).padStart(3, "0")}`, `a${String(i).padStart(3, "0")}`);
    }
    const list = await admin.listMachines();
    expect(list).toHaveLength(MACHINE_LIST_CAP);
    expect(list.some((m) => m.id === "m-zzz")).toBe(false);
    expect(list[0]!.id).toBe("m-000");
  });
});

describe("listLoops", () => {
  it("breaks equal updatedAt ties by id ASC", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-b", updatedAt: iso(5) });
    await seedLoop(db, { id: "loop-a", updatedAt: iso(5) });

    expect((await admin.listLoops()).map((loop) => loop.id)).toEqual(["loop-a", "loop-b"]);
  });

  it("sorts updatedAt DESC then id ASC; lastRun is the latest EXEC run only", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-old", updatedAt: iso(1) });
    await seedLoop(db, { id: "loop-new", updatedAt: iso(3) });
    await seedLoop(db, { id: "loop-mid", updatedAt: iso(2) });

    // loop-new: two exec runs — latest ts wins …
    await seedRun(db, { id: "run-older", loopId: "loop-new", ts: iso(10) });
    await seedRun(db, { id: "run-newer", loopId: "loop-new", ts: iso(20) });
    // … and a NEWER non-exec run must NOT become lastRun (Phase 3 roles).
    await seedRun(db, { id: "run-evolve", loopId: "loop-new", role: "evolve", ts: iso(30) });
    // loop-mid: same-ts tie broken by id DESC.
    await seedRun(db, { id: "run-a", loopId: "loop-mid", ts: iso(40) });
    await seedRun(db, { id: "run-b", loopId: "loop-mid", ts: iso(40) });
    // loop-old: no runs at all.

    const list = await admin.listLoops();
    expect(list.map((l) => l.id)).toEqual(["loop-new", "loop-mid", "loop-old"]);
    expect(list[0]!.lastRun).toMatchObject({ id: "run-newer", role: "exec" });
    expect(list[1]!.lastRun).toMatchObject({ id: "run-b" });
    expect(list[2]!.lastRun).toBeNull();
  });

  it("pins the full LoopSummary nullability on a freshly created loop", async () => {
    await fresh();
    await seedMachineRow("m-0123456789abcdef", "mbp");
    const created = await admin.createLoop({ machineId: "m-0123456789abcdef" });
    expect(created.created).toBe(true);
    const list = await admin.listLoops();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: "loop-1",
      machineId: "m-0123456789abcdef",
      name: null,
      workdir: null,
      taskFile: null,
      agent: "claude-code",
      allowControl: true,
      enabled: true,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      lastRun: null,
    });
  });

  it("caps at 100 AFTER sorting — the oldest-updated loop is the one dropped", async () => {
    await fresh();
    for (let i = 0; i < LOOP_LIST_CAP; i += 1) {
      await seedLoop(db, { id: `loop-${String(i).padStart(3, "0")}`, updatedAt: iso(i + 1) });
    }
    await seedLoop(db, { id: "loop-oldest", updatedAt: iso(0) }); // inserted LAST, sorts LAST
    const list = await admin.listLoops();
    expect(list).toHaveLength(LOOP_LIST_CAP);
    expect(list.some((l) => l.id === "loop-oldest")).toBe(false);
    expect(list[0]!.id).toBe(`loop-${String(LOOP_LIST_CAP - 1).padStart(3, "0")}`);
  });
});

describe("listRuns", () => {
  it("returns undefined for an unknown loop (the route's 404)", async () => {
    await fresh();
    expect(await admin.listRuns("loop-nope")).toBeUndefined();
  });

  it("sorts ts DESC then id DESC and keeps superseded runs visible", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-old", loopId: "loop-1", ts: iso(10), phase: "canceled", outcome: "skipped" });
    await seedRun(db, { id: "run-new", loopId: "loop-1", ts: iso(20), phase: "pending" });
    await seedRun(db, { id: "run-tie-a", loopId: "loop-1", ts: iso(30) });
    await seedRun(db, { id: "run-tie-b", loopId: "loop-1", ts: iso(30) });

    const list = await admin.listRuns("loop-1");
    expect(list!.map((r) => r.id)).toEqual(["run-tie-b", "run-tie-a", "run-new", "run-old"]);
    expect(list![3]).toMatchObject({ phase: "canceled", outcome: "skipped" });
  });

  it("re-orders after a transition re-stamps ts (ADR-003 决策 6: ts is NOT a creation time)", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-a", loopId: "loop-1", ts: iso(10) });
    await seedRun(db, { id: "run-b", loopId: "loop-1", ts: iso(20) });
    expect((await admin.listRuns("loop-1"))![0]!.id).toBe("run-b");

    // A lifecycle transition lands on run-a: its ts jumps to the newest.
    await db.update(runs).set({ ts: iso(30), phase: "done" }).where(eq(runs.id, "run-a"));
    const list = await admin.listRuns("loop-1");
    expect(list!.map((r) => r.id)).toEqual(["run-a", "run-b"]);
    expect(list![0]).toMatchObject({ id: "run-a", phase: "done" });
  });

  it("normalizes the stored progress row's optional `at` to an explicit null", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-no-at", loopId: "loop-1", ts: iso(10), progress: { step: 1, label: "editing" } });
    await seedRun(db, {
      id: "run-with-at",
      loopId: "loop-1",
      ts: iso(20),
      progress: { step: 2, label: "testing", at: iso(20) },
    });
    const list = await admin.listRuns("loop-1");
    expect(list![0]!.progress).toEqual({ step: 2, label: "testing", at: iso(20) });
    expect(list![1]!.progress).toEqual({ step: 1, label: "editing", at: null });
  });

  it("caps at 50 AFTER sorting — the oldest run is the one dropped", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });
    for (let i = 0; i < RUN_LIST_CAP; i += 1) {
      await seedRun(db, { id: `run-${String(i).padStart(3, "0")}`, loopId: "loop-1", ts: iso(i + 1) });
    }
    await seedRun(db, { id: "run-oldest", loopId: "loop-1", ts: iso(0) }); // sorts LAST
    const list = await admin.listRuns("loop-1");
    expect(list).toHaveLength(RUN_LIST_CAP);
    expect(list!.some((r) => r.id === "run-oldest")).toBe(false);
    expect(list![0]!.id).toBe(`run-${String(RUN_LIST_CAP - 1).padStart(3, "0")}`);
  });
});
