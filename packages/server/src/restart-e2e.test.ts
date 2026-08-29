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
import { loops, runLeases } from "./db/schema.js";
import { bootstrapServer, waitForListening, type BootedServer } from "./start.js";
import { FakeClock } from "./testkit/index.js";
import type { Clock } from "./time.js";
import type { CronFactory, CronJob } from "./scheduler/index.js";

const TOKEN = "dk_restart_e2e";
const MACHINE_ID = machineIdFromToken(TOKEN);
/** Every test starts at 09:00Z; activation equals the creation instant. */
const T0 = new Date("2026-08-27T09:00:00.000Z");

const openHandles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/** On-demand Croner fake — jobs never fire by themselves; entries() exposes
 *  the raw callbacks so E10 can prove a post-drain firing touches nothing. */
class FakeCronFactory implements CronFactory {
  private seq = 0;
  private entriesList: { stopped: boolean; callback: () => void | Promise<void> }[] = [];

  create(
    _pattern: string,
    _options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void },
    callback: () => void | Promise<void>,
  ): CronJob {
    const id = `job-${++this.seq}`;
    const entry = { stopped: false, callback, id };
    this.entriesList.push(entry);
    return {
      stop: () => {
        entry.stopped = true;
      },
    };
  }

  entries() {
    return [...this.entriesList];
  }
}

interface RunningServer extends BootedServer {
  server: ServerType;
  baseUrl: string;
  cronFactory: FakeCronFactory;
  clock: Clock;
}

/** One server lifetime — production boot order (listener bound BEFORE the
 *  scheduler starts), fully injectable clock/cron. */
async function boot(dataDir: string, clock: FakeClock): Promise<RunningServer> {
  const cronFactory = new FakeCronFactory();
  const b = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir }, { clock, cronFactory });
  const server = serve({ fetch: b.app.fetch, port: 0, hostname: "127.0.0.1" });
  await waitForListening(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await b.scheduler.start();
  return { ...b, server, baseUrl: `http://127.0.0.1:${port}`, cronFactory, clock };
}

/** Production shutdown order: scheduler drain → listener close → DB close. */
async function shutdown(rs: RunningServer): Promise<void> {
  await rs.scheduler.stopAndDrain();
  await new Promise<void>((resolve) => rs.server.close(() => resolve()));
  openHandles.splice(openHandles.indexOf(rs.handle), 1);
  await closeDb(rs.handle);
}

/** The daemon runtime pointed at the REAL listener (default fetch). */
function makeDaemon(rs: RunningServer, runner?: AgentRunner) {
  const client = createMachineClient({ baseUrl: rs.baseUrl, machineCredential: TOKEN });
  return createDaemonRuntime({
    client,
    runner: runner ?? createFakeRunner(),
    identity: { host: "e2e-host", platform: "test", arch: "test", version: "0.1.0" },
    pollMs: 3000,
    machineCredential: TOKEN,
  });
}

async function createScheduledLoop(rs: RunningServer, cron: string): Promise<string> {
  const res = await fetch(`${rs.baseUrl}/api/loops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId: MACHINE_ID, name: "e2e-loop", cron, timezone: "UTC" }),
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
async function scheduleStateOf(rs: RunningServer, loopId: string) {
  const [row] = await rs.handle.db.select().from(loops).where(eq(loops.id, loopId));
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
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce(); // machine self-registration
    const loopId = await createScheduledLoop(first, "0 10 * * *");
    await shutdown(first);

    const second = await boot(dir, clock);
    openHandles.push(second.handle);

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
    openHandles.push(rs.handle);

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
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    // Downtime crosses ~210 minutely occurrences.
    clock.advance(3.5 * 60 * 60 * 1000); // now 12:30

    const second = await boot(dir, clock);
    openHandles.push(second.handle);

    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending", role: "exec" });
    expect(await scheduleStateOf(second, loopId)).toMatchObject({
      lastScheduledAt: "2026-08-27T12:30:00.000Z",
    });

    await shutdown(second);
  });

  it("E4: a second restart before the daemon claims adds nothing — pending and watermark hold", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);
    openHandles.push(second.handle);
    expect(await listRuns(second, loopId)).toHaveLength(1);
    const stateAfterSecond = await scheduleStateOf(second, loopId);
    await shutdown(second);

    // Third boot, same instant: the occurrence is already covered.
    const third = await boot(dir, clock);
    openHandles.push(third.handle);
    const allRuns = await listRuns(third, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending" });
    expect(await scheduleStateOf(third, loopId)).toEqual(stateAfterSecond);

    await shutdown(third);
  });

  it("E5: the daemon runtime claims the ONE recovered pending — and only that one", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);
    openHandles.push(second.handle);

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
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    await shutdown(first);

    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);
    openHandles.push(second.handle);

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
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");

    // Trigger + claim over real HTTP; the report never arrives (machine
    // "dies" mid-run together with the server).
    await fetch(`${first.baseUrl}/api/loops/${loopId}/run`, { method: "POST" });
    const claimRes = await fetch(`${first.baseUrl}/api/machine/poll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ host: "e2e-host", platform: "test", arch: "test", version: "0.1.0" }),
    });
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as any;
    expect(claimed.deliveries).toHaveLength(1);
    await shutdown(first);

    // Downtime crosses many occurrences; restart.
    clock.advance(3.5 * 60 * 60 * 1000);
    const second = await boot(dir, clock);
    openHandles.push(second.handle);

    // Catch-up saw the running run: watermark advanced, NO new pending.
    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "running" });
    expect((await scheduleStateOf(second, loopId)).lastScheduledAt).toBe("2026-08-27T12:30:00.000Z");

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

  it("E10: after a scheduler drain + HTTP/DB close, leaked firings touch nothing and the next boot recovers cleanly", async () => {
    const dir = await freshDataDir();
    const clock = new FakeClock(T0);

    const first = await boot(dir, clock);
    openHandles.push(first.handle);
    await makeDaemon(first).pollOnce();
    const loopId = await createScheduledLoop(first, "* * * * *");
    const leakedCallbacks = first.cronFactory.entries().map((e) => e.callback);
    expect(leakedCallbacks).toHaveLength(1);
    await shutdown(first);

    // A timer that outlived the drain fires into the stopped guard — against
    // an already-CLOSED database any access would throw.
    clock.advance(2 * 60 * 1000);
    for (const cb of leakedCallbacks) {
      await cb();
    }

    // The next boot over the same dataDir recovers normally.
    const second = await boot(dir, clock);
    openHandles.push(second.handle);
    const allRuns = await listRuns(second, loopId);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ phase: "pending" });
    expect((await scheduleStateOf(second, loopId)).lastScheduledAt).toBe("2026-08-27T09:02:00.000Z");

    await shutdown(second);
  });
});
