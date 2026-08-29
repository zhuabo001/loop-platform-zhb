/**
 * F-group tests: Integration and production wiring.
 *
 * Tests cover:
 *  - F1–F3: HTTP PATCH /schedule route, scheduler reconcile callback
 *  - F4–F6: Bootstrap integration, startup/shutdown ordering
 *  - F7–F10: Multi-tick merge with offline machine, recovery claims the latest
 *    pending only, paused loop keeps manual Run Now, running overlap advances
 *    watermark without queueing
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, runs } from "../db/schema.js";
import { FakeClock, seedMachine, seedMachineForToken, seedLoop, snapshotRuns, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createLoopAdmin, newUuidLoopId } from "../admin/index.js";
import { createOwnerControl } from "../owner/index.js";
import { createScheduler, type Scheduler } from "../scheduler/index.js";
import { createServerApp } from "../http/app.js";

// Fake Croner factory from S-group
class FakeCronFactory {
  public jobs = new Map<string, { callback: () => void | Promise<void>; stopped: boolean }>();
  private idSeq = 0;

  create(
    _pattern: string,
    _options: { timezone: string },
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

  /** Triggers all active jobs and waits for every callback to settle. */
  async triggerAll(): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const entry of this.jobs.values()) {
      if (!entry.stopped) {
        promises.push(Promise.resolve(entry.callback()));
      }
    }
    await Promise.all(promises);
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
  let coordinator: RunCoordinator;
  let machineId: string;

  beforeEach(async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock(new Date("2026-08-27T10:00:00Z"));
    machineId = "m-test123456789a";

    await seedMachine(db, machineId);

    coordinator = createRunCoordinator(testDeps(db, clock));
    const admin = createLoopAdmin({ db, clock, newLoopId: newUuidLoopId });
    const ownerControl = createOwnerControl({ db, clock });
    cronFactory = new FakeCronFactory();

    scheduler = createScheduler({
      db,
      coordinator,
      clock,
      cronFactory: cronFactory as any,
    });

    app = createServerApp(coordinator, admin, ownerControl, db, clock, (loop) => scheduler.reconcile(loop));
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

    test("F14: retrying the same PATCH recovers a committed/read-failed response idempotently (Round 3)", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: null,
        enabled: true,
      });

      const stableAdmin = createLoopAdmin({ db, clock, newLoopId: newUuidLoopId });
      let failSummaryReadOnce = true;
      const failingReadAdmin = {
        ...stableAdmin,
        async getLoopSummary(loopId: string) {
          if (failSummaryReadOnce) {
            failSummaryReadOnce = false;
            throw new Error("injected post-commit summary read failure");
          }
          return stableAdmin.getLoopSummary(loopId);
        },
      };
      const retryableApp = createServerApp(
        coordinator,
        failingReadAdmin,
        createOwnerControl({ db, clock }),
        db,
        clock,
        (loop) => scheduler.reconcile(loop),
      );
      const request = {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: "0 10 * * *", timezone: "UTC" }),
      };
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // The write and reconcile commit before the injected projection read
        // fails. A generic 500 therefore has an explicitly retryable contract.
        const first = await retryableApp.request("/api/loops/loop-1/schedule", request);
        expect(first.status).toBe(500);
        let [row] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
        expect(row).toMatchObject({ cron: "0 10 * * *", scheduleRevision: 1 });
        expect(cronFactory.activeCount()).toBe(1);
        expect(cronFactory.jobs.size).toBe(1);

        // Exact retry is a semantic no-op: it recovers the representation but
        // neither increments revision nor replaces the already-current job.
        const retry = await retryableApp.request("/api/loops/loop-1/schedule", request);
        expect(retry.status).toBe(200);
        expect((await retry.json()) as any).toMatchObject({
          loop: { id: "loop-1", cron: "0 10 * * *", timezone: "UTC" },
        });
        [row] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
        expect(row!.scheduleRevision).toBe(1);
        expect(cronFactory.activeCount()).toBe(1);
        expect(cronFactory.jobs.size).toBe(1);
      } finally {
        errorLog.mockRestore();
      }
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

  describe("Multi-tick, recovery and overlap", () => {
    const TOKEN = "dk_test_machine_alpha";

    test("F7: consecutive ticks with an offline machine merge into ONE latest pending run", async () => {
      // Minutely cron so consecutive ticks are consecutive minutes
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "* * * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
      });

      await scheduler.start();

      // Tick 1 at 10:00:30 → occurrence 10:00 enqueued (machine offline)
      clock.advance(30_000);
      await cronFactory.triggerAll();
      let allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]).toMatchObject({ phase: "pending" });

      // Tick 2 at 10:01:30 → occurrence 10:01 supersedes the still-pending run
      clock.advance(60_000);
      await cronFactory.triggerAll();

      allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(2);
      expect(allRuns[0]).toMatchObject({ phase: "canceled", outcome: "skipped" });
      expect(allRuns[1]).toMatchObject({ phase: "pending" });

      // Watermark sits at the latest occurrence
      const [loop] = await db.select().from(loops);
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:01:00.000Z");
    });

    test("F8: after offline ticks, the recovering machine claims ONLY the latest pending run", async () => {
      const tokenMachineId = await seedMachineForToken(db, TOKEN);
      await seedLoop(db, {
        id: "loop-1",
        machineId: tokenMachineId,
        cron: "* * * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
      });

      await scheduler.start();

      // Batch 3: start()'s catch-up already enqueued the 10:00 occurrence
      // (minutely cron, activation 09:00) — the first of the offline backlog.
      // Three further ticks while the machine is offline
      for (let i = 0; i < 3; i++) {
        clock.advance(60_000);
        await cronFactory.triggerAll();
      }

      // Exactly one pending survives (the latest); earlier ones were superseded
      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(4);
      expect(allRuns.filter((r) => r.phase === "pending")).toHaveLength(1);
      expect(allRuns.filter((r) => r.phase === "canceled" && r.outcome === "skipped")).toHaveLength(3);

      // Recovery: the machine polls and claims exactly the latest pending run
      const pollResult = await coordinator.poll(TOKEN, {
        host: "test-host",
        platform: "darwin",
        arch: "arm64",
        version: "0.0.0-test",
      });
      expect(pollResult.deliveries).toHaveLength(1);
      expect(pollResult.deliveries[0]!.runId).toBe(allRuns[3]!.id);

      // A second poll finds nothing left to claim
      const second = await coordinator.poll(TOKEN, {
        host: "test-host",
        platform: "darwin",
        arch: "arm64",
        version: "0.0.0-test",
      });
      expect(second.deliveries).toHaveLength(0);
    });

    test("F9: a tick during a running execution advances the watermark without queueing", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "* * * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
      });

      await scheduler.start();

      // Tick 1 → pending; a poll claims it → running (simulated directly)
      clock.advance(30_000);
      await cronFactory.triggerAll();
      await db.update(runs).set({ phase: "running" }).where(eq(runs.id, "run-1"));

      // Tick 2 while running → no new pending, but the watermark advances
      clock.advance(60_000);
      await cronFactory.triggerAll();

      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]).toMatchObject({ id: "run-1", phase: "running" });

      const [loop] = await db.select().from(loops);
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:01:00.000Z");
    });

    test("F10: paused loop keeps manual Run Now available", async () => {
      await seedLoop(db, {
        id: "loop-1",
        machineId,
        cron: "0 10 * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
      });

      await scheduler.start();
      expect(cronFactory.activeCount()).toBe(1);

      // Batch 3: the start catch-up enqueued the 10:00 occurrence while the
      // loop was still enabled.
      expect(await snapshotRuns(db)).toHaveLength(1);

      // Pause via HTTP — job removed
      const pauseRes = await app.request("/api/loops/loop-1/schedule", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(pauseRes.status).toBe(200);
      expect(cronFactory.activeCount()).toBe(0);

      // Manual Run Now still enqueues (paused only stops AUTOMATIC scheduling)
      // — and supersedes the catch-up's still-pending run (T7).
      const runRes = await app.request("/api/loops/loop-1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(runRes.status).toBe(202);
      const json = (await runRes.json()) as any;
      expect(json.enqueued).toBe(true);

      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(2);
      expect(allRuns[0]).toMatchObject({ loopId: "loop-1", phase: "canceled", outcome: "skipped" });
      expect(allRuns[1]).toMatchObject({ loopId: "loop-1", phase: "pending" });
    });

    test("F11: a tick racing a poll claim converges to one running run (real interleaving)", async () => {
      const tokenMachineId = await seedMachineForToken(db, TOKEN);
      await seedLoop(db, {
        id: "loop-1",
        machineId: tokenMachineId,
        cron: "* * * * *",
        timezone: "UTC",
        enabled: true,
        scheduleRevision: 0,
        scheduleActivatedAt: "2026-08-27T09:00:00.000Z",
      });

      // Gate the SECOND tick's enqueue inside the coordinator so the claim
      // lands while the tick is mid-flight.
      let release: (() => void) | undefined;
      let gateEnabled = false;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gatedCoordinator = createRunCoordinator(
        testDeps(db, clock, {
          hooks: { beforeEnqueueTx: () => (gateEnabled ? gate : undefined) },
        }),
      );
      const gatedScheduler = createScheduler({
        db,
        coordinator: gatedCoordinator,
        clock,
        cronFactory: cronFactory as any,
      });
      await gatedScheduler.start();

      // Tick 1 → run-1 pending (gate not yet armed)
      clock.advance(30_000);
      await cronFactory.triggerAll();
      expect(await snapshotRuns(db)).toHaveLength(1);

      // Arm the gate, advance to the next minute, fire tick 2 (parks in beforeEnqueueTx)
      gateEnabled = true;
      clock.advance(60_000);
      const tick2 = cronFactory.triggerAll();

      // The machine polls and claims run-1 WHILE tick 2 is parked
      const pollResult = await gatedCoordinator.poll(TOKEN, { host: "test-host" });
      expect(pollResult.deliveries).toHaveLength(1);
      expect(pollResult.deliveries[0]!.runId).toBe("run-1");

      // Release tick 2: the in-transaction re-check sees the running run →
      // watermark advances but NO new pending is queued
      release!();
      await tick2;

      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]).toMatchObject({ id: "run-1", phase: "running" });

      const [loop] = await db.select().from(loops);
      expect(loop.lastScheduledAt).toBe("2026-08-27T10:01:00.000Z");
    });
  });

  describe("Schedule-commit seam (onScheduleCommitted)", () => {
    /** The wire schema pins machineId to m-<16 lowercase hex> — the seeded
     *  default id is deliberately NOT wire-valid, so seam tests use this one. */
    const WIRE_MACHINE_ID = "m-0123456789abcdef";

    test("F12: POST /loops with a schedule hot-registers the job through the seam", async () => {
      await seedMachine(db, WIRE_MACHINE_ID);

      // The app is wired with the seam in beforeEach — creating a scheduled
      // loop must register the Croner job WITHOUT a restart (Round 1 P1).
      const res = await app.request("/api/loops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId: WIRE_MACHINE_ID, cron: "* * * * *", timezone: "UTC" }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.loop.cron).toBe("* * * * *");

      expect(cronFactory.activeCount()).toBe(1);

      // And the registered job actually fires an enqueue on the next tick
      // (advance past the creation minute: occurrences must postdate activation)
      clock.advance(61_000);
      await cronFactory.triggerAll();
      const allRuns = await snapshotRuns(db);
      expect(allRuns).toHaveLength(1);
      expect(allRuns[0]).toMatchObject({ phase: "pending", role: "exec" });
    });

    test("F13: a failing seam never fails the committed create (no 500-but-committed)", async () => {
      await seedMachine(db, WIRE_MACHINE_ID);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const failingApp = createServerApp(
          coordinator,
          createLoopAdmin({ db, clock, newLoopId: newUuidLoopId }),
          createOwnerControl({ db, clock }),
          db,
          clock,
          () => {
            throw new Error("injected reconcile failure");
          },
        );

        const res = await failingApp.request("/api/loops", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ machineId: WIRE_MACHINE_ID, cron: "0 10 * * *", timezone: "UTC" }),
        });

        // The committed create still succeeds — the seam error is classified,
        // never propagated (the loop row IS persisted).
        expect(res.status).toBe(201);
        const allLoops = await db.select().from(loops);
        expect(allLoops).toHaveLength(1);
        expect(allLoops[0]).toMatchObject({ cron: "0 10 * * *" });

        // Fixed classification only — the exception message never reaches logs
        const warnLines = warn.mock.calls.map((c) => String(c[0]));
        expect(warnLines).toContain("[http] schedule_commit_sync_failed");
        expect(warnLines.join("\n")).not.toContain("injected reconcile failure");
      } finally {
        warn.mockRestore();
      }
    });
  });
});
