/**
 * E-group tests: restart catch-up over a FILE-BACKED PGlite and REAL HTTP
 * (Phase 3 Batch 3 plan §三 E1–E10, §2.4 composition root).
 *
 * Each "server lifetime" is the production wiring: bootstrapServer (injected
 * FakeClock + FakeCronFactory via the internal override seam — ONE clock for
 * coordinator/admin/ownerControl/sweep/scheduler/HTTP) → real 127.0.0.1:0
 * listener → scheduler.start(). A restart closes scheduler → listener → DB
 * and boots again over the SAME data directory.
 *
 * Behavior is driven through REAL HTTP (loop admin, daemon poll/report via
 * the daemon runtime with a Fake Runner — never a real Claude). State that
 * the wire deliberately does not expose (watermark, revision) is asserted
 * READ-ONLY through the test's own DbHandle (plan §2.4, review P2-3).
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
import { createLoopResponseSchema, loopListResponseSchema, machineListResponseSchema, runListResponseSchema } from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { loops, runLeases, runs } from "./db/schema.js";
import { bootstrapServer, waitForListening, type BootedServer } from "./start.js";
import { FakeClock, FakeCronFactory } from "./testkit/index.js";
import type { Clock } from "./time.js";

const TOKEN = "dk_restart_e2e";
const MACHINE_ID = machineIdFromToken(TOKEN);
/** Every test starts at 09:00Z; activation equals the creation instant. */
const T0 = new Date("2026-08-27T09:00:00.000Z");

const runningServers = new Set<RunningServer>();
afterEach(async () => {
  await Promise.all([...runningServers].map((rs) => shutdown(rs).catch(() => {})));
});

interface RunningServer extends BootedServer {
  server: ServerType;
  baseUrl: string;
  cronFactory: FakeCronFactory;
  clock: Clock;
}

async function closeListener(server: ServerType): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Registers a fully listening lifetime before any test assertion can fail. */
async function attachListener(
  booted: BootedServer,
  clock: Clock,
  cronFactory: FakeCronFactory,
): Promise<RunningServer> {
  const server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
  try {
    await waitForListening(server);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const rs = { ...booted, server, baseUrl: `http://127.0.0.1:${port}`, cronFactory, clock };
    runningServers.add(rs);
    return rs;
  } catch (err) {
    await closeListener(server).catch(() => {});
    await booted.scheduler.stopAndDrain().catch(() => {});
    await closeDb(booted.handle).catch(() => {});
    throw err;
  }
}

/** One server lifetime — production boot order (listener bound BEFORE the
 *  scheduler starts), fully injectable clock/cron. */
async function boot(dataDir: string, clock: FakeClock): Promise<RunningServer> {
  const cronFactory = new FakeCronFactory();
  const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir }, { clock, cronFactory });
  const rs = await attachListener(booted, clock, cronFactory);
  try {
    await rs.scheduler.start();
    return rs;
  } catch (err) {
    await shutdown(rs).catch(() => {});
    throw err;
  }
}

/** Production shutdown order: scheduler drain → listener close → DB close. */
async function shutdown(rs: RunningServer): Promise<void> {
  runningServers.delete(rs);
  try {
    await rs.scheduler.stopAndDrain();
  } finally {
    try {
      await closeListener(rs.server);
    } finally {
      await closeDb(rs.handle);
    }
  }
}

/** The daemon runtime pointed at the REAL listener (default fetch). */
function makeDaemon(rs: RunningServer, runner?: AgentRunner) {
  const client = createMachineClient({ baseUrl: rs.baseUrl, machineCredential: TOKEN });
  return createDaemonRuntime({
    client,
    runner: runner ?? createFakeRunner(),
    identity: { host: "e2e-host", platform: "test", arch: "test", version: "0.1.0", capabilities: ["terminal-journal-v1"] },
    pollMs: 3000,
    machineCredential: TOKEN,
  });
}

async function createScheduledLoop(rs: RunningServer, cron: string): Promise<string> {
  const res = await fetch(`${rs.baseUrl}/api/loops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId: MACHINE_ID, name: "e2e-loop", cron, timezone: "UTC", taskFile: "/srv/e2e/TASK.md" }),
  });
  expect(res.status).toBe(201);
  const { loop } = createLoopResponseSchema.parse(await res.json());
  return loop.id;
}

async function listRuns(rs: RunningServer, loopId: string) {
  const res = await fetch(`${rs.baseUrl}/api/loops/${loopId}/runs`);
  expect(res.status).toBe(200);
  return runListResponseSchema.parse(await res.json()).runs;
}

/** Read-only watermark/revision probe — the wire deliberately lacks these
 *  (plan §2.4: no new protocol fields for tests). */
async function scheduleStateOf(handle: DbHandle, loopId: string) {
  const [row] = await handle.db.select().from(loops).where(eq(loops.id, loopId));
  return {
    lastScheduledAt: row?.lastScheduledAt ?? null,
    scheduleRevision: row?.scheduleRevision ?? -1,
  };
}

async function freshDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `loopzhb-restart-e2e-${process.pid}-`));
}

describe("E-group: file-backed DB + real HTTP restart E2E", () => {
  it("E1: machine and scheduled loop config survive close/reopen in file-backed PGlite", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce(); // machine self-registration
    const loopId = await createScheduledLoop(first, "0 10 * * *");
    await shutdown(first);

    const second = await boot(dir, clock);

    const machinesRes = await fetch(`${second.baseUrl}/api/machines`);
    expect(machinesRes.status).toBe(200);
    const machineList = machineListResponseSchema.parse(await machinesRes.json()).machines;
    expect(machineList.find((m) => m.id === MACHINE_ID)).toMatchObject({ name: "e2e-host" });

    const loopsRes = await fetch(`${second.baseUrl}/api/loops`);
    const loopList = loopListResponseSchema.parse(await loopsRes.json()).loops;
    expect(loopList.find((l) => l.id === loopId)).toMatchObject({
      cron: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
    });

    await shutdown(second);
  });

  it("E2: creating a scheduled loop over real HTTP exposes the schedule observation fields", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);
    const rs = await boot(dir, clock);

    await makeDaemon(rs).pollOnce();
    const loopId = await createScheduledLoop(rs, "0 10 * * *");

    const loopsRes = await fetch(`${rs.baseUrl}/api/loops`);
    const loopList = loopListResponseSchema.parse(await loopsRes.json()).loops;
    const summary = loopList.find((l) => l.id === loopId);
    expect(summary).toMatchObject({ cron: "0 10 * * *", timezone: "UTC", enabled: true });
    // The next 10:00 tick from the 09:00 creation instant.
    expect(summary?.nextFireAt).toBe("2026-08-27T10:00:00.000Z");

    await shutdown(rs);
  });

  it("E3: a downtime spanning MANY occurrences recovers only the latest pending", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    // Downtime crosses ~210 minutely occurrences.
    clock.advance(3.5 * 60 * 60 * 1000); // now 12:30

    const second = await boot(dir, clock);

    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending", role: "exec" });
    expect(await scheduleStateOf(second.handle, loopId)).toMatchObject({
      lastScheduledAt: "2026-08-27T12:30:00.000Z",
    });

    await shutdown(second);
  });

  it("E4: a second restart before the daemon claims adds nothing — pending and watermark hold", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);
    expect(await listRuns(second, loopId)).toHaveLength(1);
    const stateAfterSecond = await scheduleStateOf(second.handle, loopId);
    await shutdown(second);

    // Third boot, same instant: the occurrence is already covered.
    const third = await boot(dir, clock);
    const allRuns = await listRuns(third, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending" });
    expect(await scheduleStateOf(third.handle, loopId)).toEqual(stateAfterSecond);

    await shutdown(third);
  });

  it("E5: the daemon runtime claims the ONE recovered pending — and only that one", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);

    let runnerCalls = 0;
    const fake = createFakeRunner();
    const countingRunner: AgentRunner = {
      run: (delivery, ctx) => {
        runnerCalls += 1;
        return fake.run(delivery, ctx);
      },
    };
    const runtime = makeDaemon(second, countingRunner);
    await runtime.pollOnce();

    expect(runnerCalls).toBe(1);
    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "running" });

    await shutdown(second);
  });

  it("E6/E7/E8: the Fake Runner runs once, real-HTTP report finalizes done/exec, the lease is consumed, and a second poll re-executes nothing", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);

    let runnerCalls = 0;
    const fake = createFakeRunner();
    const countingRunner: AgentRunner = {
      run: (delivery, ctx) => {
        runnerCalls += 1;
        return fake.run(delivery, ctx);
      },
    };
    const runtime = makeDaemon(second, countingRunner);
    await runtime.pollOnce();
    await runtime.executionSettled();
    expect(runtime.pendingCount()).toBe(0);
    expect(runnerCalls).toBe(1);

    // E6: done/exec through the real HTTP report path.
    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "done", outcome: "exec", message: "fake runner completed" });

    // E7: the RunLease was consumed by the finalize (read-only probe).
    expect(await second.handle.db.select().from(runLeases)).toHaveLength(0);

    // E8: a second poll delivers nothing, re-executes nothing.
    await runtime.pollOnce();
    expect(runnerCalls).toBe(1);
    expect(await listRuns(second, loopId)).toHaveLength(1);

    await shutdown(second);
  });

  it("E9: a run left running across the restart is NOT redelivered; catch-up only advances the watermark", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");

    // Trigger + claim over real HTTP; the report never arrives (machine
    // "dies" mid-run together with the server).
    await fetch(`${first.baseUrl}/api/loops/${loopId}/run`, { method: "POST" });
    const claimRes = await fetch(`${first.baseUrl}/api/machine/poll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ host: "e2e-host", platform: "test", arch: "test", version: "0.1.0", capabilities: ["terminal-journal-v1"] }),
    });
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as any;
    expect(claimed.deliveries).toHaveLength(1);
    await shutdown(first);

    // Downtime crosses many occurrences; restart.
    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);

    // Catch-up saw the running run: watermark advanced, NO new pending.
    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "running" });
    expect((await scheduleStateOf(second.handle, loopId)).lastScheduledAt).toBe("2026-08-27T12:30:00.000Z");

    // The daemon's poll redelivers nothing.
    let runnerCalls = 0;
    const countingRunner: AgentRunner = {
      run: () => {
        runnerCalls += 1;
        return Promise.resolve({ ok: true, outcome: "exec", message: "x", durationMs: 0 });
      },
    };
    const runtime = makeDaemon(second, countingRunner);
    await runtime.pollOnce();
    expect(runnerCalls).toBe(0);

    await shutdown(second);
  });

  it("E10: stopAndDrain waits for an in-flight catch-up before the DB closes; leaked firings afterwards touch nothing", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    // Restart at 09:02: the catch-up for the 09:02 occurrence (the cutoff
    // instant is itself a minutely tick) is parked at the enqueue gate
    // (in-flight), and stopAndDrain() MUST wait for it — the DB may only
    // close after the write settles (plan §2.1 step 6, review P2-1,
    // Issue #29).
    clock.advance(2 * 60 * 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const catchupParked = new Promise<void>((r) => {
      entered = r;
    });
    let gateUsed = false;
    const secondCronFactory = new FakeCronFactory();
    const booted = await bootstrapServer(
      { host: "127.0.0.1", port: 0, dataDir: dir },
      {
        clock,
        cronFactory: secondCronFactory,
        coordinatorHooks: {
          beforeEnqueueTx: () => {
            if (gateUsed) return undefined;
            gateUsed = true;
            entered();
            return gate;
          },
        },
      },
    );
    const second = await attachListener(booted, clock, secondCronFactory);
    const startPromise = second.scheduler.start();

    await catchupParked; // the catch-up enqueue is REALLY in flight
    let drained = false;
    const drainPromise = second.scheduler.stopAndDrain().then(() => {
      drained = true;
    });
    // The gate is still held, so a broken drain that resolves immediately
    // would flip this sentinel during the next macrotask. Waiting a turn is
    // essential: Promise.race(..., Promise.resolve("waiting")) would pass
    // even for that broken implementation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await startPromise;
    await drainPromise;
    expect(drained).toBe(true);

    // The drained catch-up write LANDED before any close: one pending run,
    // watermark at the 09:02 occurrence (read-only probes on the open handle).
    const landed = await second.handle.db.select().from(runs);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ phase: "pending" });
    expect(await scheduleStateOf(second.handle, loopId)).toMatchObject({
      lastScheduledAt: "2026-08-27T09:02:00.000Z",
    });

    // Production close order after the drain: listener, then DB.
    const leakedCallbacks = secondCronFactory.entries().map((e) => e.callback);
    await shutdown(second);

    // A timer that outlived the drain fires into the stopped guard — against
    // an already-CLOSED database any access would throw.
    clock.advance(60 * 1000);
    for (const cb of leakedCallbacks) {
      await cb();
    }

    // The next boot over the same dataDir recovers normally: the 09:03
    // occurrence supersedes the drained 09:02 pending — still at most one.
    const third = await boot(dir, clock);
    const allRuns = await listRuns(third, loopId);
    expect(allRuns).toHaveLength(2);
    expect(allRuns.filter((r) => r.phase === "pending")).toHaveLength(1);
    expect((await scheduleStateOf(third.handle, loopId)).lastScheduledAt).toBe("2026-08-27T09:03:00.000Z");

    await shutdown(third);
  });
});
