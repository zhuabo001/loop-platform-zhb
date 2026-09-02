/**
 * A-group tests: schedule API surface (create, update, summary).
 *
 * Tests cover:
 *  - A1–A3: CreateLoop with schedule fields
 *  - A4–A7: PATCH /schedule operations
 *  - A8–A12: Input validation, no-op detection, 404, summary fields
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CreateLoopRequest, UpdateScheduleRequest } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { FakeClock, seedMachine } from "../testkit/index.js";
import { createLoopAdmin, newUuidLoopId, type LoopAdmin } from "./index.js";
import { updateSchedule } from "../schedule/index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

describe("A-group: schedule API surface", () => {
  let db: Db;
  let clock: FakeClock;
  let admin: LoopAdmin;
  let machineId: string;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T10:00:00Z"));

    // Register a test machine
    machineId = "m-0123456789abcdef";
    await seedMachine(db, machineId);

    admin = createLoopAdmin({ db, clock, newLoopId: newUuidLoopId });
  });

  describe("CreateLoop with schedule", () => {
    test("A1: creates manual-only loop by default", async () => {
      const req: CreateLoopRequest = {
        machineId,
        taskFile: "/srv/TASK.md",
        name: "manual-loop",
      };

      const result = await admin.createLoop(req);

      expect(result.created).toBe(true);
      if (!result.created) return;

      const loop = result.loop;
      expect(loop.name).toBe("manual-loop");
      expect(loop.cron).toBe(null);
      expect(loop.timezone).toBe("UTC");
      expect(loop.nextFireAt).toBe(null);
    });

    test("A2: creates scheduled loop with cron", async () => {
      const req: CreateLoopRequest = {
        machineId,
        taskFile: "/srv/TASK.md",
        name: "scheduled-loop",
        cron: "0 9 * * 1-5",
      };

      const result = await admin.createLoop(req);

      expect(result.created).toBe(true);
      if (!result.created) return;

      const loop = result.loop;
      expect(loop.name).toBe("scheduled-loop");
      expect(loop.cron).toBe("0 9 * * 1-5");
      expect(loop.timezone).toBe("UTC");
      expect(loop.nextFireAt).toBeTruthy();
    });

    test("A3: creates scheduled loop with custom timezone", async () => {
      const req: CreateLoopRequest = {
        machineId,
        taskFile: "/srv/TASK.md",
        name: "tz-loop",
        cron: "30 14 * * *",
        timezone: "Asia/Shanghai",
      };

      const result = await admin.createLoop(req);

      expect(result.created).toBe(true);
      if (!result.created) return;

      const loop = result.loop;
      expect(loop.cron).toBe("30 14 * * *");
      expect(loop.timezone).toBe("Asia/Shanghai");
      expect(loop.nextFireAt).toBeTruthy();
    });
  });

  describe("updateSchedule", () => {
    let loopId: string;

    beforeEach(async () => {
      const result = await admin.createLoop({
        machineId,
        taskFile: "/srv/TASK.md",
        name: "test-loop",
      });
      if (!result.created) throw new Error("Failed to create loop");
      loopId = result.loop.id;
    });

    test("A4: sets cron on manual-only loop", async () => {
      const patch: UpdateScheduleRequest = {
        cron: "0 10 * * *",
      };

      const result = await updateSchedule({ db, clock }, loopId, patch);

      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.changed).toBe(true);
      if (!result.changed) return;

      const loop = result.loop;
      expect(loop.cron).toBe("0 10 * * *");
      expect(loop.timezone).toBe("UTC");
      expect(loop.scheduleRevision).toBe(1);
    });

    test("A5: modifies existing cron", async () => {
      // First set a cron
      await updateSchedule({ db, clock }, loopId, { cron: "0 10 * * *" });

      // Then modify it
      const result = await updateSchedule({ db, clock }, loopId, { cron: "0 14 * * *" });

      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.changed).toBe(true);
      if (!result.changed) return;

      expect(result.loop.cron).toBe("0 14 * * *");
      expect(result.loop.scheduleRevision).toBe(2);
    });

    test("A6: pauses scheduled loop", async () => {
      // First create scheduled loop
      await updateSchedule({ db, clock }, loopId, { cron: "0 10 * * *" });

      // Then pause
      const result = await updateSchedule({ db, clock }, loopId, { enabled: false });

      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.changed).toBe(true);
      if (!result.changed) return;

      expect(result.loop.enabled).toBe(false);
      expect(result.loop.cron).toBe("0 10 * * *"); // cron preserved
      expect(result.loop.scheduleActivatedAt).toBeNull(); // activation cleared
    });

    test("A7: resumes paused loop", async () => {
      // Set up and pause
      await updateSchedule({ db, clock }, loopId, { cron: "0 10 * * *" });
      await updateSchedule({ db, clock }, loopId, { enabled: false });

      clock.advance(3600_000); // Advance 1 hour

      // Resume
      const result = await updateSchedule({ db, clock }, loopId, { enabled: true });

      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.changed).toBe(true);
      if (!result.changed) return;

      expect(result.loop.enabled).toBe(true);
      expect(result.loop.scheduleActivatedAt).toBe("2026-08-27T11:00:00.000Z");
      expect(result.loop.lastScheduledAt).toBeNull(); // watermark cleared
    });

    test("A8: clears cron to manual-only", async () => {
      // First set a cron
      await updateSchedule({ db, clock }, loopId, { cron: "0 10 * * *" });

      // Then clear it
      const result = await updateSchedule({ db, clock }, loopId, { cron: null });

      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.changed).toBe(true);
      if (!result.changed) return;

      expect(result.loop.cron).toBeNull();
      expect(result.loop.scheduleActivatedAt).toBeNull();
    });

    test("A9: rejects invalid cron", async () => {
      await expect(
        updateSchedule({ db, clock }, loopId, { cron: "invalid" })
      ).rejects.toThrow();
    });

    test("A10: rejects invalid timezone", async () => {
      await expect(
        updateSchedule({ db, clock }, loopId, { cron: "0 10 * * *", timezone: "Invalid/Zone" })
      ).rejects.toThrow();
    });

    test("A11: detects no-op (empty patch)", async () => {
      const result = await updateSchedule({ db, clock }, loopId, {});

      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.changed).toBe(false);
    });

    test("A12: returns not found for missing loop", async () => {
      const result = await updateSchedule({ db, clock }, "loop-nonexistent", { cron: "0 10 * * *" });

      expect(result.found).toBe(false);
    });
  });
});
