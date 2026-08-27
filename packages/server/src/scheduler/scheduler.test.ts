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
import { loops, runs } from "../db/schema.js";
import { updateSchedule } from "../schedule/index.js";
import { FakeClock, seedMachine, seedLoop, snapshotRuns, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createScheduler, type CronJob, type CronFactory, type Scheduler } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/** Occurrence of the seeded "0 10 * * *" UTC cron on the test day. */
const OCCURRENCE_10AM = "2026-08-27T10:00:00.000Z";
/** Activation strictly before the 10:00 occurrence (activation boundary). */
const ACTIVATION_9AM = "2026-08-27T09:00:00.000Z";

interface FakeJobEntry {
  pattern: string;
  options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void };
  callback: () => void | Promise<void>;
  stopped: boolean;
}

/**
 * Fake Croner factory for testing — jobs fire on demand via trigger()/fireAll().
 */
class FakeCronFactory implements CronFactory {
  public jobs = new Map<string, FakeJobEntry>();
  private idSeq = 0;

  create(
    pattern: string,
    options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void },
    callback: () => void | Promise<void>,
  ): CronJob {
    const id = `job-${++this.idSeq}`;
    this.jobs.set(id, { pattern, options, callback, stopped: false });

    return {
      stop: () => {
        const entry = this.jobs.get(id);
        if (entry) entry.stopped = true;
      },
    };
  }

  /** Triggers all active jobs and waits for every callback to settle. */
  async triggerAll(): Promise<void> {
    await Promise.all(this.fireAll());
  }

  /** Fires all active jobs and returns the RAW callback promises — the exact
   *  promise Croner would track for overrun (protect) purposes. */
  fireAll(): Promise<unknown>[] {
    const promises: Promise<unknown>[] = [];
    for (const entry of this.jobs.values()) {
      if (!entry.stopped) {
        promises.push(Promise.resolve(entry.callback()));
      }
    }
    return promises;
  }

  /** Returns count of active (non-stopped) jobs. */
  activeCount(): number {
    return Array.from(this.jobs.values()).filter((e) => !e.stopped).length;
  }

  /** All entries (including stopped) in registration order. */
  entries(): FakeJobEntry[] {
    return [...this.jobs.values()];
  }
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

    await seedMachine(db, machineId);

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

    test("S10: one loop's callback failure doesn't block others", async () => {
      // A loop whose persisted cron cannot be evaluated (bypassed write-time
      // validation — defensive depth): occurrence reconstruction throws inside
      // its callback, and the failure must stay isolated to that loop.
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

      // Trigger all jobs (one will fail, one will succeed)
      await cronFactory.triggerAll();

      // Good loop enqueued; bad loop produced nothing
      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]!.loopId).toBe("loop-good");

      // The failure was logged with its fixed classification
      expect(logs.some((l) => l === "scheduler: occurrence_rebuild_failed loop=loop-bad")).toBe(true);
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

      // Config change → revision 1 → reconcile stops the old job
      await updateSchedule({ db, clock }, "loop-1", { cron: "0 14 * * *" });
      const [updatedLoop] = await db.select().from(loops);
      scheduler.reconcile(updatedLoop!);
      expect(oldEntry.stopped).toBe(true);

      // A leaked/late firing of the OLD callback carries the captured revision 0
      await oldEntry.callback();

      // Rejected as stale — zero runs, watermark of the NEW config untouched
      expect(await snapshotRuns(db)).toHaveLength(0);
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
      let release: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gatedCoordinator = createRunCoordinator(
        testDeps(db, clock, { hooks: { beforeEnqueueTx: () => gate } }),
      );
      const gatedScheduler = createScheduler({
        db,
        coordinator: gatedCoordinator,
        clock,
        cronFactory,
        log: (line) => logs.push(line),
      });
      await gatedScheduler.start();

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
      // mid-flight while the schedule update commits.
      let release: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gatedCoordinator = createRunCoordinator(
        testDeps(db, clock, { hooks: { beforeEnqueueTx: () => gate } }),
      );
      const gatedScheduler = createScheduler({
        db,
        coordinator: gatedCoordinator,
        clock,
        cronFactory,
        log: (line) => logs.push(line),
      });
      await gatedScheduler.start();

      // Tick fires, callback parks inside the gated enqueue
      const [cbPromise] = cronFactory.fireAll();

      // The schedule update COMMITS while the callback is in flight (rev 0→1)
      await updateSchedule({ db, clock }, "loop-1", { cron: "0 14 * * *" });
      const [updatedLoop] = await db.select().from(loops);
      gatedScheduler.reconcile(updatedLoop!);

      // Release the in-flight callback: its captured revision 0 is now stale
      release!();
      await cbPromise;

      // Rejected by the revision guard — zero runs, and the NEW config's
      // watermark was not polluted by the stale callback
      expect(await snapshotRuns(db)).toHaveLength(0);
      const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
      expect(loop!.scheduleRevision).toBe(1);
      expect(loop!.lastScheduledAt).toBeNull();
      expect(logs).toEqual(["scheduler: enqueue_skipped loop=loop-1 reason=stale_revision"]);
    });
  });
});
