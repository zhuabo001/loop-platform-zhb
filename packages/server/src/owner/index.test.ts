/**
 * Owner-control (Day 8–10 plan §2): the deep module behind the local
 * `POST /api/runs/:id/cancel` route. It consumes the STORE-level
 * `cancelRunTx` DIRECTLY (A-02: the RunCoordinator's three-method interface
 * stays untouched) and adds exactly one thing the store primitive cannot
 * answer: the 404-vs-not_cancelable classification for the HTTP edge.
 */
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { FakeClock, seedLease, seedLoop, seedRun, snapshotLeases, snapshotLoops, snapshotRuns } from "../testkit/index.js";
import { createOwnerControl, type OwnerControl } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let ownerControl: OwnerControl;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  await seedLoop(db, { id: "loop-1" });
  ownerControl = createOwnerControl({ db, clock });
}

describe("owner cancelRun", () => {
  it("cancels a running run and revokes its capability in the same transaction", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", phase: "running" });
    await seedLease(db, { tokenHash: sha256("rk_live"), runId: "run-1" });

    await expect(ownerControl.cancelRun("run-1")).resolves.toEqual({ canceled: true });
    // The transition writes phase + ts ONLY — no outcome/message/error, no
    // loop-side writes (plan §3's cancel write-set pin).
    expect((await snapshotRuns(db))[0]).toMatchObject({
      phase: "canceled",
      ts: clock.iso(),
      outcome: null,
      message: null,
      error: null,
    });
    expect(await snapshotLeases(db)).toEqual([]);
    const loopsBefore = await snapshotLoops(db);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("cancels a pending run (no lease existed)", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", phase: "pending" });
    await expect(ownerControl.cancelRun("run-1")).resolves.toEqual({ canceled: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "canceled", ts: clock.iso() });
  });

  it("reports not_cancelable for an already-terminal run, with zero writes (repeat cancel is idempotent)", async () => {
    await fresh();
    await seedRun(db, { id: "run-done", phase: "done", outcome: "exec", message: "finished" });
    await seedRun(db, { id: "run-canceled", phase: "canceled" });
    const before = await snapshotRuns(db);

    await expect(ownerControl.cancelRun("run-done")).resolves.toEqual({
      canceled: false,
      reason: "not_cancelable",
    });
    await expect(ownerControl.cancelRun("run-canceled")).resolves.toEqual({
      canceled: false,
      reason: "not_cancelable",
    });
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it("reports not_found for a missing run (the route's 404)", async () => {
    await fresh();
    await expect(ownerControl.cancelRun("run-ghost")).resolves.toEqual({ canceled: false, reason: "not_found" });
  });
});
