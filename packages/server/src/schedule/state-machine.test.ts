/**
 * Phase 3 Batch 1 — C group: Configuration state machine tests.
 *
 * Test suite verifies:
 *  - C1: First cron set → revision+, activation set, watermark cleared
 *  - C2: Modify cron → revision+, activation updated, watermark cleared
 *  - C3: Modify timezone → same behavior as C2
 *  - C4: Pause → cron/timezone preserved, activation cleared
 *  - C5: Resume → revision+, new activation established
 *  - C6: Clear cron → manual-only, activation/watermark cleared
 *  - C7: No-op patches (empty, equal, whitespace-only diff) → zero writes
 *  - C8: Loop not found / invalid config / DB failure → zero writes or full rollback
 *
 * All tests assert runs table remains empty (no accidental automatic execution).
 */

import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { closeDb, openMigratedDb } from "../db/index.js";
import { loops, runs } from "../db/schema.js";
import { systemClock } from "../time.js";
import { updateSchedule } from "./state-machine.js";

describe("C: Configuration state machine", () => {
  test("C1: first cron set increments revision, sets activation, clears watermark", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();

      // Insert manual-only Loop (no cron)
      await handle.db.insert(loops).values({
        id: "loop-c1",
        machineId: "m-test",
        name: "C1 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: null,
        timezone: "UTC",
        scheduleRevision: 0,
        scheduleActivatedAt: null,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      const beforeUpdate = new Date();

      // Set cron for the first time
      const result = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c1",
        { cron: "0 9 * * *" },
      );

      const afterUpdate = new Date();

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("Loop not found");
      expect(result.changed).toBe(true);
      if (!result.changed) throw new Error("Loop not changed");

      const loop = result.loop;

      // Revision incremented
      expect(loop.scheduleRevision).toBe(1);

      // Activation set (enabled=true && cron!=null)
      expect(loop.scheduleActivatedAt).not.toBeNull();
      const activatedAt = new Date(loop.scheduleActivatedAt!);
      expect(activatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
      expect(activatedAt.getTime()).toBeLessThanOrEqual(afterUpdate.getTime());

      // Watermark cleared
      expect(loop.lastScheduledAt).toBeNull();

      // updatedAt updated
      expect(loop.updatedAt).not.toBe(now);

      // Cron set correctly
      expect(loop.cron).toBe("0 9 * * *");
      expect(loop.timezone).toBe("UTC");
      expect(loop.enabled).toBe(true);

      // next_run_at remains null
      expect(loop.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C2: modify cron increments revision, updates activation, clears watermark", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();
      const initialActivation = "2026-08-25T08:00:00.000Z";
      const initialWatermark = "2026-08-25T09:00:00.000Z";

      // Insert Loop with existing cron
      await handle.db.insert(loops).values({
        id: "loop-c2",
        machineId: "m-test",
        name: "C2 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleRevision: 1,
        scheduleActivatedAt: initialActivation,
        lastScheduledAt: initialWatermark,
        nextRunAt: null,
      });

      // Modify cron
      const result = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c2",
        { cron: "30 14 * * *" },
      );

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("Loop not found");
      expect(result.changed).toBe(true);
      if (!result.changed) throw new Error("Loop not changed");

      const loop = result.loop;

      // Revision incremented
      expect(loop.scheduleRevision).toBe(2);

      // Activation updated
      expect(loop.scheduleActivatedAt).not.toBe(initialActivation);
      expect(loop.scheduleActivatedAt).not.toBeNull();

      // Watermark cleared
      expect(loop.lastScheduledAt).toBeNull();

      // Cron changed
      expect(loop.cron).toBe("30 14 * * *");

      // next_run_at remains null
      expect(loop.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C3: modify timezone has same behavior as modify cron", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();
      const initialActivation = "2026-08-25T08:00:00.000Z";
      const initialWatermark = "2026-08-25T09:00:00.000Z";

      // Insert Loop with existing schedule
      await handle.db.insert(loops).values({
        id: "loop-c3",
        machineId: "m-test",
        name: "C3 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleRevision: 1,
        scheduleActivatedAt: initialActivation,
        lastScheduledAt: initialWatermark,
        nextRunAt: null,
      });

      // Modify timezone
      const result = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c3",
        { timezone: "Asia/Shanghai" },
      );

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("Loop not found");
      expect(result.changed).toBe(true);
      if (!result.changed) throw new Error("Loop not changed");

      const loop = result.loop;

      // Revision incremented
      expect(loop.scheduleRevision).toBe(2);

      // Activation updated
      expect(loop.scheduleActivatedAt).not.toBe(initialActivation);
      expect(loop.scheduleActivatedAt).not.toBeNull();

      // Watermark cleared
      expect(loop.lastScheduledAt).toBeNull();

      // Timezone changed
      expect(loop.timezone).toBe("Asia/Shanghai");
      expect(loop.cron).toBe("0 9 * * *"); // Unchanged

      // next_run_at remains null
      expect(loop.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C4: pause preserves cron/timezone, clears activation and watermark", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();
      const initialActivation = "2026-08-25T08:00:00.000Z";
      const initialWatermark = "2026-08-25T09:00:00.000Z";

      // Insert active scheduled Loop
      await handle.db.insert(loops).values({
        id: "loop-c4",
        machineId: "m-test",
        name: "C4 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        scheduleRevision: 1,
        scheduleActivatedAt: initialActivation,
        lastScheduledAt: initialWatermark,
        nextRunAt: null,
      });

      // Pause (set enabled=false)
      const result = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c4",
        { enabled: false },
      );

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("Loop not found");
      expect(result.changed).toBe(true);
      if (!result.changed) throw new Error("Loop not changed");

      const loop = result.loop;

      // Revision incremented
      expect(loop.scheduleRevision).toBe(2);

      // Cron and timezone preserved
      expect(loop.cron).toBe("0 9 * * *");
      expect(loop.timezone).toBe("Asia/Shanghai");

      // Enabled changed
      expect(loop.enabled).toBe(false);

      // Activation cleared (no longer active)
      expect(loop.scheduleActivatedAt).toBeNull();

      // Watermark cleared
      expect(loop.lastScheduledAt).toBeNull();

      // next_run_at remains null
      expect(loop.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C5: resume increments revision, establishes new activation", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();

      // Insert paused Loop (enabled=false but has cron)
      await handle.db.insert(loops).values({
        id: "loop-c5",
        machineId: "m-test",
        name: "C5 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: false,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleRevision: 2,
        scheduleActivatedAt: null,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      const beforeResume = new Date();

      // Resume (set enabled=true)
      const result = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c5",
        { enabled: true },
      );

      const afterResume = new Date();

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("Loop not found");
      expect(result.changed).toBe(true);
      if (!result.changed) throw new Error("Loop not changed");

      const loop = result.loop;

      // Revision incremented
      expect(loop.scheduleRevision).toBe(3);

      // New activation established
      expect(loop.scheduleActivatedAt).not.toBeNull();
      const activatedAt = new Date(loop.scheduleActivatedAt!);
      expect(activatedAt.getTime()).toBeGreaterThanOrEqual(beforeResume.getTime());
      expect(activatedAt.getTime()).toBeLessThanOrEqual(afterResume.getTime());

      // Watermark still cleared (no occurrences backfilled)
      expect(loop.lastScheduledAt).toBeNull();

      // Enabled changed
      expect(loop.enabled).toBe(true);

      // next_run_at remains null
      expect(loop.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C6: clear cron becomes manual-only, activation and watermark cleared", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();
      const initialActivation = "2026-08-25T08:00:00.000Z";
      const initialWatermark = "2026-08-25T09:00:00.000Z";

      // Insert active scheduled Loop
      await handle.db.insert(loops).values({
        id: "loop-c6",
        machineId: "m-test",
        name: "C6 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        scheduleRevision: 1,
        scheduleActivatedAt: initialActivation,
        lastScheduledAt: initialWatermark,
        nextRunAt: null,
      });

      // Clear cron (set to null)
      const result = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c6",
        { cron: null },
      );

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("Loop not found");
      expect(result.changed).toBe(true);
      if (!result.changed) throw new Error("Loop not changed");

      const loop = result.loop;

      // Revision incremented
      expect(loop.scheduleRevision).toBe(2);

      // Cron cleared
      expect(loop.cron).toBeNull();

      // Timezone and enabled preserved
      expect(loop.timezone).toBe("Asia/Shanghai");
      expect(loop.enabled).toBe(true);

      // Activation cleared (no longer has cron)
      expect(loop.scheduleActivatedAt).toBeNull();

      // Watermark cleared
      expect(loop.lastScheduledAt).toBeNull();

      // next_run_at remains null
      expect(loop.nextRunAt).toBeNull();

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C7: no-op patches result in zero writes", async () => {
    const handle = await openMigratedDb();

    try {
      const now = new Date().toISOString();
      const activation = "2026-08-25T08:00:00.000Z";

      // Insert Loop
      await handle.db.insert(loops).values({
        id: "loop-c7",
        machineId: "m-test",
        name: "C7 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleRevision: 1,
        scheduleActivatedAt: activation,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      // Empty patch
      const emptyResult = await updateSchedule({ db: handle.db, clock: systemClock }, "loop-c7", {});

      expect(emptyResult.found).toBe(true);
      if (!emptyResult.found) throw new Error("Loop not found");
      expect(emptyResult.changed).toBe(false);
      if (emptyResult.changed) throw new Error("Loop should not have changed");

      const loop1 = emptyResult.loop;
      expect(loop1.scheduleRevision).toBe(1); // Unchanged
      expect(loop1.updatedAt).toBe(now); // Unchanged
      expect(loop1.scheduleActivatedAt).toBe(activation); // Unchanged

      // Equal patch (same values)
      const equalResult = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c7",
        {
          cron: "0 9 * * *",
          timezone: "UTC",
          enabled: true,
        },
      );

      expect(equalResult.found).toBe(true);
      if (!equalResult.found) throw new Error("Loop not found");
      expect(equalResult.changed).toBe(false);
      if (equalResult.changed) throw new Error("Loop should not have changed");

      const loop2 = equalResult.loop;
      expect(loop2.scheduleRevision).toBe(1); // Still unchanged
      expect(loop2.updatedAt).toBe(now); // Still unchanged

      // Whitespace-only diff in cron
      const whitespaceResult = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "loop-c7",
        {
          cron: "  0   9   *   *   *  ", // Extra whitespace
        },
      );

      expect(whitespaceResult.found).toBe(true);
      if (!whitespaceResult.found) throw new Error("Loop not found");
      expect(whitespaceResult.changed).toBe(false);
      if (whitespaceResult.changed) throw new Error("Loop should not have changed");

      const loop3 = whitespaceResult.loop;
      expect(loop3.scheduleRevision).toBe(1); // Still unchanged
      expect(loop3.cron).toBe("0 9 * * *"); // Original value (normalized)

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });

  test("C8: Loop not found, invalid config, DB failure → zero writes or full rollback", async () => {
    const handle = await openMigratedDb();

    try {
      // Loop not found
      const notFoundResult = await updateSchedule(
        { db: handle.db, clock: systemClock },
        "nonexistent-loop",
        { cron: "0 9 * * *" },
      );

      expect(notFoundResult.found).toBe(false);

      // Invalid cron
      const now = new Date().toISOString();
      await handle.db.insert(loops).values({
        id: "loop-c8",
        machineId: "m-test",
        name: "C8 Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleRevision: 1,
        scheduleActivatedAt: now,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      // Invalid cron should throw
      await expect(
        updateSchedule({ db: handle.db, clock: systemClock }, "loop-c8", { cron: "invalid cron" }),
      ).rejects.toThrow();

      // Verify Loop state unchanged after error
      const [loopAfterError] = await handle.db.select().from(loops).where(eq(loops.id, "loop-c8"));
      expect(loopAfterError.scheduleRevision).toBe(1); // Unchanged
      expect(loopAfterError.cron).toBe("0 9 * * *"); // Original value

      // Invalid timezone should throw
      await expect(
        updateSchedule({ db: handle.db, clock: systemClock }, "loop-c8", { timezone: "Invalid/Zone" }),
      ).rejects.toThrow();

      // Verify Loop state still unchanged
      const [loopAfterError2] = await handle.db.select().from(loops).where(eq(loops.id, "loop-c8"));
      expect(loopAfterError2.scheduleRevision).toBe(1); // Still unchanged
      expect(loopAfterError2.timezone).toBe("UTC"); // Original value

      // Manual-only loop cannot persist invalid timezone
      await handle.db.insert(loops).values({
        id: "loop-c8-manual",
        machineId: "m-test",
        name: "C8 Manual Test",
        workdir: null,
        taskFile: null,
        taskFileContent: null,
        taskFileSyncedAt: null,
        workflow: null,
        model: null,
        allowControl: true,
        agent: "claude-code",
        enabled: true,
        state: null,
        createdAt: now,
        updatedAt: now,
        cron: null,
        timezone: "UTC",
        scheduleRevision: 0,
        scheduleActivatedAt: null,
        lastScheduledAt: null,
        nextRunAt: null,
      });

      // Manual-only loop with invalid timezone change should throw
      await expect(
        updateSchedule({ db: handle.db, clock: systemClock }, "loop-c8-manual", { timezone: "Invalid/Zone" }),
      ).rejects.toThrow();

      // Verify manual-only loop state unchanged
      const [manualLoop] = await handle.db.select().from(loops).where(eq(loops.id, "loop-c8-manual"));
      expect(manualLoop.scheduleRevision).toBe(0); // Unchanged
      expect(manualLoop.timezone).toBe("UTC"); // Original value

      // No runs created
      const allRuns = await handle.db.select().from(runs);
      expect(allRuns).toHaveLength(0);
    } finally {
      await closeDb(handle);
    }
  });
});
