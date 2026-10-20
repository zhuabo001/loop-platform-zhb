/**
 * S-group tests: Scheduler registration, reconcile, and lifecycle.
 *
 * Tests cover:
 *  - S1–S4: Active loop scanning, job registration, Croner parameters
 *  - S5–S8: Dynamic reconcile, revision replacement, job removal
 *  - S9–S12: Callback isolation, exception handling, shutdown drain
 *  - S13–S19: Fixed Croner options, stale callback, occurrence reconstruction,
 *    beyond-lookback skip, overrun (callback pending until enqueue settles),
 *    startup failure propagation, stopped guard
 *
 * All loops that will FIRE a callback seed scheduleActivatedAt strictly BEFORE
 * the reconstructed occurrence (10:00 tick vs 09:00 activation) — an
 * occurrence equal to activation is correctly rejected as before_activation.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, machines, runs } from "../db/schema.js";
import { updateSchedule } from "../schedule/index.js";
import {
  FakeClock,
  FakeCronFactory,
  seedClaimedMachineById,
  seedLoop,
  seedMachine,
  snapshotRuns,
  testDeps,
  TEST_TEAM_ID,
} from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createScheduler, type Scheduler } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/** Occurrence of the seeded "0 10 * * *" UTC cron on the test day. */
const OCCURRENCE_10AM = "2026-08-27T10:00:00.000Z";
/** Activation strictly before the 10:00 occurrence (activation boundary). */
const ACTIVATION_9AM = "2026-08-27T09:00:00.000Z";

/** Drain the microtask AND 0ms-timer queues — the "a promise that COULD have
 *  settled by now has settled" boundary for the interleaving assertions. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("S-group: Scheduler registration and lifecycle", () => {
  let db: Db;
  let clock: FakeClock;
  let scheduler: Scheduler;
  let cronFactory: FakeCronFactory;
  let coordinator: RunCoordinator;
  let machineId: string;
  let logs: string[];

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T10:00:00Z"));
    machineId = "m-test123456789a";
    logs = [];

    await seedClaimedMachineById(db, machineId);

    coordinator = createRunCoordinator(testDeps(db, clock));
    cronFactory = new FakeCronFactory();

    scheduler = createScheduler({
      db,
      coordinator,
      clock,
      cronFactory,
      log: (line) => logs.push(line),
    });
  });

  describe("Start and active loop scanning", () => {
    test("S1: scans and registers active scheduled loops", async () => {
      // Create 3 loops: 2 active scheduled, 1 manual-only
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });
      await seedLoop(db, {
        id: "loop-2",
        machineId,
        cron: "0 14 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });
      await seedLoop(db, {
        id: "loop-3",
        machineId,
        cron: null, // manual-only
        enabled: true,
      });

      await scheduler.start();

      expect(cronFactory.activeCount()).toBe(2);
    });

    test("S2: filters out paused loops", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: false, // paused
        scheduleRevision: 0,
      });

      await scheduler.start();

      expect(cronFactory.activeCount()).toBe(0);
    });

    test("S3: filters out manual-only loops", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: null,
        enabled: true,
      });

      await scheduler.start();

      expect(cronFactory.activeCount()).toBe(0);
    });

    test("S4: handles empty database gracefully", async () => {
      await scheduler.start();

      expect(cronFactory.activeCount()).toBe(0);
    });
  });

  describe("Dynamic reconcile", () => {
    test("S5: no-op when schedule unchanged", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      const initialCount = cronFactory.jobs.size;

      // Reconcile with same config
      const [loop] = await db.select().from(loops);
      scheduler.reconcile(loop!);

      expect(cronFactory.jobs.size).toBe(initialCount);
    });

    test("S6: replaces job on revision change", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      const initialJobCount = cronFactory.jobs.size;

      // Update schedule (increments revision)
      await updateSchedule({ db, clock }, "loop-1", { cron: "0 14 * * *" });
      const [updatedLoop] = await db.select().from(loops);
      scheduler.reconcile(updatedLoop!);

      // New job created, old job stopped
      expect(cronFactory.jobs.size).toBe(initialJobCount + 1);
      expect(cronFactory.activeCount()).toBe(1);
    });

    test("S7: removes job when loop is paused", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      expect(cronFactory.activeCount()).toBe(1);

      // Pause loop
      await updateSchedule({ db, clock }, "loop-1", { enabled: false });
      const [pausedLoop] = await db.select().from(loops);
      scheduler.reconcile(pausedLoop!);

      expect(cronFactory.activeCount()).toBe(0);
    });

    test("S8: removes job when cron is cleared", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      expect(cronFactory.activeCount()).toBe(1);

      // Clear cron
      await updateSchedule({ db, clock }, "loop-1", { cron: null });
      const [manualLoop] = await db.select().from(loops);
      scheduler.reconcile(manualLoop!);

      expect(cronFactory.activeCount()).toBe(0);
    });

    test("S21: reconcile never downgrades or resurrects a loop from a stale revision (Round 3)", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 2,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      const [revision2] = await db.select().from(loops).where(eq(loops.id, "loop-1"));

      scheduler.reconcile({ ...revision2!, cron: "0 14 * * *", scheduleRevision: 1 });
      expect(cronFactory.jobs.size).toBe(1);
      expect(cronFactory.activeCount()).toBe(1);
      expect(cronFactory.entries().filter((entry) => !entry.stopped)[0]!.pattern).toBe("0 10 * * *");

      scheduler.reconcile({ ...revision2!, enabled: false, scheduleRevision: 3 });
      expect(cronFactory.activeCount()).toBe(0);

      scheduler.reconcile(revision2!);
      expect(cronFactory.activeCount()).toBe(0);
      expect(cronFactory.jobs.size).toBe(1);
    });
  });

  describe("Callback execution and isolation", () => {
    test("S9: callback invokes coordinator with scheduled trigger", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();

      // Trigger all jobs
      await cronFactory.triggerAll();

      // Verify run was enqueued
      const allRuns = await db.select().from(runs);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]).toMatchObject({
        loopId: "loop-1",
        phase: "pending",
        role: "exec",
      });
    });

    test("S10: one loop's corrupt persisted cron stays isolated at scan; the healthy loop catches up and ticks", async () => {
      // A loop whose persisted cron cannot be evaluated (bypassed write-time
      // validation) is now rejected by the START scan's fail-closed state
      // validation (Batch 3 §2.1 step 2) — no job, no catch-up — and the
      // failure must stay isolated to that loop.
      await seedLoop(db, {
        id: "loop-bad",
        machineId,
        cron: "not-a-cron",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      // One good loop
      await seedLoop(db, {
        id: "loop-good",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();

      // Only the good loop registered a job; its restart catch-up already
      // enqueued the 10:00 occurrence.
      expect(cronFactory.activeCount()).toBe(1);
      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]!.loopId).toBe("loop-good");

      // The failure was logged with its fixed classification — the corrupt
      // cron string itself never reaches the log.
      expect(logs).toEqual(["scheduler: invalid_schedule_state loop=loop-bad"]);
    });

    test("S11: stopped scheduler rejects reconcile", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      await scheduler.stopAndDrain();

      // Reconcile after stop should be no-op
      const [loop] = await db.select().from(loops);
      scheduler.reconcile(loop!);

      expect(cronFactory.activeCount()).toBe(0);
    });

    test("S12: stopAndDrain waits for in-flight callbacks", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();

      // Trigger jobs (async callbacks)
      const triggerPromise = cronFactory.triggerAll();

      // Stop should wait for callbacks
      await scheduler.stopAndDrain();

      // Ensure trigger completed
      await triggerPromise;

      expect(cronFactory.activeCount()).toBe(0);
    });
  });

  describe("Croner wiring and occurrence reconstruction", () => {
    test("S13: registers jobs with timezone and protect/catch handlers", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();

      const entry = cronFactory.entries()[0]!;
      expect(entry.pattern).toBe("0 10 * * *");
      expect(entry.options.timezone).toBe("Asia/Shanghai");
      // Overrun and error handlers are ALWAYS wired (production adds the fixed
      // mode/unref options on top — pinned in croner-factory.test.ts).
      expect(typeof entry.options.protect).toBe("function");
      expect(typeof entry.options.catch).toBe("function");

      // The handlers log fixed classifications only
      entry.options.protect!(null);
      entry.options.catch!(new Error("sensitive detail"));
      expect(logs).toEqual(["scheduler: overrun loop=loop-1", "scheduler: croner_error loop=loop-1"]);
    });

    test("S14: a stale callback from a replaced job is rejected by revision", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      const oldEntry = cronFactory.entries()[0]!;

      // Batch 3: start()'s restart catch-up already enqueued the 10:00
      // occurrence — the stale-callback proof is that NO FURTHER write lands.
      const runsAfterStart = await snapshotRuns(db);
      expect(runsAfterStart).toHaveLength(1);

      // Config change → revision 1 → reconcile stops the old job
      await updateSchedule({ db, clock }, "loop-1", { cron: "0 14 * * *" });
      const [updatedLoop] = await db.select().from(loops);
      scheduler.reconcile(updatedLoop!);
      expect(oldEntry.stopped).toBe(true);

      // A leaked/late firing of the OLD callback carries the captured revision 0
      await oldEntry.callback();

      // Rejected as stale — no new run, watermark of the NEW config untouched
      expect(await snapshotRuns(db)).toHaveLength(1);
      const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
      expect(loop!.lastScheduledAt).toBeNull();
      expect(logs).toEqual(["scheduler: enqueue_skipped loop=loop-1 reason=stale_revision"]);
    });

    test("S15: callback reconstructs the canonical occurrence from a delayed firing", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();

      // The 10:00 tick fires 37 seconds late (system load) — still within the
      // 2-minute lookback, so the canonical occurrence is reconstructed.
      clock.advance(37_000);
      await cronFactory.triggerAll();

      const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
      expect(loop!.lastScheduledAt).toBe(OCCURRENCE_10AM);
      expect(await snapshotRuns(db)).toHaveLength(1);
    });

    test("S16: a long-delayed callback still reconstructs its canonical occurrence", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *", // daily
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();

      // The 10:00 tick fires 2.5 hours late (process suspended / event loop
      // stalled) — a fired callback is a live occurrence and must NOT be
      // silently dropped by an arbitrary lookback window (Round 2).
      clock.advance(2.5 * 60 * 60 * 1000);
      await cronFactory.triggerAll();

      const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
      expect(loop!.lastScheduledAt).toBe(OCCURRENCE_10AM);
      expect(await snapshotRuns(db)).toHaveLength(1);
    });

    test("S17: the callback promise stays pending until the enqueue settles (overrun protection)", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      // Gate the enqueue INSIDE the coordinator: the callback cannot complete
      // until the gate opens — exactly what Croner's protect needs to see.
      // The gate is ARMED ONLY AFTER start(): Batch 3's restart catch-up is
      // also an enqueue and must not deadlock boot.
      let release: (() => void) | undefined;
      let gateEnabled = false;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gatedCoordinator = createRunCoordinator(
        testDeps(db, clock, { hooks: { beforeEnqueueTx: () => (gateEnabled ? gate : undefined) } }),
      );
      const gatedScheduler = createScheduler({
        db,
        coordinator: gatedCoordinator,
        clock,
        cronFactory,
        log: (line) => logs.push(line),
      });
      await gatedScheduler.start();

      // Catch-up at start already enqueued the 10:00 occurrence.
      expect(await snapshotRuns(db)).toHaveLength(1);

      gateEnabled = true;
      const [cbPromise] = cronFactory.fireAll();
      let settled = false;
      void cbPromise!.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      // Flush microtasks — the callback is parked on the gated enqueue
      await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false); // Croner would see the job as busy → skip re-entry

      release!();
      await cbPromise;
      expect(settled).toBe(true);
      // The tick's occurrence was already covered by the catch-up watermark —
      // controlled skip, still exactly one run.
      expect(await snapshotRuns(db)).toHaveLength(1);
    });

    test("S18: start() propagates a scan-level DB failure (boot must fail)", async () => {
      const h = await openMigratedDb();
      await closeDb(h); // scan against a closed database

      const deadScheduler = createScheduler({
        db: h.db,
        coordinator,
        clock,
        cronFactory,
        log: (line) => logs.push(line),
      });

      await expect(deadScheduler.start()).rejects.toThrow();
      expect(cronFactory.activeCount()).toBe(0);
    });

    test("S19: a callback firing after stopAndDrain touches nothing (stopped guard)", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      await scheduler.start();
      const entry = cronFactory.entries()[0]!;
      await scheduler.stopAndDrain();

      // A timer that outlived stop() fires into the guard — no DB access, no
      // logs, no runs. (Proven against a CLOSED database: any access throws.)
      await closeDb(handles.splice(0)[0]!);
      await entry.callback();

      expect(logs).toEqual([]);
    });

    test("S20: a callback racing a schedule update loses to the revision guard (Round 2)", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: ACTIVATION_9AM,
      });

      // Gate the enqueue INSIDE the coordinator so the callback is parked
      // mid-flight while the schedule update commits. The gate arms ONLY
      // AFTER start() so Batch 3's restart catch-up cannot deadlock boot.
      let release: (() => void) | undefined;
      let gateEnabled = false;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gatedCoordinator = createRunCoordinator(
        testDeps(db, clock, { hooks: { beforeEnqueueTx: () => (gateEnabled ? gate : undefined) } }),
      );
      const gatedScheduler = createScheduler({
        db,
        coordinator: gatedCoordinator,
        clock,
        cronFactory,
        log: (line) => logs.push(line),
      });
      await gatedScheduler.start();

      // Catch-up at start enqueued the 10:00 occurrence under revision 0.
      expect(await snapshotRuns(db)).toHaveLength(1);

      // Tick fires, callback parks inside the gated enqueue
      gateEnabled = true;
      const [cbPromise] = cronFactory.fireAll();

      // The schedule update COMMITS while the callback is in flight (rev 0→1)
      await updateSchedule({ db, clock }, "loop-1", { cron: "0 14 * * *" });
      const [updatedLoop] = await db.select().from(loops);
      gatedScheduler.reconcile(updatedLoop!);

      // Release the in-flight callback: its captured revision 0 is now stale
      release!();
      await cbPromise;

      // Rejected by the revision guard — no NEW run, and the NEW config's
      // watermark was not polluted by the stale callback
      expect(await snapshotRuns(db)).toHaveLength(1);
      const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
      expect(loop!.scheduleRevision).toBe(1);
      expect(loop!.lastScheduledAt).toBeNull();
      expect(logs).toEqual(["scheduler: enqueue_skipped loop=loop-1 reason=stale_revision"]);
    });
  });
});

/**
 * Phase 5 Batch 3 slice 3 (ADR-011): execution-eligibility boundaries.
 *
 * The scheduler treats a machine as execution-eligible only when it exists,
 * is CLAIMED by a team (`teamId` non-null) and is NOT revoked. An unclaimed
 * or revoked machine's loops must not schedule, catch up, or add Runs.
 */
describe("scheduler eligibility (Phase 5 Batch 3 slice 3)", () => {
  let db: Db;
  let clock: FakeClock;
  let cronFactory: FakeCronFactory;
  let logs: string[];

  const CLAIMED = TEST_TEAM_ID;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T12:30:00.000Z"));
    cronFactory = new FakeCronFactory();
    logs = [];
  });

  function makeScheduler(): Scheduler {
    return createScheduler({
      db,
      coordinator: createRunCoordinator(testDeps(db, clock)),
      clock,
      cronFactory,
      log: (line) => logs.push(line),
    });
  }

  async function seedScheduledLoop(id: string, machineId: string): Promise<void> {
    await seedLoop(db, {
      id,
      machineId,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      // Down across the 10:00 tick (now 12:30) — an ELIGIBLE loop WOULD
      // catch up, so a silent catch-up here proves the exclusion.
      scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
    });
  }

  test("PE1: an UNCLAIMED machine's loop gets no job and no catch-up", async () => {
    const machineId = "m-unclaimed000000";
    await seedMachine(db, machineId); // teamId NULL — unclaimed
    await seedScheduledLoop("loop-1", machineId);

    const scheduler = makeScheduler();
    await scheduler.start();

    expect(cronFactory.activeCount()).toBe(0);
    expect(await snapshotRuns(db)).toEqual([]);
  });

  test("PE2: a REVOKED machine's loop gets no job and no catch-up", async () => {
    const machineId = "m-revoked0000000";
    await db.insert(machines).values({
      id: machineId,
      name: "",
      tokenHash: "hash-revoked",
      teamId: CLAIMED,
      revokedAt: "2026-08-27T09:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await seedScheduledLoop("loop-1", machineId);

    const scheduler = makeScheduler();
    await scheduler.start();

    expect(cronFactory.activeCount()).toBe(0);
    expect(await snapshotRuns(db)).toEqual([]);
  });

  test("PE3: a CLAIMED, non-revoked machine's loop registers and catches up (the control)", async () => {
    const machineId = "m-eligible0000000";
    await seedClaimedMachineById(db, machineId);
    await seedScheduledLoop("loop-1", machineId);

    const scheduler = makeScheduler();
    await scheduler.start();

    expect(cronFactory.activeCount()).toBe(1);
    // The downtime's 10:00 occurrence was recovered — the exclusion in PE1/PE2
    // is what suppressed it there, not a missing occurrence.
    const runs = await snapshotRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ loopId: "loop-1", phase: "pending" });
  });

  test("PE4: a loop whose machine row does not exist is excluded (no FK, so this is reachable)", async () => {
    await seedScheduledLoop("loop-1", "m-doesnotexist00");

    const scheduler = makeScheduler();
    await scheduler.start();

    expect(cronFactory.activeCount()).toBe(0);
    expect(await snapshotRuns(db)).toEqual([]);
  });

  test("PE5: an eligible loop that turns ineligible mid-flight has its TICK refused — no run, no cursor advance", async () => {
    const machineId = "m-eligibleflip000";
    await seedClaimedMachineById(db, machineId);
    await seedScheduledLoop("loop-1", machineId);

    const scheduler = makeScheduler();
    await scheduler.start();
    const runsAfterCatchup = await snapshotRuns(db);
    expect(runsAfterCatchup).toHaveLength(1);

    // The machine is revoked AFTER registration (no online revoke exists in
    // this slice — slice 4's CLI must run with the server stopped — so this
    // models a restart-interleaved or out-of-band revocation).
    await db.update(machines).set({ revokedAt: clock.iso() }).where(eq(machines.id, machineId));

    // The cron tick fires against the now-ineligible machine.
    const before = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    await cronFactory.triggerAll();

    expect(logs).toContain("scheduler: machine_ineligible loop=loop-1");
    expect(await snapshotRuns(db)).toHaveLength(1); // NO new run
    const after = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    expect(after[0]!.lastScheduledAt).toBe(before[0]!.lastScheduledAt); // cursor did not advance
  });

  /**
   * Issue #121: the eligibility read is an AWAIT inside the tick, so the tick
   * must be in the drain set from its very first synchronous moment. These two
   * tests park the read on an injected barrier (the `isMachineEligible`
   * TEST-ONLY seam — production always uses the store predicate) and prove the
   * contract that the read alone used to break:
   *   - stopAndDrain() does NOT return while the read is in flight;
   *   - once released after a stop, the tick enqueues NOTHING (no run, no
   *     cursor advance, no DB write into a closing database);
   *   - a failing read is isolated (fixed `croner_error` classification stays
   *     Croner's) and still settles the drain.
   */
  test("PD1: stopAndDrain waits for a tick parked on its eligibility read and the tick then enqueues nothing", async () => {
    const machineId = "m-eligiblepark000";
    await seedClaimedMachineById(db, machineId);
    await seedScheduledLoop("loop-1", machineId);

    let releaseRead: (() => void) | undefined;
    let readStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readEntered = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const scheduler = createScheduler({
      db,
      coordinator: createRunCoordinator(testDeps(db, clock)),
      clock,
      cronFactory,
      log: (line) => logs.push(line),
      isMachineEligible: async () => {
        readStarted!();
        await readGate;
        return true; // the machine IS eligible — only the stop decides
      },
    });
    await scheduler.start();

    // The 10:00 occurrence was already recovered by the catch-up.
    expect(await snapshotRuns(db)).toHaveLength(1);
    const before = await db.select().from(loops).where(eq(loops.id, "loop-1"));

    // Move past the NEXT occurrence (the next day's 10:00), so the parked
    // tick — were it to run its enqueue after the stop — would add a run
    // rather than being benignly skipped as `already_scheduled`. The run count
    // below is therefore a real oracle for "no write after stop".
    clock.advance(24 * 60 * 60 * 1000);

    const [tick] = cronFactory.fireAll();
    await readEntered; // the tick is parked INSIDE the eligibility read

    let drained = false;
    const drain = scheduler.stopAndDrain().then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false); // the drain did NOT return early

    releaseRead!();
    await drain;
    await tick;

    expect(drained).toBe(true);
    expect(await snapshotRuns(db)).toHaveLength(1); // NO run after the stop
    const after = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    expect(after[0]!.lastScheduledAt).toBe(before[0]!.lastScheduledAt);
    expect(after[0]!.revision).toBe(before[0]!.revision);
    expect(logs).toEqual([]); // no enqueue path was even attempted
  });

  test("PD2: a failing eligibility read is isolated and still settles the drain", async () => {
    const machineId = "m-eligiblefail000";
    await seedClaimedMachineById(db, machineId);
    await seedScheduledLoop("loop-1", machineId);

    const scheduler = createScheduler({
      db,
      coordinator: createRunCoordinator(testDeps(db, clock)),
      clock,
      cronFactory,
      log: (line) => logs.push(line),
      isMachineEligible: async () => {
        throw new Error("eligibility read failed (detail never logged)");
      },
    });
    await scheduler.start();
    expect(await snapshotRuns(db)).toHaveLength(1); // catch-up run only

    const [tick] = cronFactory.fireAll();
    // The rejection reaches Croner's `catch` in production (fixed
    // `croner_error` line) — it is not swallowed by the drain set.
    await expect(tick).rejects.toThrow("eligibility read failed");

    await scheduler.stopAndDrain(); // settles: nothing is left in flight
    expect(await snapshotRuns(db)).toHaveLength(1);
    expect(logs).toEqual([]);
  });
});
