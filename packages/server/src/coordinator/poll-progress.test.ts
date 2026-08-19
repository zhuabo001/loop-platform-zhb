/**
 * Poll-carried progress heartbeats (Phase 2 batch 1) — `progress` graduates
 * from parse-only to the sweep's liveness evidence (ADR-001 T5).
 *
 * Every test here drives the REAL poll path (never the store primitive
 * directly): the coordinator applies `body.progress` AFTER credential
 * verification and BEFORE the claim gate, stamps `at` from the injected clock,
 * and never touches `ts` (the transition-time column the claim and
 * report/reclaim CAS guards depend on).
 *
 * The zero-write matrix is vacuously green against a server that never writes
 * progress — the FIRST test (the write lands) is what gives the matrix teeth.
 */
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { createInactivitySweep, DEFAULT_RUN_INACTIVITY_MS } from "../sweep/index.js";
import {
  FakeClock,
  seedLease,
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
let coordinator: RunCoordinator;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  machineId = await seedMachineForToken(db, TOKEN);
  await seedLoop(db, { id: "loop-1" });
  coordinator = createRunCoordinator(testDeps(db, clock));
}

describe("poll progress: write path", () => {
  it("lands on a running run with the server-stamped at — ts and every other column untouched; a later poll overwrites (last-wins)", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    const before = await snapshotRuns(db);

    await coordinator.poll(TOKEN, { progress: [{ runId: "run-1", step: 1, label: "editing src/app.ts" }] });
    const after = await snapshotRuns(db);
    expect(after).toEqual([
      { ...before[0]!, progress: { step: 1, label: "editing src/app.ts", at: clock.iso() } },
    ]);

    clock.advance(3_000);
    await coordinator.poll(TOKEN, { progress: [{ runId: "run-1", step: 2, label: "running tests" }] });
    const rows = await snapshotRuns(db);
    expect(rows[0]!.progress).toEqual({ step: 2, label: "running tests", at: clock.iso() });
    expect(rows[0]!.ts).toBe(before[0]!.ts); // transition timestamp NEVER moves
  });

  it("writes ZERO rows for ineligible targets: pending / done / canceled / reclaimed runs, another machine's run, an unknown runId", async () => {
    await fresh();
    const otherMachineId = await seedMachineForToken(db, OTHER_TOKEN);
    await seedRun(db, { id: "run-pending", machineId });
    await seedRun(db, { id: "run-done", machineId, phase: "done" });
    await seedRun(db, { id: "run-canceled", machineId, phase: "canceled" });
    // What a sweep reclaim leaves behind (ADR-001 T5): a late heartbeat for it
    // must stay a benign zero-write.
    await seedRun(db, {
      id: "run-reclaimed",
      machineId,
      phase: "error",
      outcome: "error",
      error: "machine timed out / disconnected",
    });
    await seedRun(db, { id: "run-other", machineId: otherMachineId, phase: "running" });
    const before = await snapshotRuns(db);

    // availableSlots:0 keeps the poll's OWN claim scan out of the way — the
    // matrix isolates the progress write (an idle poll would legitimately
    // claim run-pending, and that ts bump is the claim's write, not ours).
    await coordinator.poll(TOKEN, {
      availableSlots: 0,
      progress: [
        { runId: "run-pending", step: 1, label: "x" },
        { runId: "run-done", step: 1, label: "x" },
        { runId: "run-canceled", step: 1, label: "x" },
        { runId: "run-reclaimed", step: 1, label: "x" },
        { runId: "run-other", step: 1, label: "x" },
        { runId: "run-unknown", step: 1, label: "x" },
      ],
    });
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it('cleans labels server-side: NUL-strip, trim, 200-char cap, blank falls back to "working" — at still lands', async () => {
    await fresh();
    for (const id of ["run-nul", "run-trim", "run-long", "run-blank"]) {
      await seedRun(db, { id, machineId, phase: "running" });
    }
    await coordinator.poll(TOKEN, {
      progress: [
        { runId: "run-nul", step: 1, label: "edit\0ing \0app.ts" },
        { runId: "run-trim", step: 1, label: "   spaced   " },
        { runId: "run-long", step: 1, label: "y".repeat(250) },
        { runId: "run-blank", step: 1, label: " \0 \0 " },
      ],
    });
    const byId = new Map((await snapshotRuns(db)).map((r) => [r.id, r]));
    expect(byId.get("run-nul")!.progress).toEqual({ step: 1, label: "editing app.ts", at: clock.iso() });
    expect(byId.get("run-trim")!.progress).toEqual({ step: 1, label: "spaced", at: clock.iso() });
    expect(byId.get("run-long")!.progress).toEqual({ step: 1, label: "y".repeat(200), at: clock.iso() });
    expect(byId.get("run-blank")!.progress).toEqual({ step: 1, label: "working", at: clock.iso() });
  });

  it("caps a batch at 20 entries and dedups by runId last-wins (defense-only — fairness is the daemon's round-robin)", async () => {
    await fresh();
    for (let i = 1; i <= 25; i += 1) {
      await seedRun(db, { id: `run-${String(i).padStart(2, "0")}`, machineId, phase: "running" });
    }
    const entries = Array.from({ length: 25 }, (_, i) => ({
      runId: `run-${String(i + 1).padStart(2, "0")}`,
      step: 1,
      label: `label-${i + 1}`,
    }));
    entries.push({ runId: "run-01", step: 9, label: "late-duplicate" }); // LAST occurrence wins
    await coordinator.poll(TOKEN, { progress: entries });

    const rows = await snapshotRuns(db);
    expect(rows.filter((r) => r.progress !== null)).toHaveLength(20); // PROGRESS_ENTRIES_CAP
    expect(rows.find((r) => r.id === "run-01")!.progress).toMatchObject({ step: 9, label: "late-duplicate" });
    expect(rows.find((r) => r.id === "run-21")!.progress).toBeNull(); // first-20 slice drops the tail
  });
});

describe("poll progress: sweep interleaving (ADR-001 T5)", () => {
  it("a fresh heartbeat vetoes the reclaim of a stale-ts run; once the heartbeat itself goes stale the sweep reclaims; a post-reclaim heartbeat is a zero-write", async () => {
    await fresh();
    const staleTs = new Date(clock.now().getTime() - 25 * 60 * 1000).toISOString(); // 25min ≫ 20min window
    await seedRun(db, { id: "run-1", machineId, phase: "running", ts: staleTs });
    await seedLease(db, { tokenHash: sha256("rk_testcred_sweep"), runId: "run-1" });
    const sweep = createInactivitySweep({ db, clock, log: () => {} });

    // Without the heartbeat this run is stale; the poll-carried heartbeat
    // (server-stamped at = now) must veto the reclaim.
    await coordinator.poll(TOKEN, { progress: [{ runId: "run-1", step: 3, label: "still working" }] });
    const first = await sweep.runOnce();
    expect(first).toMatchObject({ scanned: 1, reclaimed: 0, failed: 0 });
    let row = (await snapshotRuns(db))[0]!;
    expect(row.phase).toBe("running");
    expect(row.progress).toEqual({ step: 3, label: "still working", at: clock.iso() });

    // The heartbeat itself goes stale → the reclaim proceeds.
    clock.advance(DEFAULT_RUN_INACTIVITY_MS + 60_000);
    const second = await sweep.runOnce();
    expect(second).toMatchObject({ scanned: 1, reclaimed: 1, failed: 0 });
    row = (await snapshotRuns(db))[0]!;
    expect(row.phase).toBe("error");

    // A late heartbeat for the reclaimed run writes nothing (phase guard).
    const afterReclaim = await snapshotRuns(db);
    await coordinator.poll(TOKEN, { progress: [{ runId: "run-1", step: 4, label: "late" }] });
    expect(await snapshotRuns(db)).toEqual(afterReclaim);
  });
});
