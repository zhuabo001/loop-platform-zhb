/**
 * Day 6–7 cross-package E2E (goal §6.6): the FULL user chain over HTTP — no
 * test-fixture seeding of loops or runs. The BUILT @loopzhb/daemon drives a
 * real booted server (file-backed PGlite via bootstrapServer, Hono
 * app.request adapted into the daemon's injectable fetch — no TCP port):
 *
 *   daemon poll (self-registers the machine) → GET /api/machines →
 *   POST /api/loops → POST /api/loops/:id/run → daemon pollOnce (claim →
 *   Fake Runner → report) → GET observation APIs show done/exec + message.
 *
 * Acceptance: every success response validates against its protocol schema;
 * done/exec is the SERVER's Phase-1 write rule (not the daemon-claimed
 * outcome); the RunLease is consumed; a second poll re-executes nothing.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
import {
  createLoopResponseSchema,
  loopListResponseSchema,
  machineListResponseSchema,
  runListResponseSchema,
  triggerRunResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { runLeases } from "./db/schema.js";
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

describe("daemon E2E: the full HTTP user chain", () => {
  it("register → create → trigger → execute → observe; second poll re-executes nothing", async () => {
    const b = await boot();
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

    // 1. First poll: self-registration only — nothing is pending yet.
    await runtime.pollOnce();
    expect(runnerCalls).toBe(0);

    // 2. The user locates THEIR machine through the observation API (matched
    //    by the token-derived id, not by position).
    const machinesRes = await b.app.request("/api/machines");
    expect(machinesRes.status).toBe(200);
    const machineId = machineIdFromToken(TOKEN);
    const machineList = machineListResponseSchema.parse(await machinesRes.json()).machines;
    expect(machineList.find((m) => m.id === machineId)).toMatchObject({
      name: "e2e-host",
      hostname: "e2e-host",
      platform: "test",
      daemonVersion: "0.1.0",
    });

    // 3. Create the loop over HTTP. The id is the production `loop-<uuid>`
    //    mint — read it off the response, never predicted.
    const createRes = await b.app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId,
        name: "e2e-loop",
        workdir: "/srv/project",
        taskFile: "/srv/project/LOOP.md",
      }),
    });
    expect(createRes.status).toBe(201);
    const { loop } = createLoopResponseSchema.parse(await createRes.json());
    expect(loop).toMatchObject({
      machineId,
      name: "e2e-loop",
      workdir: "/srv/project",
      taskFile: "/srv/project/LOOP.md",
      agent: "claude-code",
      enabled: true,
      lastRun: null,
    });

    // 4. Manual trigger — Phase 1's ONLY run entry point (empty body).
    const triggerRes = await b.app.request(`/api/loops/${loop.id}/run`, { method: "POST" });
    expect(triggerRes.status).toBe(202);
    const trigger = triggerRunResponseSchema.parse(await triggerRes.json());
    if (!trigger.enqueued) throw new Error("expected the trigger to enqueue");
    expect(trigger.supersededRunIds).toEqual([]);

    // 5. The daemon's next poll claims, fake-runs and reports.
    await runtime.pollOnce();
    expect(runnerCalls).toBe(1);
    expect(runtime.pendingCount()).toBe(0);

    // 6. The observation surface shows the terminal result. done/exec is the
    //    SERVER's Phase-1 rule (ok:true ⇒ done/exec) — not the daemon-claimed
    //    outcome, which is never persisted.
    const runsRes = await b.app.request(`/api/loops/${loop.id}/runs`);
    expect(runsRes.status).toBe(200);
    const runList = runListResponseSchema.parse(await runsRes.json()).runs;
    expect(runList).toHaveLength(1);
    expect(runList[0]).toMatchObject({
      id: trigger.runId,
      loopId: loop.id,
      machineId,
      phase: "done",
      outcome: "exec",
      message: "fake runner completed",
      error: null,
      progress: null,
    });
    expect(Number.isInteger(runList[0]!.durationMs)).toBe(true);
    expect(runList[0]!.durationMs!).toBeGreaterThanOrEqual(0);

    const loopsRes = await b.app.request("/api/loops");
    const loopList = loopListResponseSchema.parse(await loopsRes.json()).loops;
    expect(loopList.find((l) => l.id === loop.id)?.lastRun).toMatchObject({
      id: trigger.runId,
      phase: "done",
      outcome: "exec",
    });

    // The RunLease was consumed by the finalize.
    expect(await b.handle.db.select().from(runLeases)).toHaveLength(0);

    // 7. At-most-once: a second poll claims nothing, re-executes nothing.
    await runtime.pollOnce();
    expect(runnerCalls).toBe(1);
  });
});
