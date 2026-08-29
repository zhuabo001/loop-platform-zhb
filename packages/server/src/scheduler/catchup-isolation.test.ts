/**
 * X-group tests: fault isolation and log discipline for restart catch-up
 * (Phase 3 Batch 3 plan §三 X1–X3; X4 is the full quality-gate run).
 *
 *  - X1: every corrupt persisted-state dimension fails closed at the startup
 *    scan while a healthy loop still recovers;
 *  - X2: one loop's catch-up enqueue failure neither blocks the other loops'
 *    recovery nor fails start() (readiness);
 *  - X3: logs carry fixed classifications + loop ids ONLY — never the cron,
 *    timezone, exception message or any other untrusted value.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops } from "../db/schema.js";
import { FakeClock, seedMachine, seedLoop, snapshotRuns, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createScheduler, type CronJob, type CronFactory, type Scheduler } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

const MACHINE_ID = "m-test123456789a";
const ACTIVATION_9AM = "2026-08-27T09:00:00.000Z";

class FakeCronFactory implements CronFactory {
  private entriesList: { stopped: boolean }[] = [];
  create(
    _pattern: string,
    _options: { timezone: string },
    _callback: () => void | Promise<void>,
  ): CronJob {
    const entry = { stopped: false };
    this.entriesList.push(entry);
    return { stop: () => (entry.stopped = true) };
  }
  activeCount(): number {
    return this.entriesList.filter((e) => !e.stopped).length;
  }
}

describe("X-group: catch-up fault isolation and log discipline", () => {
  let db: Db;
  let clock: FakeClock;
  let logs: string[];
  let cronFactory: FakeCronFactory;
  let coordinator: RunCoordinator;
  let scheduler: Scheduler;
  let runSeq: number;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T12:30:00.000Z"));
    logs = [];
    runSeq = 0;
    await seedMachine(db, MACHINE_ID);
    cronFactory = new FakeCronFactory();
    coordinator = createRunCoordinator(testDeps(db, clock, { newRunId: () => `run-${++runSeq}` }));
    scheduler = createScheduler({ db, coordinator, clock, cronFactory, log: (line) => logs.push(line) });
  });

  test("X1: every corrupt persisted-state dimension fails closed while the healthy loop recovers", async () => {
    await seedLoop(db, {
      id: "loop-bad-cron",
      machineId: MACHINE_ID,
      cron: "not-a-cron",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    await seedLoop(db, {
      id: "loop-bad-tz",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "Not/AZone",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    await seedLoop(db, {
      id: "loop-bad-activation",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-08-27T17:00:00+08:00", // non-canonical
    });
    await seedLoop(db, {
      id: "loop-bad-watermark",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
      lastScheduledAt: "garbage",
    });
    await seedLoop(db, {
      id: "loop-healthy",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    await scheduler.start();

    // Corrupt rows: no job, no run. Healthy loop: job + catch-up run.
    expect(cronFactory.activeCount()).toBe(1);
    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ loopId: "loop-healthy", phase: "pending" });

    // Each corrupt loop logged exactly one fixed classification.
    expect(logs.sort()).toEqual([
      "scheduler: invalid_schedule_state loop=loop-bad-activation",
      "scheduler: invalid_schedule_state loop=loop-bad-cron",
      "scheduler: invalid_schedule_state loop=loop-bad-tz",
      "scheduler: invalid_schedule_state loop=loop-bad-watermark",
    ]);
  });

  test("X2: one loop's catch-up enqueue failure blocks neither the other loops nor readiness", async () => {
    await seedLoop(db, {
      id: "loop-failing",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    await seedLoop(db, {
      id: "loop-healthy",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    // The enqueue transaction blows up for ONE loop only.
    const failingCoordinator = createRunCoordinator(
      testDeps(db, clock, {
        newRunId: () => `run-${++runSeq}`,
        hooks: {
          beforeEnqueueTx: (loopId) => {
            if (loopId === "loop-failing") throw new Error("injected db write failure with sensitive detail");
          },
        },
      }),
    );
    const isolated = createScheduler({
      db,
      coordinator: failingCoordinator,
      clock,
      cronFactory,
      log: (line) => logs.push(line),
    });

    // start() RESOLVES — a per-loop recovery failure is not a boot failure.
    await isolated.start();

    // Both jobs registered (online scheduling unaffected); only the healthy
    // loop's catch-up landed.
    expect(cronFactory.activeCount()).toBe(2);
    const allRuns = await snapshotRuns(db);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ loopId: "loop-healthy", phase: "pending" });

    // The failed loop's watermark was NOT advanced (full rollback) and the
    // failure logged a fixed classification WITHOUT the exception message.
    const [failing] = await db.select().from(loops).where(eq(loops.id, "loop-failing"));
    expect(failing!.lastScheduledAt).toBeNull();
    expect(logs).toEqual(["scheduler: enqueue_failed loop=loop-failing"]);
    expect(logs.join("\n")).not.toContain("sensitive detail");
  });

  test("X3: logs never carry cron, timezone, exception messages or other untrusted values", async () => {
    const EVIL_CRON = "0 10 * * *\nFORGED-LOG-LINE";
    const EVIL_TZ = "UTC\nFORGED-TZ-LINE";
    await seedLoop(db, {
      id: "loop-evil",
      machineId: MACHINE_ID,
      cron: EVIL_CRON,
      timezone: EVIL_TZ,
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });
    await seedLoop(db, {
      id: "loop-throws",
      machineId: MACHINE_ID,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: ACTIVATION_9AM,
    });

    const throwingCoordinator = createRunCoordinator(
      testDeps(db, clock, {
        newRunId: () => `run-${++runSeq}`,
        hooks: {
          beforeEnqueueTx: () => {
            throw new Error("sensitive exception message");
          },
        },
      }),
    );
    const guarded = createScheduler({
      db,
      coordinator: throwingCoordinator,
      clock,
      cronFactory,
      log: (line) => logs.push(line),
    });
    await guarded.start();

    // Every line is a fixed classification + loop id — nothing else.
    for (const line of logs) {
      expect(line).toMatch(/^scheduler: (invalid_schedule_state|enqueue_failed|occurrence_rebuild_failed|job_register_failed|job_stop_failed|enqueue_skipped|overrun|croner_error) loop=\S+$/);
    }
    const blob = logs.join("\n");
    expect(blob).not.toContain("FORGED-LOG-LINE");
    expect(blob).not.toContain("FORGED-TZ-LINE");
    expect(blob).not.toContain("sensitive exception message");
    expect(blob).not.toContain(EVIL_CRON);
    expect(blob).not.toContain(EVIL_TZ);
    // And both loops WERE processed (isolation): one failed validation, the
    // other's enqueue threw.
    expect(logs).toContain("scheduler: invalid_schedule_state loop=loop-evil");
    expect(logs).toContain("scheduler: enqueue_failed loop=loop-throws");
  });
});
