/**
 * Day-5 cross-package E2E (plan §4/§5): the BUILT @loopzhb/daemon drives a
 * real booted server (in-memory PGlite via bootstrapServer, Hono app.request
 * adapted into the daemon's injectable fetch — no TCP port). The pending Run
 * is seeded through the coordinator (enqueueExecRun) — NOT through the
 * manual-trigger HTTP that doesn't exist yet.
 *
 * The assertions are the goal doc's single-cycle acceptance: after ONE
 * pollOnce the Run is `done/exec` (the server's Phase-1 write rule — NOT the
 * daemon's claimed outcome), message is the Fake Runner's line, progress is
 * cleared, the RunLease is consumed; a second poll never re-executes.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { loops, runLeases, runs } from "./db/schema.js";
import { bootstrapServer, type BootedServer } from "./start.js";

const TOKEN = "dk_e2e_machine";
const handles: DbHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

async function boot(): Promise<BootedServer> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-e2e-${process.pid}-`));
  const b = await bootstrapServer({ host: "127.0.0.1", port: 3000, dataDir });
  handles.push(b.handle);
  return b;
}

/** Adapt the Hono app into the daemon's fetch: strip the origin, keep
 *  method/headers/body/signal. */
function appFetch(app: BootedServer["app"]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(url.pathname, init) as Promise<Response>;
  }) as typeof fetch;
}

describe("daemon E2E: pending → running → done/exec", () => {
  it("one pollOnce claims, fake-runs and finalizes; a second poll is a no-op", async () => {
    const b = await boot();
    // Seed via store/coordinator, not HTTP: the loop row binds the machine the
    // token self-registers as; enqueue creates the pending Exec Run.
    await b.handle.db.insert(loops).values({
      id: "loop-1",
      machineId: machineIdFromToken(TOKEN),
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await b.coordinator.enqueueExecRun("loop-1")).toMatchObject({ enqueued: true });

    const client = createMachineClient({
      baseUrl: "http://e2e.local",
      machineCredential: TOKEN,
      fetchImpl: appFetch(b.app),
    });
    let runnerCalls = 0;
    const fake = createFakeRunner();
    const countingRunner: AgentRunner = {
      run: (delivery, signal) => {
        runnerCalls += 1;
        return fake.run(delivery, signal);
      },
    };
    const runtime = createDaemonRuntime({
      client,
      runner: countingRunner,
      identity: { host: "e2e-host", platform: "test", arch: "test", version: "0.1.0" },
      pollMs: 3000,
      machineCredential: TOKEN,
    });

    // ONE cycle: the daemon's first poll also self-registers the machine.
    await runtime.pollOnce();

    expect(runnerCalls).toBe(1);
    const runRows = await b.handle.db.select().from(runs).where(eq(runs.loopId, "loop-1"));
    expect(runRows).toHaveLength(1);
    // done/exec comes from the SERVER's Phase-1 rule (ok:true → done/exec),
    // not from the daemon-claimed outcome, which is never persisted.
    expect(runRows[0]).toMatchObject({
      phase: "done",
      outcome: "exec",
      message: "fake runner completed",
      progress: null,
    });
    expect(await b.handle.db.select().from(runLeases)).toHaveLength(0);
    expect(runtime.pendingCount()).toBe(0);

    // Second poll: nothing to claim, nothing re-executes.
    await runtime.pollOnce();
    expect(runnerCalls).toBe(1);
  });
});
