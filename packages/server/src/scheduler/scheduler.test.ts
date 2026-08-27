/**
 * S-group tests: Scheduler registration, reconcile, and lifecycle.
 *
 * Tests cover:
 *  - S1–S4: Active loop scanning, job registration, Croner parameters
 *  - S5–S8: Dynamic reconcile, revision replacement, job removal
 *  - S9–S12: Callback isolation, exception handling, shutdown drain
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, runs } from "../db/schema.js";
import { updateSchedule } from "../schedule/index.js";
import { FakeClock, seedMachine, seedLoop, testDeps } from "../testkit/index.js";
import { createRunCoordinator } from "../coordinator/index.js";
import { createScheduler, type CronJob, type CronFactory, type Scheduler } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/**
 * Fake Croner factory for testing — jobs fire on demand via trigger().
 */
class FakeCronFactory implements CronFactory {
  public jobs = new Map<string, { callback: () => void | Promise<void>; stopped: boolean }>();
  private idSeq = 0;

  create(
    pattern: string,
    options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void },
    callback: () => void | Promise<void>,
  ): CronJob {
    const id = `job-${++this.idSeq}`;
    this.jobs.set(id, { callback, stopped: false });

    return {
      stop: () => {
        const entry = this.jobs.get(id);
        if (entry) entry.stopped = true;
      },
    };
  }

  /** Triggers all active jobs (test helper). */
  async triggerAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const entry of this.jobs.values()) {
      if (!entry.stopped) {
        promises.push(Promise.resolve(entry.callback()));
      }
    }
    await Promise.all(promises);
  }

  /** Returns count of active (non-stopped) jobs. */
  activeCount(): number {
    return Array.from(this.jobs.values()).filter((e) => !e.stopped).length;
  }
}

describe("S-group: Scheduler registration and lifecycle", () => {
  let db: Db;
  let clock: FakeClock;
  let scheduler: Scheduler;
  let cronFactory: FakeCronFactory;
  let machineId: string;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T10:00:00Z"));
    machineId = "m-test123456789a";

    await seedMachine(db, machineId);

    const coordinator = createRunCoordinator(testDeps(db, clock));
    cronFactory = new FakeCronFactory();

    scheduler = createScheduler({
      db,
      coordinator,
      clock,
      cronFactory,
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
        scheduleActivatedAt: clock.now().toISOString(),
      });
      await seedLoop(db, {
        id: "loop-2",
        machineId,
        cron: "0 14 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: clock.now().toISOString(),
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
        scheduleActivatedAt: clock.now().toISOString(),
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
        scheduleActivatedAt: clock.now().toISOString(),
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
        scheduleActivatedAt: clock.now().toISOString(),
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
        scheduleActivatedAt: clock.now().toISOString(),
      });

      await scheduler.start();
      expect(cronFactory.activeCount()).toBe(1);

      // Clear cron
      await updateSchedule({ db, clock }, "loop-1", { cron: null });
      const [manualLoop] = await db.select().from(loops);
      scheduler.reconcile(manualLoop!);

      expect(cronFactory.activeCount()).toBe(0);
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
        scheduleActivatedAt: clock.now().toISOString(),
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

    test("S10: one loop's error doesn't block others", async () => {
      // Create one bad loop (invalid config will fail in callback)
      await seedLoop(db, {
        id: "loop-bad",
        machineId: "m-nonexistent", // Invalid machine
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: clock.now().toISOString(),
      });

      // Create one good loop
      await seedLoop(db, {
        id: "loop-good",
        machineId,
        cron: "0 14 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: clock.now().toISOString(),
      });

      await scheduler.start();

      // Trigger all jobs (one will fail, one will succeed)
      await cronFactory.triggerAll();

      // Good loop should still enqueue
      const allRuns = await db.select().from(runs);
      expect(allRuns.length).toBeGreaterThanOrEqual(1);
      expect(allRuns.some((r) => r.loopId === "loop-good")).toBe(true);
    });

    test("S11: stopped scheduler rejects reconcile", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: clock.now().toISOString(),
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
        scheduleActivatedAt: clock.now().toISOString(),
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
});
