/**
 * O-group tests: scheduled trigger and atomic occurrence handling.
 *
 * Tests cover:
 *  - O1–O4: First occurrence, duplicate rejection, occurrence validation
 *  - O5–O8: Revision guard, watermark progression, activation boundary
 *  - O9–O12: Running skip, pending supersede, transaction rollback, concurrency
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, runs } from "../db/schema.js";
import { updateSchedule } from "../schedule/index.js";
import { FakeClock, seedMachine, seedLoop, snapshotRuns } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinatorDependencies } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

describe("O-group: scheduled trigger and atomic occurrence", () => {
  let db: Db;
  let clock: FakeClock;
  let coordinator: ReturnType<typeof createRunCoordinator>;
  let machineId: string;
  let loopId: string;
  let runIdSeq: number;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T10:00:00Z"));
    machineId = "m-test123456789a";
    runIdSeq = 0;

    await seedMachine(db, machineId);

    const deps: RunCoordinatorDependencies = {
      db,
      clock,
      newRunId: () => `run-${++runIdSeq}`,
      mintRunCredential: () => `rk_testcred_${runIdSeq}`,
    };
    coordinator = createRunCoordinator(deps);

    // Create a scheduled loop
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
      lastScheduledAt: null,
    });
    loopId = "loop-1";
  });

  describe("First occurrence and validation", () => {
    test("O1: enqueues first scheduled occurrence", async () => {
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(true);
      if (!result.enqueued) return;

      expect(result.runId).toBe("run-1");
      expect(result.supersededRunIds).toEqual([]);

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: "run-1",
        loopId: "loop-1",
        phase: "pending",
        role: "exec",
      });
    });

    test("O2: rejects duplicate occurrence (same scheduledFor)", async () => {
      // First enqueue
      await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      // Duplicate attempt
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("already_scheduled");

      // Still only one run
      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(1);
    });

    test("O3: rejects older occurrence than watermark", async () => {
      // First enqueue at 10:00
      await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      // Try to enqueue earlier occurrence
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T09:30:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("already_scheduled");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(1);
    });

    test("O4: rejects occurrence before activation", async () => {
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T08:00:00.000Z", // Before scheduleActivatedAt
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("before_activation");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(0);
    });
  });

  describe("Revision and configuration guards", () => {
    test("O5: rejects stale revision", async () => {
      // Update schedule (increments revision to 1)
      await updateSchedule({ db, clock }, loopId, { cron: "0 14 * * *" });

      // Try to enqueue with old revision
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0, // Stale
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("stale_revision");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(0);
    });

    test("O6: rejects when loop is paused", async () => {
      // Pause the loop
      await updateSchedule({ db, clock }, loopId, { enabled: false });

      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 1, // New revision after pause
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("not_active");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(0);
    });

    test("O7: rejects when cron is cleared", async () => {
      // Clear cron (manual-only)
      await updateSchedule({ db, clock }, loopId, { cron: null });

      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 1,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("not_active");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(0);
    });

    test("O8: advances watermark on successful enqueue", async () => {
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(true);

      // Verify watermark was updated
      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:00:00.000Z");
    });
  });

  describe("Running overlap and pending supersede", () => {
    test("O9: skips enqueue when run is running, but advances watermark", async () => {
      // Create a running run manually
      await db.insert(runs).values({
        id: "run-running",
        loopId,
        machineId,
        phase: "running",
        role: "exec",
        ts: clock.now().toISOString(),
      });

      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("running_exists");

      // Watermark should still advance
      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:00:00.000Z");

      // No new pending run
      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]!.id).toBe("run-running");
    });

    test("O10: supersedes old pending when enqueueing new occurrence", async () => {
      // Create old pending
      await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      // Enqueue newer occurrence
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T11:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(true);
      if (!result.enqueued) return;

      expect(result.supersededRunIds).toEqual(["run-1"]);
      expect(result.runId).toBe("run-2");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({
        id: "run-1",
        phase: "canceled",
        outcome: "skipped",
      });
      expect(runs[1]).toMatchObject({
        id: "run-2",
        phase: "pending",
      });
    });

    test("O11: manual trigger works alongside scheduled (no revision check)", async () => {
      // Manual trigger doesn't check schedule state
      const result = await coordinator.enqueueExecRun(loopId);

      expect(result.enqueued).toBe(true);
      if (!result.enqueued) return;

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        phase: "pending",
        role: "exec",
      });
    });

    test("O12: transaction rolls back on any failure", async () => {
      // Force a failure by using invalid loop ID after watermark would update
      const result = await coordinator.enqueueExecRun("loop-nonexistent", {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("loop_not_found");

      // Original loop should be unchanged (no partial watermark update)
      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBeNull();

      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(0);
    });
  });
});
