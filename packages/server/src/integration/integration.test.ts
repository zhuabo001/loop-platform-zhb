/**
 * F-group tests: Integration and production wiring.
 *
 * Tests cover:
 *  - F1–F3: HTTP PATCH /schedule route, scheduler reconcile callback
 *  - F4–F6: Bootstrap integration, startup/shutdown ordering
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops } from "../db/schema.js";
import { FakeClock, seedMachine, seedLoop, testDeps } from "../testkit/index.js";
import { createRunCoordinator } from "../coordinator/index.js";
import { createLoopAdmin, newUuidLoopId } from "../admin/index.js";
import { createOwnerControl } from "../owner/index.js";
import { createScheduler, type Scheduler } from "../scheduler/index.js";
import { createServerApp } from "../http/app.js";

// Fake Croner factory from S-group
class FakeCronFactory {
  public jobs = new Map<string, { callback: () => void | Promise<void>; stopped: boolean }>();
  private idSeq = 0;

  create(
    pattern: string,
    options: { timezone: string },
    callback: () => void | Promise<void>,
  ) {
    const id = `job-${++this.idSeq}`;
    this.jobs.set(id, { callback, stopped: false });
    return {
      stop: () => {
        const entry = this.jobs.get(id);
        if (entry) entry.stopped = true;
      },
    };
  }

  activeCount(): number {
    return Array.from(this.jobs.values()).filter((e) => !e.stopped).length;
  }
}

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

describe("F-group: Integration and production wiring", () => {
  let db: Db;
  let clock: FakeClock;
  let scheduler: Scheduler;
  let cronFactory: FakeCronFactory;
  let app: ReturnType<typeof createServerApp>;
  let machineId: string;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T10:00:00Z"));
    machineId = "m-test123456789a";

    await seedMachine(db, machineId);

    const coordinator = createRunCoordinator(testDeps(db, clock));
    const admin = createLoopAdmin({ db, clock, newLoopId: newUuidLoopId });
    const ownerControl = createOwnerControl({ db, clock });
    cronFactory = new FakeCronFactory();

    scheduler = createScheduler({
      db,
      coordinator,
      clock,
      cronFactory: cronFactory as any,
    });

    app = createServerApp(coordinator, admin, ownerControl, db, clock, scheduler);
  });

  describe("HTTP PATCH /schedule", () => {
    test("F1: PATCH /schedule updates loop and triggers reconcile", async () => {
      // Create loop
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: null,
        enabled: true,
      });

      await scheduler.start();
      expect(cronFactory.activeCount()).toBe(0);

      // Update schedule via HTTP
      const res = await app.request("/api/loops/loop-1/schedule", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cron: "0 10 * * *",
          timezone: "UTC",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.loop.cron).toBe("0 10 * * *");
      expect(json.loop.timezone).toBe("UTC");

      // Scheduler should have registered job
      expect(cronFactory.activeCount()).toBe(1);
    });

    test("F2: PATCH /schedule with invalid cron returns 400", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: null,
        enabled: true,
      });

      const res = await app.request("/api/loops/loop-1/schedule", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cron: "invalid cron",
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toBe("invalid request");
    });

    test("F3: PATCH /schedule for nonexistent loop returns 404", async () => {
      const res = await app.request("/api/loops/loop-nonexistent/schedule", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cron: "0 10 * * *",
        }),
      });

      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.error).toBe("not found");
    });
  });

  describe("Bootstrap and lifecycle", () => {
    test("F4: scheduler.start() scans and registers active loops", async () => {
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
    });

    test("F5: scheduler.stopAndDrain() stops all jobs", async () => {
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

      await scheduler.stopAndDrain();
      expect(cronFactory.activeCount()).toBe(0);
    });

    test("F6: reconcile after pause removes job", async () => {
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

      // Pause via HTTP
      const res = await app.request("/api/loops/loop-1/schedule", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      expect(cronFactory.activeCount()).toBe(0);
    });
  });
});
