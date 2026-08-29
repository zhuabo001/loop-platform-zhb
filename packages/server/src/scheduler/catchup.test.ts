/**
 * R-group tests: restart catch-up (Phase 3 Batch 3 plan §三 R1–R12).
 *
 * Tests cover:
 *  - R1–R4: single missed occurrence, long downtime latest-only recovery,
 *    pre-first-occurrence restart, consecutive restarts on one FILE database
 *  - R5–R8: catch-up vs existing scheduled pending / running / manual
 *    pending / manual trigger interleavings (T7 supersede, running skip)
 *  - R9–R10: online callback and schedule update racing the recovery pass
 *  - R11: DST gap invents nothing, DST overlap recovers the FIRST occurrence
 *  - R12: injected enqueue failure rolls back watermark+cancel+insert; the
 *    next restart retries cleanly
 *
 * A "restart" is a FRESH scheduler (and coordinator) instance over the same
 * database handle; R4 additionally proves it across a real close/reopen of a
 * file-backed PGlite. The clock always starts AFTER the occurrences the
 * "downtime" missed.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops } from "../db/schema.js";
import { updateSchedule } from "../schedule/index.js";
import { FakeClock, seedMachine, seedLoop, seedRun, snapshotRuns, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createScheduler, type CronJob, type CronFactory, type Scheduler } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

const MACHINE_ID = "m-test123456789a";
/** Activation strictly before every occurrence used below. */
const ACTIVATION_9AM = "2026-08-27T09:00:00.000Z";

interface FakeJobEntry {
  pattern: string;
  options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void };
  callback: () => void | Promise<void>;
  stopped: boolean;
}

/** Fake Croner factory (same shape as the S-group's): jobs fire on demand. */
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

  async triggerAll(): Promise<void> {
    await Promise.all(this.fireAll());
  }

  fireAll(): Promise<unknown>[] {
    const promises: Promise<unknown>[] = [];
    for (const entry of this.jobs.values()) {
      if (!entry.stopped) promises.push(Promise.resolve(entry.callback()));
    }
    return promises;
  }

  activeCount(): number {
    return [...this.jobs.values()].filter((e) => !e.stopped).length;
  }
}

async function watermarkOf(db: Db, loopId: string): Promise<string | null> {
  const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
  return loop?.lastScheduledAt ?? null;
}

describe("R-group: restart catch-up", () => {
  let db: Db;
  let clock: FakeClock;
  let logs: string[];
  let runSeq: number;

  /** Builds a fresh scheduler+coordinator pair over the CURRENT db handle —
   *  one per "boot". Run ids come from a SHARED sequence: a restarted server
   *  must never re-mint an id that already exists in the persisted database. */
  function bootScheduler(overrides: Parameters<typeof testDeps>[2] = {}) {
    const coordinator: RunCoordinator = createRunCoordinator(
      testDeps(db, clock, { newRunId: () => `run-${++runSeq}`, ...overrides }),
    );
    const cronFactory = new FakeCronFactory();
    const scheduler: Scheduler = createScheduler({
      db,
      coordinator,
      clock,
      cronFactory,
      log: (line) => logs.push(line),
    });
    return { coordinator, cronFactory, scheduler };
  }

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T12:30:00.000Z"));
    logs = [];
    runSeq = 0;
    await seedMachine(db, MACHINE_ID);
  });

  test("R1: a short downtime missing ONE occurrence recovers exactly that occurrence", async () => {
    // Down across the 10:00 daily tick; now 12:30.
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    const { scheduler, cronFactory } = bootScheduler();
    await scheduler.start();

    expect(cronFactory.activeCount()).toBe(1);
    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ loopId: "loop-1", phase: "pending", role: "exec" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
  });

  test("R2: a long downtime spanning MANY occurrences recovers only the latest one", async () => {
    // Minutely cron, down for 3.5 hours (~210 occurrences); now 12:30.
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "* * * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    const { scheduler } = bootScheduler();
    await scheduler.start();

    // ONE pending run for the 12:30 occurrence — no historical backlog.
    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T12:30:00.000Z");
  });

  test("R3: a restart between activation and the first occurrence creates nothing", async () => {
    // Activated 11:00, daily 10:00 cron — the next tick is tomorrow; now 12:30.
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-08-27T11:00:00.000Z",
    });

    const { scheduler, cronFactory } = bootScheduler();
    await scheduler.start();

    expect(cronFactory.activeCount()).toBe(1); // the job still registers
    expect(await snapshotRuns(db)).toHaveLength(0);
    expect(await watermarkOf(db, "loop-1")).toBeNull();
    expect(logs).toEqual([]); // a normal no-occurrence recovery logs nothing
  });

  test("R4: two consecutive restarts on the same FILE database never double-recover", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-r4-${process.pid}-`));

    // First boot: down across the 10:00 tick, now 12:30 → catch-up enqueues.
    const h1 = await openMigratedDb({ dataDir });
    handles.push(h1);
    db = h1.db;
    await seedMachine(db, MACHINE_ID);
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    const first = bootScheduler();
    await first.scheduler.start();
    expect(await snapshotRuns(db)).toHaveLength(1);
    await first.scheduler.stopAndDrain();
    await closeDb(h1);
    handles.splice(handles.indexOf(h1), 1);

    // Second boot over the SAME file database: the occurrence is already
    // covered by the persisted watermark — nothing new.
    const h2 = await openMigratedDb({ dataDir });
    handles.push(h2);
    db = h2.db;
    const second = bootScheduler();
    await second.scheduler.start();

    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
    await second.scheduler.stopAndDrain();
  });

  test("R5: an existing scheduled pending is superseded by the latest recovered occurrence", async () => {
    // Hourly cron. Before "downtime": the 10:00 tick produced run-old (pending).
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    clock = new FakeClock(new Date("2026-08-27T10:05:00.000Z"));
    const before = bootScheduler();
    const enqueued = await before.coordinator.enqueueExecRun("loop-1", {
      kind: "scheduled",
      scheduledFor: "2026-08-27T10:00:00.000Z",
      scheduleRevision: 0,
    });
    expect(enqueued.enqueued).toBe(true);

    // Downtime across 11:00 and 12:00; restart at 12:30.
    clock = new FakeClock(new Date("2026-08-27T12:30:00.000Z"));
    const { scheduler } = bootScheduler();
    await scheduler.start();

    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(2);
    expect(allRuns[0]).toMatchObject({ phase: "canceled", outcome: "skipped" });
    expect(allRuns[1]).toMatchObject({ phase: "pending" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T12:00:00.000Z");
  });

  test("R6: an existing running run is not duplicated, but the watermark advances", async () => {
    // The 10:00 daily occurrence was claimed and is still running; downtime
    // means its tick already advanced nothing beyond 10:00.
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
      lastScheduledAt: "2026-08-26T10:00:00.000Z", // yesterday's tick
    });
    await seedRun(db, { id: "run-running", loopId: "loop-1", machineId: MACHINE_ID, phase: "running" });

    const { scheduler } = bootScheduler();
    await scheduler.start();

    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ id: "run-running", phase: "running" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
  });

  test("R7: an existing MANUAL pending is superseded by the catch-up (T7)", async () => {
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    // A manual Run Now landed before the restart and was never claimed.
    const before = bootScheduler();
    const manual = await before.coordinator.enqueueExecRun("loop-1", { kind: "manual" });
    expect(manual.enqueued).toBe(true);

    const { scheduler } = bootScheduler();
    await scheduler.start();

    // Exactly one pending survives and it is the SCHEDULED catch-up run.
    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(2);
    expect(allRuns[0]).toMatchObject({ phase: "canceled", outcome: "skipped" });
    expect(allRuns[1]).toMatchObject({ phase: "pending" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
  });

  test("R8: manual trigger and catch-up in EITHER order converge to at most one pending, never a double run", async () => {
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    // Order A: catch-up first, manual second — the manual Run Now supersedes.
    {
      const { scheduler, coordinator } = bootScheduler();
      await scheduler.start();
      await coordinator.enqueueExecRun("loop-1", { kind: "manual" });
      const allRuns = await snapshotRuns(db);
      expect(allRuns.filter((r) => r.phase === "pending")).toHaveLength(1);
      await scheduler.stopAndDrain();
    }

    // Reset to a clean slate for order B.
    await db.delete(loops).where(eq(loops.id, "loop-1"));
    const { runs } = await import("../db/schema.js");
    await db.delete(runs);
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    // Order B: manual first, catch-up second — the catch-up supersedes (R7),
    // and a CONCURRENT manual trigger racing start() still converges.
    {
      const { scheduler, coordinator } = bootScheduler();
      await coordinator.enqueueExecRun("loop-1", { kind: "manual" });
      await Promise.all([scheduler.start(), coordinator.enqueueExecRun("loop-1", { kind: "manual" })]);
      const allRuns = await snapshotRuns(db);
      expect(allRuns.filter((r) => r.phase === "pending")).toHaveLength(1);
      expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
      await scheduler.stopAndDrain();
    }
  });

  test("R9: an online callback and the catch-up hitting the SAME occurrence dedupe on the watermark", async () => {
    // Reboot exactly at the 10:00 tick: the recovery pass and the live job
    // both target 10:00. The catch-up is gated mid-flight so the online tick
    // REALLY interleaves instead of merely following.
    clock = new FakeClock(new Date("2026-08-27T10:00:00.000Z"));
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gateUsed = false;
    const { scheduler, cronFactory } = bootScheduler({
      hooks: {
        beforeEnqueueTx: () => {
          if (gateUsed) return undefined;
          gateUsed = true;
          return gate;
        },
      },
    });

    const startPromise = scheduler.start();
    // Jobs are registered BEFORE the catch-up pass — the live tick fires while
    // the gated catch-up is parked, and serializes behind it per loop.
    await cronFactory.triggerAll();
    release!();
    await startPromise;

    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
  });

  test("R10: a schedule update racing the recovery rejects the old revision and never backfills", async () => {
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    // Park the catch-up enqueue mid-flight, then commit the schedule update.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gateUsed = false;
    const { scheduler } = bootScheduler({
      hooks: {
        beforeEnqueueTx: () => {
          if (gateUsed) return undefined;
          gateUsed = true;
          return gate;
        },
      },
    });

    const startPromise = scheduler.start();
    await updateSchedule({ db, clock }, "loop-1", { cron: "0 14 * * *" });
    release!();
    await startPromise;

    // The old revision's catch-up lost: NO run, and the NEW activation
    // (12:30) does not backfill the 10:00 occurrence.
    expect(await snapshotRuns(db)).toHaveLength(0);
    const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    expect(loop).toMatchObject({ scheduleRevision: 1, cron: "0 14 * * *", lastScheduledAt: null });
  });

  test("R11: a DST gap invents no occurrence; a DST overlap recovers only the FIRST one", async () => {
    // Gap: 2026-03-08 02:30 America/New_York never happened. A restart after
    // the gap must recover the last REAL tick — March 7 02:30 EST (07:30Z).
    await seedLoop(db, {
      id: "loop-gap",
      machineId: MACHINE_ID,
      cron: "30 2 * * *",
      timezone: "America/New_York",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-03-06T00:00:00.000Z",
    });
    // Overlap: 2026-11-01 01:30 happened TWICE; recovery takes the first
    // (EDT, 05:30Z) — the second spelling is not a second canonical tick.
    await seedLoop(db, {
      id: "loop-overlap",
      machineId: MACHINE_ID,
      cron: "30 1 * * *",
      timezone: "America/New_York",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-10-31T00:00:00.000Z",
    });

    clock = new FakeClock(new Date("2026-03-08T08:00:00.000Z"));
    const gap = bootScheduler();
    await gap.scheduler.start();
    expect(await watermarkOf(db, "loop-gap")).toBe("2026-03-07T07:30:00.000Z");
    await gap.scheduler.stopAndDrain();

    clock = new FakeClock(new Date("2026-11-01T06:45:00.000Z"));
    const overlap = bootScheduler();
    await overlap.scheduler.start();
    expect(await watermarkOf(db, "loop-overlap")).toBe("2026-11-01T05:30:00.000Z");

    // The gap loop ALSO catches up at the second boot — to its own latest
    // REAL occurrence (Oct 31 02:30 EDT = 06:30Z; on the fall-back day 02:30
    // happens at 07:30Z, past the 06:45Z cutoff), still latest-only.
    expect(await watermarkOf(db, "loop-gap")).toBe("2026-10-31T06:30:00.000Z");

    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(3);
    expect(allRuns.filter((r) => r.loopId === "loop-gap")).toHaveLength(2);
    expect(allRuns.filter((r) => r.loopId === "loop-overlap")).toHaveLength(1);
    await overlap.scheduler.stopAndDrain();
  });

  test("R12: an injected enqueue failure rolls back watermark/cancel/insert; the next restart retries", async () => {
    await seedLoop(db, {
      id: "loop-1",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    // First boot: the id factory blows up INSIDE the enqueue transaction.
    let blowUp = true;
    const failing = bootScheduler({
      newRunId: () => {
        if (blowUp) throw new Error("injected id factory failure");
        return "run-recovered";
      },
    });
    await failing.scheduler.start();

    // Complete rollback: no run, watermark untouched, fixed classification.
    expect(await snapshotRuns(db)).toHaveLength(0);
    expect(await watermarkOf(db, "loop-1")).toBeNull();
    expect(logs).toContain("scheduler: enqueue_failed loop=loop-1");

    // Next restart with the fault cleared: the recovery retries and lands.
    blowUp = false;
    const recovered = bootScheduler({
      newRunId: () => "run-recovered",
    });
    await recovered.scheduler.start();

    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ id: "run-recovered", phase: "pending" });
    expect(await watermarkOf(db, "loop-1")).toBe("2026-08-27T10:00:00.000Z");
    await recovered.scheduler.stopAndDrain();
  });
});
