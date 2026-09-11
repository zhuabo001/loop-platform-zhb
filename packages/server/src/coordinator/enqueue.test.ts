/**
 * T7 — atomic supersede at the coordinator level (ADR-001).
 *
 * `enqueueExecRun` is the ONE writer that creates pending exec runs: with a
 * running run on the loop it is a zero-write skip; otherwise ONE transaction
 * supersedes every older pending exec run (`canceled/skipped`) and inserts
 * exactly one new pending. Any failure inside the transaction rolls the whole
 * thing back — no "old runs skipped but replacement never enqueued" middle
 * state, ever.
 *
 * Interleaving honesty (ADR-001's PGlite note): pglite is single-connection,
 * so the "a poll claim commits mid-enqueue" race is orchestrated at the APP
 * level — the test-only `hooks.beforeEnqueueTx` gate commits a real competing
 * write BEFORE the enqueue transaction opens, and the enqueue's in-transaction
 * re-check must then skip with zero writes. Real multi-connection lock
 * contention stays with Phase 6.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { runs } from "../db/schema.js";
import { SUPERSEDED_MESSAGE } from "../store/runs.js";
import { updateSchedule } from "../schedule/state-machine.js";
import { FakeClock, seedLoop, seedMachine, seedRun, snapshotLoops, snapshotRuns, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let coordinator: RunCoordinator;

async function seeded(depsOverrides: Parameters<typeof testDeps>[2] = {}): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  await seedMachine(db, "m-test");
  await seedLoop(db, { id: "loop-1" });
  coordinator = createRunCoordinator(testDeps(db, clock, depsOverrides));
}

describe("enqueueExecRun (T7)", () => {
  it("creates exactly one pending exec run for an idle loop, stamped by the injected clock", async () => {
    await seeded();
    const result = await coordinator.enqueueExecRun("loop-1");
    expect(result).toEqual({ enqueued: true, runId: "run-1", supersededRunIds: [] });

    const rows = await snapshotRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "run-1",
      loopId: "loop-1",
      machineId: "m-test",
      phase: "pending",
      role: "exec",
      ts: clock.iso(),
    });
  });

  it("returns loop_not_found with zero writes for an unknown loop", async () => {
    await seeded();
    const result = await coordinator.enqueueExecRun("loop-nope");
    expect(result).toEqual({ enqueued: false, reason: "loop_not_found" });
    expect(await snapshotRuns(db)).toEqual([]);
  });

  it("supersedes every older pending exec run in one transaction, keeping exactly one pending", async () => {
    await seeded();
    await seedRun(db, { id: "old-1", ts: "2026-07-01T00:00:01.000Z" });
    await seedRun(db, { id: "old-2", ts: "2026-07-01T00:00:02.000Z" });
    // A pending NON-exec run is out of the supersede scope (Phase 3 roles).
    await seedRun(db, { id: "old-evolve", role: "evolve", ts: "2026-07-01T00:00:03.000Z" });

    const result = await coordinator.enqueueExecRun("loop-1");
    expect(result).toEqual({ enqueued: true, runId: "run-1", supersededRunIds: ["old-1", "old-2"] });

    const byId = new Map((await snapshotRuns(db)).map((r) => [r.id, r]));
    for (const id of ["old-1", "old-2"]) {
      expect(byId.get(id)).toMatchObject({
        phase: "canceled",
        outcome: "skipped",
        message: SUPERSEDED_MESSAGE,
        ts: clock.iso(),
      });
    }
    expect(byId.get("old-evolve")).toMatchObject({ phase: "pending", outcome: null });
    expect(byId.get("run-1")).toMatchObject({ phase: "pending", role: "exec" });

    // Repeated enqueues always converge to exactly one pending exec run.
    const again = await coordinator.enqueueExecRun("loop-1");
    expect(again).toEqual({ enqueued: true, runId: "run-2", supersededRunIds: ["run-1"] });
    const pendings = (await snapshotRuns(db)).filter((r) => r.phase === "pending" && r.role === "exec");
    expect(pendings.map((r) => r.id)).toEqual(["run-2"]);
  });

  it("is a zero-write skip while any run is running (never queue behind a running run)", async () => {
    await seeded();
    await seedRun(db, { id: "run-live", phase: "running", ts: "2026-07-01T00:00:01.000Z" });
    await seedRun(db, { id: "run-leftover", phase: "pending", ts: "2026-07-01T00:00:02.000Z" });
    const before = await snapshotRuns(db);

    const result = await coordinator.enqueueExecRun("loop-1");
    expect(result).toEqual({ enqueued: false, reason: "running_exists" });
    // Zero writes: even the leftover pending row is untouched.
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it("rolls the supersede back when the insert fails (injected PK collision)", async () => {
    await seeded();
    // The deterministic factory's first id collides with an existing row.
    await seedRun(db, { id: "run-1", ts: "2026-07-01T00:00:01.000Z" });

    await expect(coordinator.enqueueExecRun("loop-1")).rejects.toThrow();
    // Whole transaction rolled back: the old pending run is NOT superseded.
    const rows = await snapshotRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "run-1", phase: "pending", outcome: null });
  });

  it("rolls back when the id factory throws", async () => {
    await seeded({
      newRunId: () => {
        throw new Error("injected id-factory failure");
      },
    });
    await seedRun(db, { id: "old-1" });

    await expect(coordinator.enqueueExecRun("loop-1")).rejects.toThrow("injected id-factory failure");
    expect((await snapshotRuns(db))[0]).toMatchObject({ id: "old-1", phase: "pending", outcome: null });
  });

  it("loses cleanly to a claim that commits before the write transaction (app-level gate)", async () => {
    // The hook commits a REAL competing claim (pending → running) after the
    // loop lookup but before the enqueue transaction opens — the single pglite
    // connection is free at that point, so this is a genuine committed write,
    // not a mocked one.
    await seeded({
      hooks: {
        beforeEnqueueTx: async () => {
          const claimed = await db
            .update(runs)
            .set({ phase: "running", ts: "2026-07-01T00:00:09.000Z" })
            .where(eq(runs.id, "run-p"))
            .returning({ id: runs.id });
          expect(claimed).toHaveLength(1);
        },
      },
    });
    await seedRun(db, { id: "run-p", phase: "pending" });

    const result = await coordinator.enqueueExecRun("loop-1");
    // The in-transaction re-check sees the claimed run and skips: no new
    // pending is ever queued behind a running run.
    expect(result).toEqual({ enqueued: false, reason: "running_exists" });
    const rows = await snapshotRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "run-p", phase: "running" });
  });

  it("serializes concurrent enqueues per loop — exactly one pending at the end", async () => {
    await seeded();
    const [a, b] = await Promise.all([
      coordinator.enqueueExecRun("loop-1"),
      coordinator.enqueueExecRun("loop-1"),
    ]);
    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(true);

    const rows = await snapshotRuns(db);
    const pendings = rows.filter((r) => r.phase === "pending");
    expect(pendings).toHaveLength(1);
    // The loser's run was superseded by the winner's.
    const superseded = rows.filter((r) => r.phase === "canceled");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({ outcome: "skipped", message: SUPERSEDED_MESSAGE });
  });
});

/**
 * Q-group (Batch 3 切片三): the Dashboard's `pendingPolicy: "skip"`.
 *
 * The Dashboard must never replace a run the operator already queued, so an
 * existing pending run — of ANY role — turns the trigger into a zero-write
 * `pending_exists`, and the supersede block is bypassed entirely. Every
 * negative case compares BOTH tables byte-for-byte: "no Run changed" is not
 * enough when the plan also forbids touching `loops.revision`.
 */
describe("enqueueExecRun pendingPolicy (Q-group)", () => {
  const SKIP = { kind: "manual", pendingPolicy: "skip" } as const;

  it("Q1: creates exactly one pending on an idle or paused loop, superseding nothing", async () => {
    await seeded();
    const idle = await coordinator.enqueueExecRun("loop-1", SKIP);
    expect(idle).toEqual({ enqueued: true, runId: "run-1", supersededRunIds: [] });

    // Paused (enabled=false, manual-only) is NOT a reason to refuse: a manual
    // trigger deliberately bypasses the enablement check (ADR-008), and the
    // page keeps that button available too.
    await seedLoop(db, { id: "loop-paused", enabled: false });
    const paused = await coordinator.enqueueExecRun("loop-paused", SKIP);
    expect(paused).toEqual({ enqueued: true, runId: "run-2", supersededRunIds: [] });

    const pendings = (await snapshotRuns(db)).filter((r) => r.phase === "pending");
    expect(pendings.map((r) => r.id).sort()).toEqual(["run-1", "run-2"]);
  });

  it("Q2: skips with zero writes on pending(exec), pending(non-exec), running and completed", async () => {
    await seeded();
    await seedLoop(db, {
      id: "loop-done",
      goal: "g",
      completedAt: "2026-07-01T00:00:01.000Z",
      completionReason: "done",
      enabled: false,
    });
    await seedLoop(db, { id: "loop-queued" });
    await seedRun(db, { id: "run-queued", loopId: "loop-queued", phase: "pending" });
    await seedLoop(db, { id: "loop-evolving" });
    // A pending NON-exec run: out of the supersede scan's scope, but the skip
    // probe is deliberately role-agnostic (batch plan §3 「任意 role」).
    await seedRun(db, { id: "run-evolving", loopId: "loop-evolving", phase: "pending", role: "evolve" });
    await seedLoop(db, { id: "loop-busy" });
    await seedRun(db, { id: "run-busy", loopId: "loop-busy", phase: "running", role: "edit" });

    const cases = [
      ["loop-queued", "pending_exists"],
      ["loop-evolving", "pending_exists"],
      ["loop-busy", "running_exists"],
      ["loop-done", "loop_completed"],
    ] as const;

    for (const [loopId, reason] of cases) {
      const runsBefore = await snapshotRuns(db);
      const loopsBefore = await snapshotLoops(db);
      expect([loopId, await coordinator.enqueueExecRun(loopId, SKIP)]).toEqual([
        loopId,
        { enqueued: false, reason },
      ]);
      // Zero writes means BOTH tables — a revision bump would be a write even
      // though no Run row changed (batch plan §3: 不修改 Loop revision).
      expect(await snapshotRuns(db)).toEqual(runsBefore);
      expect(await snapshotLoops(db)).toEqual(loopsBefore);
    }
  });

  it("Q3: a repeated skip trigger stays a zero-write no-op", async () => {
    await seeded();
    expect((await coordinator.enqueueExecRun("loop-1", SKIP)).enqueued).toBe(true);
    const after = { runs: await snapshotRuns(db), loops: await snapshotLoops(db) };

    for (let i = 0; i < 2; i += 1) {
      expect(await coordinator.enqueueExecRun("loop-1", SKIP)).toEqual({ enqueued: false, reason: "pending_exists" });
    }
    expect(await snapshotRuns(db)).toEqual(after.runs);
    expect(await snapshotLoops(db)).toEqual(after.loops);
    // …and the loop never accumulated a second pending.
    expect((await snapshotRuns(db)).filter((r) => r.phase === "pending")).toHaveLength(1);
  });

  it("Q4: a competing enqueue that commits before the write transaction is never superseded", async () => {
    // The hook commits a REAL competing enqueue — a second coordinator over the
    // same handle, so there is no shared per-loop mutex — after this one's loop
    // lookup but before its write transaction. It lands in the FIRST pass: the
    // in-transaction pending probe is authoritative, so the race costs one pass
    // and writes nothing.
    let hookCalls = 0;
    let competitor: RunCoordinator | undefined;
    await seeded({
      hooks: {
        afterEnqueueLoopResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return;
          expect((await competitor!.enqueueExecRun("loop-1")).enqueued).toBe(true);
        },
      },
    });
    competitor = createRunCoordinator(testDeps(db, clock));

    const result = await coordinator.enqueueExecRun("loop-1", SKIP);
    expect(result).toEqual({ enqueued: false, reason: "pending_exists" });
    expect(hookCalls).toBe(1);

    // Exactly one pending survives — the COMPETITOR's — and nothing was
    // canceled: `supersededRunIds` would have named it under T7.
    const rows = await snapshotRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "run-1", phase: "pending", outcome: null });
  });

  it("Q4: a lost CAS re-resolves the loop instead of reusing the stale read", async () => {
    // Here the competitor changes only the LOOP (a schedule PATCH bumps
    // `revision` and leaves no run), so the probes still say "idle" and the
    // revision CAS is what loses — then the bounded retry must re-resolve and
    // re-probe on fresh state rather than trust the snapshot it started with.
    let hookCalls = 0;
    await seeded({
      hooks: {
        afterEnqueueLoopResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return;
          const updated = await updateSchedule({ db, clock }, "loop-1", { cron: "0 12 * * *" });
          expect(updated).toMatchObject({ found: true, changed: true });
        },
      },
    });

    const result = await coordinator.enqueueExecRun("loop-1", SKIP);
    expect(result).toEqual({ enqueued: true, runId: "run-1", supersededRunIds: [] });
    expect(hookCalls).toBe(2);
    expect((await snapshotRuns(db))[0]).toMatchObject({ id: "run-1", phase: "pending" });
  });
});
