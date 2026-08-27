/**
 * O-group tests: scheduled trigger and atomic occurrence handling.
 *
 * Tests cover:
 *  - O1–O4: First occurrence, duplicate rejection, occurrence validation
 *  - O5–O8: Revision guard, watermark progression, activation boundary
 *  - O9–O12: Running skip, pending supersede, transaction rollback, concurrency
 *  - O13–O15: Future occurrence, non-occurrence, real transaction rollback
 *
 * All scheduledFor values are GENUINE occurrences of the seeded loop's cron
 * (review: watermark semantics can only be pinned by real occurrences).
 * The loop seeds cron "0 10 * * *" (daily 10:00 UTC), activation
 * 2026-08-27T09:00Z; the clock starts at 2026-08-27T10:00Z.
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
      // First enqueue the 2026-08-28 occurrence (clock advanced to it)
      clock.advance(24 * 60 * 60 * 1000);
      await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-28T10:00:00.000Z",
        scheduleRevision: 0,
      });

      // Try to enqueue the previous day's genuine occurrence (older than watermark)
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("already_scheduled");

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(1);
    });

    test("O4: rejects occurrence before activation", async () => {
      // 2026-08-26T10:00 is a genuine cron occurrence, but before activation (09:00 on the 27th)
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-26T10:00:00.000Z",
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
      // Create old pending (2026-08-27 occurrence)
      await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-27T10:00:00.000Z",
        scheduleRevision: 0,
      });

      // Enqueue the next day's genuine occurrence (clock advances with time)
      clock.advance(24 * 60 * 60 * 1000);
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-28T10:00:00.000Z",
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

    test("O12: loop_not_found performs zero writes", async () => {
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

  describe("Occurrence authenticity guards", () => {
    test("O13: rejects future occurrence, watermark untouched", async () => {
      // 2026-08-28T10:00 is a genuine occurrence but one day in the FUTURE
      // (clock is at 2026-08-27T10:00). Advancing the watermark to a future
      // instant would swallow every real tick until then.
      const result = await coordinator.enqueueExecRun(loopId, {
        kind: "scheduled",
        scheduledFor: "2026-08-28T10:00:00.000Z",
        scheduleRevision: 0,
      });

      expect(result.enqueued).toBe(false);
      if (result.enqueued) return;
      expect(result.reason).toBe("future_occurrence");

      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBeNull();
      expect(await snapshotRuns(db)).toHaveLength(0);
    });

    test("O14: rejects timestamps that are not occurrences of the loop's cron", async () => {
      // One second past the real occurrence, and a wrong minute entirely.
      // Neither may advance the watermark (review: arbitrary-timestamp pollution).
      for (const scheduledFor of ["2026-08-27T10:00:01.000Z", "2026-08-27T09:59:00.000Z"]) {
        const result = await coordinator.enqueueExecRun(loopId, {
          kind: "scheduled",
          scheduledFor,
          scheduleRevision: 0,
        });

        expect(result.enqueued).toBe(false);
        if (result.enqueued) return;
        expect(result.reason).toBe("not_an_occurrence");
      }

      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBeNull();
      expect(await snapshotRuns(db)).toHaveLength(0);
    });

    test("O15: a mid-transaction failure rolls back the watermark (zero partial writes)", async () => {
      // The run-id factory throws at the INSERT step — AFTER the watermark
      // update inside the same transaction. The whole transaction must roll
      // back: no run row, and lastScheduledAt stays null.
      const failing = createRunCoordinator({
        db,
        clock,
        newRunId: () => {
          throw new Error("injected id-factory failure");
        },
        mintRunCredential: () => "rk_testcred_x",
      });

      await expect(
        failing.enqueueExecRun(loopId, {
          kind: "scheduled",
          scheduledFor: "2026-08-27T10:00:00.000Z",
          scheduleRevision: 0,
        }),
      ).rejects.toThrow("injected id-factory failure");

      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBeNull();
      expect(await snapshotRuns(db)).toHaveLength(0);
    });

    test("O16: concurrent callbacks for the same occurrence enqueue exactly once", async () => {
      // Two callbacks racing the SAME occurrence (per-loop serialization +
      // watermark make exactly one win).
      const [a, b] = await Promise.all([
        coordinator.enqueueExecRun(loopId, {
          kind: "scheduled",
          scheduledFor: "2026-08-27T10:00:00.000Z",
          scheduleRevision: 0,
        }),
        coordinator.enqueueExecRun(loopId, {
          kind: "scheduled",
          scheduledFor: "2026-08-27T10:00:00.000Z",
          scheduleRevision: 0,
        }),
      ]);

      const outcomes = [a, b].map((r) => (r.enqueued ? "enqueued" : r.reason)).sort();
      expect(outcomes).toEqual(["already_scheduled", "enqueued"]);

      const runs = await snapshotRuns(db);
      expect(runs).toHaveLength(1);

      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:00:00.000Z");
    });

    test("O17: manual/scheduled race converges to exactly one executable pending run", async () => {
      // A manual Run Now racing a scheduled tick: the later writer supersedes
      // the earlier pending — never two executable runs, watermark still advances.
      const [manual, scheduled] = await Promise.all([
        coordinator.enqueueExecRun(loopId),
        coordinator.enqueueExecRun(loopId, {
          kind: "scheduled",
          scheduledFor: "2026-08-27T10:00:00.000Z",
          scheduleRevision: 0,
        }),
      ]);

      expect(manual.enqueued || scheduled.enqueued).toBe(true);

      const runs = await snapshotRuns(db);
      expect(runs.filter((r) => r.phase === "pending")).toHaveLength(1);
      expect(runs).toHaveLength(2); // winner pending + loser superseded

      const [loop] = await db.select().from(loops).where(eq(loops.id, loopId));
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:00:00.000Z");
    });
  });
});
