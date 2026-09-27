/**
 * Q5/Q6 (Batch 3 切片三): the Dashboard's no-supersede policy against the
 * OTHER writers that race it — a poll claim, a Finish report, a second
 * Dashboard, and cron in both commit orders.
 *
 * The policy itself lives in `store/runs.ts` and is unit-tested in
 * `coordinator/enqueue.test.ts`; THIS file is about the cross-module races the
 * batch plan §4 Q-group demands: "两个 Coordinator 的 resolve/write 交错；
 * claim/finish/cron 竞争；既有 API supersede 和调度水位回归".
 *
 * Interleaving honesty (ADR-001's PGlite note): pglite is single-connection,
 * so every race here is orchestrated at the APP level through the existing
 * TEST-ONLY `afterEnqueueLoopResolve` gate — a hook parks after the
 * authoritative Loop resolve and BEFORE the write transaction opens, and
 * COMMITS a real competitor there (the connection is free at that point),
 * never a mock. Real multi-connection lock contention stays with Phase 6.
 *
 * Evidence standard (review P2, 2026-09-11): each competitor is the REAL
 * production path — `poll` (run flip + Loop revision bump + lease mint),
 * `report` (finalize + lease delete) and `scheduler.start()` (the whole
 * restart recovery pass). For a Dashboard skip, the gate records the full
 * Run/Loop/Lease snapshot the moment that competitor commits, so the closing
 * assertion proves the call under test wrote NOTHING on top of it. For the
 * scheduled-success direction, the same snapshot is transformed into the
 * exact permitted T7 diff (cancel old pending, insert one pending, advance
 * revision/watermark) and compared wholesale. A raw
 * `UPDATE runs SET phase='running'` misses the revision bump and the lease
 * entirely, and a competitor started after the call returned never enters the
 * window at all.
 *
 * The invariant under test is asymmetric on purpose: the Dashboard must never
 * replace a queued run, while cron/catch-up keep T7 (ADR-007 批次三 §4) — the
 * later scheduled writer still supersedes an earlier manual pending, INCLUDING
 * one the Dashboard created inside its window.
 */
import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { sha256 } from "@loopzhb/protocol/node";

import { createRunCoordinator, type RunCoordinator } from "./coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "./db/index.js";
import { loops } from "./db/schema.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";
import { SUPERSEDED_MESSAGE } from "./store/runs.js";
import {
  FakeClock,
  FakeCronFactory,
  seedLease,
  seedLoop,
  seedMachineForToken,
  seedRun,
  snapshotLeases,
  snapshotLoops,
  snapshotRuns,
  testDeps,
} from "./testkit/index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/** Exactly what `start.ts` wires for the Dashboard. */
const DASHBOARD = { kind: "manual", pendingPolicy: "skip" } as const;

/** A poll-capable daemon — claims are gated on terminal-journal-v1 (ADR-009
 *  决策 7), so the competing claim must declare it or it claims nothing. */
const MACHINE_TOKEN = "dk_test_nosupersede_alpha";
function capable(): { capabilities: string[] } {
  return { capabilities: ["terminal-journal-v1"] };
}

/** Activation strictly before every occurrence used below. */
const ACTIVATION_9AM = "2026-08-27T09:00:00.000Z";

type ThreeTables = {
  runs: Awaited<ReturnType<typeof snapshotRuns>>;
  loops: Awaited<ReturnType<typeof snapshotLoops>>;
  leases: Awaited<ReturnType<typeof snapshotLeases>>;
};

describe("Q5/Q6: Dashboard no-supersede vs claim, finish, dashboard and cron", () => {
  let db: Db;
  let clock: FakeClock;
  let machineId: string;
  let runSeq: number;

  async function fresh(): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T12:30:00.000Z"));
    runSeq = 0;
    machineId = await seedMachineForToken(db, MACHINE_TOKEN);
  }

  async function watermarkOf(loopId: string): Promise<string | null> {
    const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
    return loop?.lastScheduledAt ?? null;
  }

  async function snapshotAll(): Promise<ThreeTables> {
    return { runs: await snapshotRuns(db), loops: await snapshotLoops(db), leases: await snapshotLeases(db) };
  }

  /**
   * The competitor's committed state, captured BY the interleaving gate:
   * `capture()` runs immediately after the competitor's own transaction
   * settles and BEFORE the write transaction under test opens, so
   * `expectUntouched()` at the end proves that call wrote nothing at all — not
   * a Run row, not the Loop revision or watermark, not a Lease.
   */
  function competitorWindow() {
    let after: ThreeTables | undefined;
    return {
      /** True once a competitor has committed and been captured. */
      get recorded(): boolean {
        return after !== undefined;
      },
      async capture(): Promise<void> {
        after = await snapshotAll();
      },
      async expectUntouched(): Promise<void> {
        expect(after, "the interleaving gate never ran — no competitor committed").toBeDefined();
        expect(await snapshotAll()).toEqual(after);
      },
    };
  }

  /** One independent actor ("boot") over the CURRENT handle: its own
   *  coordinator — and therefore its own per-loop mutex — plus a scheduler with
   *  a fake cron factory, sharing the test's run-id sequence. Hooks are passed
   *  as `testDeps` overrides, exactly like the coordinator-level tests. */
  function actor(overrides: Parameters<typeof testDeps>[2] = {}): {
    coordinator: RunCoordinator;
    cronFactory: FakeCronFactory;
    scheduler: Scheduler;
  } {
    const coordinator = createRunCoordinator(
      testDeps(db, clock, { newRunId: () => `run-${++runSeq}`, ...overrides }),
    );
    const cronFactory = new FakeCronFactory();
    const scheduler = createScheduler({ db, coordinator, clock, cronFactory });
    return { coordinator, cronFactory, scheduler };
  }

  test("Q5: a real poll claim committed in the resolve/write window is not replaced", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    await seedRun(db, { id: "run-p", machineId, phase: "pending" });

    const poller = actor();
    const committed = competitorWindow();
    const dashboard = actor({
      hooks: {
        // The gate sits after the authoritative Loop resolve and before the
        // write transaction — the single pglite connection is free here, so
        // the claim that commits is the REAL one: the run flips to running,
        // the Loop revision is bumped and the lease is minted
        // (store/runs.ts claimRunWithLeaseTx). A raw phase UPDATE would have
        // missed all three, which is precisely what this test now pins.
        afterEnqueueLoopResolve: async () => {
          if (committed.recorded) return;
          const { deliveries } = await poller.coordinator.poll(MACHINE_TOKEN, capable());
          expect(deliveries).toHaveLength(1);
          await committed.capture();
        },
      },
    });

    expect(await dashboard.coordinator.enqueueExecRun("loop-1", DASHBOARD)).toEqual({
      enqueued: false,
      reason: "running_exists",
    });

    // The claim is the ONLY writer: one running run with a live lease, and the
    // Loop revision the claim's OCC bump produced. The Dashboard added nothing
    // on top of any of the three tables.
    await committed.expectUntouched();
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-p", phase: "running", outcome: null, ts: clock.iso() }),
    ]);
    expect(await snapshotLeases(db)).toEqual([
      expect.objectContaining({ runId: "run-p", loopId: "loop-1", machineId, state: "active", expiresAt: null }),
    ]);
    expect((await snapshotLoops(db))[0]).toMatchObject({ id: "loop-1", revision: 1 });
  });

  test("Q5: a real Finish committed in the resolve/write window wins as loop_completed", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "finish-me", goalRevision: 0 });
    await seedRun(db, { id: "run-finisher", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_finisher"),
      runId: "run-finisher",
      machineId,
      canFinish: true,
      terminalProtocolVersion: 1,
      goalRevision: 0,
    });

    const reporter = actor();
    const committed = competitorWindow();
    let hookCalls = 0;
    const dashboard = actor({
      hooks: {
        afterEnqueueLoopResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return;
          await reporter.coordinator.report("rk_finisher", {
            ok: true,
            outcome: "exec",
            durationMs: 1,
            terminal: { kind: "finish", reason: "done during Run Now" },
            taskFileSyncError: "missing",
          });
          await committed.capture();
        },
      },
    });

    const result = await dashboard.coordinator.enqueueExecRun("loop-1", DASHBOARD);

    // The bounded retry re-resolved the loop and found it Completed — it did
    // NOT reuse the idle snapshot it started from, and it never inserted a
    // pending run behind the completion.
    expect(result).toEqual({ enqueued: false, reason: "loop_completed" });
    expect(hookCalls).toBe(2);
    await committed.expectUntouched();

    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-finisher", phase: "done", outcome: "exec" }),
    ]);
    // The report transaction deleted the lease (finalize = run UPDATE + lease
    // DELETE, one transaction); the refused trigger re-minted none.
    expect(await snapshotLeases(db)).toEqual([]);
  });

  test("Q5: two Dashboards interleaved — the loser skips and supersedes nothing", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId });

    const second = actor();
    const committed = competitorWindow();
    const first = actor({
      hooks: {
        afterEnqueueLoopResolve: async () => {
          if (committed.recorded) return;
          // A second, INDEPENDENT Dashboard — its own coordinator, so its own
          // per-loop mutex — queues its run inside this one's window.
          expect((await second.coordinator.enqueueExecRun("loop-1", DASHBOARD)).enqueued).toBe(true);
          await committed.capture();
        },
      },
    });

    expect(await first.coordinator.enqueueExecRun("loop-1", DASHBOARD)).toEqual({
      enqueued: false,
      reason: "pending_exists",
    });
    await committed.expectUntouched();

    // Exactly one pending and NO canceled row: had the loser superseded, the
    // winner's run would be canceled/skipped and a second run inserted.
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-1", phase: "pending", outcome: null }),
    ]);
    expect(await snapshotLeases(db)).toEqual([]);
  });

  test("Q6: a restart catch-up committing in the resolve/write window is left alone", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    const catchup = actor();
    const committed = competitorWindow();
    const dashboard = actor({
      hooks: {
        afterEnqueueLoopResolve: async () => {
          if (committed.recorded) return;
          // The FULL production recovery pass — scan, job registration, then
          // the serial catch-up enqueue — runs to completion inside this
          // window and queues the missed 10:00 occurrence.
          await catchup.scheduler.start();
          await committed.capture();
        },
      },
    });

    expect(await dashboard.coordinator.enqueueExecRun("loop-1", DASHBOARD)).toEqual({
      enqueued: false,
      reason: "pending_exists",
    });
    await committed.expectUntouched();

    // The queued run survives untouched and the watermark is exactly the
    // catch-up's occurrence — a manual trigger never moves it.
    expect(await watermarkOf("loop-1")).toBe("2026-08-27T10:00:00.000Z");
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-1", phase: "pending", role: "exec", outcome: null }),
    ]);
  });

  test("Q6: cron still supersedes a Dashboard pending created inside its own window", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    const button = actor();
    let afterButton: ThreeTables | undefined;
    let hookCalls = 0;
    const scheduled = actor({
      hooks: {
        afterEnqueueLoopResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return;
          // The operator clicks Run Now inside the scheduled writer's window:
          // a REAL Dashboard enqueue commits (pending run + Loop revision
          // bump), so the watermark CAS below must lose.
          expect((await button.coordinator.enqueueExecRun("loop-1", DASHBOARD)).enqueued).toBe(true);
          afterButton = await snapshotAll();
        },
      },
    });

    // The catch-up is the LATER writer, and ADR-007 批次三 §4 keeps T7 for it:
    // the manual pending — including one the Dashboard created mid-window — is
    // superseded. The lost CAS costs exactly one bounded retry, which
    // re-resolves and re-supersedes on fresh state.
    await scheduled.scheduler.start();

    expect(hookCalls).toBe(2);
    expect(afterButton, "the Dashboard competitor never committed").toBeDefined();
    const beforeScheduled = afterButton!;
    const [manualRun] = beforeScheduled.runs;
    expect(manualRun).toBeDefined();

    // A successful scheduled writer is the ONE non-zero-write direction in
    // this file. Compare every table to the precise permitted T7 diff rather
    // than merely counting pending rows: no Lease is minted, only the manual
    // run is canceled, exactly one scheduled pending is inserted, and only
    // revision/watermark change on the Loop.
    const occurrence = "2026-08-27T10:00:00.000Z";
    const expected: ThreeTables = {
      runs: [
        { ...manualRun!, phase: "canceled", outcome: "skipped", message: SUPERSEDED_MESSAGE, ts: clock.iso() },
        {
          ...manualRun!,
          id: "run-2",
          phase: "pending",
          outcome: null,
          message: null,
          error: null,
          ts: clock.iso(),
        },
      ],
      loops: beforeScheduled.loops.map((loop) =>
        loop.id === "loop-1" ? { ...loop, lastScheduledAt: occurrence, revision: loop.revision + 1 } : loop,
      ),
      leases: beforeScheduled.leases,
    };
    expect(await snapshotAll()).toEqual(expected);
  });
});
