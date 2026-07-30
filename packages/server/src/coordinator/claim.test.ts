/**
 * Poll — claim path heart tests (ADR-001):
 *
 *  T1  concurrent polls for the same pending run: exactly ONE wins a delivery;
 *      the loser sees nothing. One running run, one active lease, one mint.
 *  T2  a claimed run is never re-delivered: repeat polls return empty, no new
 *      run/lease/credential. This doubles as the DELIVERY-LOSS guard — once
 *      the claim transaction commits, the run has permanently left the
 *      dispatch surface, so a dropped first response can never trigger a
 *      re-execution (at-most-once; the sweep reaps it later as an observable
 *      error, Day 8–10).
 *
 * Plus the batch semantics (A-05): one poll attempts every eligible pending
 * exec run (ts ASC, id ASC), per-run independent claim+lease transactions —
 * a lost race on one candidate never blocks the rest, and concurrent polls
 * may split the batch but never duplicate a delivery.
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { deliverySchema } from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines, runLeases, type NewRun } from "../db/schema.js";
import { buildExecTask } from "../gateway/delivery.js";
import {
  FakeClock,
  makeTestFactories,
  seedLoop,
  seedMachineForToken,
  seedRun,
  snapshotRuns,
  testDeps,
} from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "./index.js";

const TOKEN = "dk_test_machine_alpha";
const OTHER_TOKEN = "dk_test_machine_beta";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let machineId: string;
let mintCount: number;
let coordinator: RunCoordinator;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  machineId = await seedMachineForToken(db, TOKEN);
  await seedLoop(db, { id: "loop-1", name: "react-doctor", taskFile: "/home/dev/loops/react-doctor/README.md" });
  const base = makeTestFactories();
  mintCount = 0;
  coordinator = createRunCoordinator(
    testDeps(db, clock, {
      mintRunCredential: () => {
        mintCount += 1;
        return base.mintRunCredential();
      },
    }),
  );
}

/** Seed a pending exec run owned by THIS test's machine (the derived id, not
 *  the testkit's "m-test" default — poll candidates match on it). */
async function seedExec(id: string, overrides: Partial<NewRun> = {}): Promise<void> {
  await seedRun(db, { ...overrides, id, machineId });
}

async function leaseRows() {
  return db.select().from(runLeases).orderBy(asc(runLeases.runId));
}

describe("poll claim: T1 concurrent claim uniqueness", () => {
  it("two concurrent polls — exactly one delivery, one running run, one active lease, one mint", async () => {
    await fresh();
    await seedExec("run-1");

    const [a, b] = await Promise.all([coordinator.poll(TOKEN, {}), coordinator.poll(TOKEN, {})]);
    const deliveries = [...a.deliveries, ...b.deliveries];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.runId).toBe("run-1");

    const rows = await snapshotRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "run-1", phase: "running", ts: clock.iso() });

    const leases = await leaseRows();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ runId: "run-1", state: "active", expiresAt: null });
    expect(mintCount).toBe(1);
    // The delivery's credential is EXACTLY what the DB hashes (plaintext never stored).
    expect(leases[0]!.tokenHash).toBe(sha256(deliveries[0]!.runToken));
    expect(deliverySchema.parse(deliveries[0])).toBeTruthy();
  });
});

describe("poll claim: T2 at-most-once (repeat poll / dropped first response)", () => {
  it("a claimed run is never re-delivered: empty polls, original row/lease/credential untouched", async () => {
    await fresh();
    await seedExec("run-1");

    const first = await coordinator.poll(TOKEN, {});
    expect(first.deliveries).toHaveLength(1);
    const leaseAfterFirst = await leaseRows();
    const runAfterFirst = (await snapshotRuns(db))[0]!;

    // Repeat polls (incl. the delivery-loss case: the first response never
    // reached the daemon) must return EMPTY and change nothing.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(11_000); // past the heartbeat window — poll is fully processed
      const again = await coordinator.poll(TOKEN, {});
      expect(again.deliveries).toEqual([]);
    }
    expect(mintCount).toBe(1);
    expect(await snapshotRuns(db)).toEqual([runAfterFirst]);
    expect(await leaseRows()).toEqual(leaseAfterFirst);
  });
});

describe("poll claim: batch semantics (A-05)", () => {
  it("claims every eligible pending exec run in one poll, ordered ts ASC then id ASC", async () => {
    await fresh();
    await seedExec("run-c", { ts: "2026-07-01T00:00:03.000Z" });
    await seedExec("run-b", { ts: "2026-07-01T00:00:01.000Z" });
    await seedExec("run-a", { ts: "2026-07-01T00:00:01.000Z" }); // ts tie → id ASC first
    const { deliveries } = await coordinator.poll(TOKEN, {});
    expect(deliveries.map((d) => d.runId)).toEqual(["run-a", "run-b", "run-c"]);
    expect((await snapshotRuns(db)).every((r) => r.phase === "running")).toBe(true);
    expect(await leaseRows()).toHaveLength(3);
  });

  it("skips ineligible candidates without failing them: other machine, non-exec role, missing loop", async () => {
    await fresh();
    const otherMachineId = await seedMachineForToken(db, OTHER_TOKEN);
    await seedRun(db, { id: "run-other-machine", machineId: otherMachineId });
    await seedExec("run-evolve", { role: "evolve" });
    await seedExec("run-no-loop", { loopId: "loop-gone" });
    await seedExec("run-ok");

    const { deliveries } = await coordinator.poll(TOKEN, {});
    expect(deliveries.map((d) => d.runId)).toEqual(["run-ok"]);

    // Skipped candidates stay pending (Phase 1 does NOT fail them — they are
    // simply not deliverable); nothing extra was minted.
    const byId = new Map((await snapshotRuns(db)).map((r) => [r.id, r]));
    expect(byId.get("run-other-machine")).toMatchObject({ phase: "pending" });
    expect(byId.get("run-evolve")).toMatchObject({ phase: "pending" });
    expect(byId.get("run-no-loop")).toMatchObject({ phase: "pending" });
    expect(byId.get("run-ok")).toMatchObject({ phase: "running" });
    expect(mintCount).toBe(1);
  });

  it("concurrent polls split the batch without duplicating any delivery", async () => {
    await fresh();
    for (const id of ["run-1", "run-2", "run-3", "run-4"]) await seedExec(id);

    const [a, b] = await Promise.all([coordinator.poll(TOKEN, {}), coordinator.poll(TOKEN, {})]);
    const ids = [...a.deliveries.map((d) => d.runId), ...b.deliveries.map((d) => d.runId)];
    expect(ids.sort()).toEqual(["run-1", "run-2", "run-3", "run-4"]);
    expect(new Set(ids).size).toBe(4);
    expect(await leaseRows()).toHaveLength(4);
    expect(mintCount).toBe(4);
  });
});

describe("poll claim: lease mint policy (ADR-003, A-06)", () => {
  it("persists every capability explicitly FALSE regardless of loop config, while the Delivery carries real config", async () => {
    await fresh();
    await seedExec("run-1");
    // loop-1 has allowControl: true (seed default) — mint must NOT inherit it.
    const { deliveries } = await coordinator.poll(TOKEN, {});
    expect(deliveries[0]!.loop.allowControl).toBe(true); // real loop config on the wire

    const lease = (await leaseRows())[0]!;
    expect(lease).toMatchObject({
      runId: "run-1",
      loopId: "loop-1",
      machineId,
      role: "exec",
      allowControl: false,
      canSetUi: false,
      canSetSchema: false,
      canSetWorkflow: false,
      canFinish: false,
      state: "active",
      expiresAt: null,
      createdAt: clock.iso(),
    });
    expect(lease.tokenHash).toBe(sha256(deliveries[0]!.runToken));
  });

  it("mints identical all-false caps for an allowControl=false loop too", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-2", allowControl: false });
    await seedExec("run-2", { loopId: "loop-2" });
    const { deliveries } = await coordinator.poll(TOKEN, {});
    expect(deliveries[0]!.loop.allowControl).toBe(false);
    expect((await leaseRows())[0]).toMatchObject({ allowControl: false, canFinish: false });
  });
});

describe("poll claim: delivery content", () => {
  it("delivers the full loop snapshot, prevState, roots, empty systemPrompt and the exec task", async () => {
    await fresh();
    await db.update(machines).set({ roots: ["/home/dev"] }).where(eq(machines.id, machineId));
    await seedLoop(db, { id: "loop-2", name: null, workdir: null, taskFile: null, state: { cursor: 7 } });
    await seedExec("run-2", { loopId: "loop-2" });

    const { deliveries } = await coordinator.poll(TOKEN, {});
    expect(deliveries).toHaveLength(1);
    const d = deliveries[0]!;
    expect(d).toMatchObject({
      runId: "run-2",
      role: "exec",
      systemPrompt: "",
      roots: ["/home/dev"],
      prevState: { cursor: 7 },
      loop: {
        id: "loop-2",
        name: "loop-2", // friendly name null → DTO falls back to the id
        workdir: null,
        taskFile: null,
        allowControl: true,
        agent: "claude-code",
      },
    });
    expect(d.task).toBe(buildExecTask({ id: "loop-2", name: null, taskFile: null }));
    expect(d.task).toContain("No task file is configured");
    expect(deliverySchema.parse(d)).toBeTruthy();
  });

  it("delivers unrestricted roots as [] when the machine has no allowlist", async () => {
    await fresh();
    await seedExec("run-1");
    const { deliveries } = await coordinator.poll(TOKEN, {});
    expect(deliveries[0]!.roots).toEqual([]);
  });
});
