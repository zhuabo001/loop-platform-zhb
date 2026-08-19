/**
 * Day 8–10 fault injection (plan Slices A–C): ADR-001's T4/T5/T6 driven over
 * the FULL user chain — HTTP + file-backed PGlite + the REAL @loopzhb/daemon
 * runtime, with time driven by the server-side FakeClock and the runner held
 * behind a test gate (the "sleeping laptop").
 *
 *  - T5: daemon claims → laptop sleeps (runner gated) → clock advances past
 *    the 20min inactivity timeout → the REAL Sweep.runOnce() reclaims → the
 *    run reads as an observable error → the laptop wakes and its late success
 *    report reconciles the run to done/exec (response carries
 *    `reconciled:true`) → the same credential's second report meets the coded
 *    401.
 *  - Delivery-loss convergence (ADR-001's explicit promise): the server
 *    completed the claim but the daemon dropped the response; the machine
 *    keeps polling (heartbeat FRESH) yet the orphaned run is still reclaimed
 *    into an observable error and is NEVER re-dispatched.
 *  - T4/T6 live in this file too (see their describes).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDaemonRuntime,
  createMachineClient,
  type AgentRunner,
  type RunnerReport,
} from "@loopzhb/daemon";
import {
  apiErrorSchema,
  cancelRunResponseSchema,
  createLoopResponseSchema,
  loopListResponseSchema,
  pollResponseSchema,
  RUN_CAPABILITY_INVALID_CODE,
  runListResponseSchema,
  triggerRunResponseSchema,
  type Delivery,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { createLoopAdmin } from "./admin/index.js";
import { createRunCoordinator } from "./coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "./db/index.js";
import { runLeases } from "./db/schema.js";
import { createServerApp } from "./http/app.js";
import { createOwnerControl } from "./owner/index.js";
import { RECLAIM_RUN_ERROR } from "./store/runs.js";
import { createInactivitySweep, type InactivitySweep } from "./sweep/index.js";
import { FakeClock, makeTestFactories } from "./testkit/index.js";

const TOKEN = "dk_fault_machine";
const handles: DbHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

interface FakeBoot {
  app: ReturnType<typeof createServerApp>;
  db: Db;
  handle: DbHandle;
  clock: FakeClock;
  sweep: InactivitySweep;
  sweepLogs: string[];
}

/** The layered black-box composition root: file PGlite + FakeClock + the real
 *  HTTP app — the same graph production boots, with time under test control. */
async function bootFake(dataDir?: string): Promise<FakeBoot> {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), `loopzhb-fault-${process.pid}-`)));
  const handle = await openMigratedDb({ dataDir: dir });
  handles.push(handle);
  const clock = new FakeClock();
  const coordinator = createRunCoordinator({ db: handle.db, clock, ...makeTestFactories() });
  let loopN = 0;
  const admin = createLoopAdmin({ db: handle.db, clock, newLoopId: () => `loop-${++loopN}` });
  const sweepLogs: string[] = [];
  const sweep = createInactivitySweep({ db: handle.db, clock, log: (line) => sweepLogs.push(line) });
  const ownerControl = createOwnerControl({ db: handle.db, clock });
  return { app: createServerApp(coordinator, admin, ownerControl), db: handle.db, handle, clock, sweep, sweepLogs };
}

/** Adapt the Hono app into the daemon's fetch (same seam as daemon-e2e). */
function appFetch(app: FakeBoot["app"]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(url.pathname, init) as Promise<Response>;
  }) as typeof fetch;
}

/** Wrap a fetch to capture every /api/machine/report response body — T5 pins
 *  `reconciled:true` on the ONE reconciling wake-report. */
function recordingReportBodies(fetchImpl: typeof fetch, seen: unknown[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetchImpl(input, init);
    if (String(input).includes("/api/machine/report")) seen.push(await res.clone().json());
    return res;
  }) as typeof fetch;
}

/** The "sleeping laptop" runner: `started` fires when the run begins (the
 *  daemon then holds the run credential); `release` wakes it with a report. */
function createGatedRunner(): {
  runner: AgentRunner;
  started: Promise<Delivery>;
  release(report: RunnerReport): void;
} {
  let releaseFn!: (report: RunnerReport) => void;
  let startedFn!: (delivery: Delivery) => void;
  const gate = new Promise<RunnerReport>((resolve) => {
    releaseFn = resolve;
  });
  const started = new Promise<Delivery>((resolve) => {
    startedFn = resolve;
  });
  return {
    runner: { run: (delivery) => (startedFn(delivery), gate) },
    started,
    release: (report) => releaseFn(report),
  };
}

interface DaemonHarness {
  pollOnce(): Promise<void>;
  /** Deterministic sync point for the background execution pipeline (Phase 2
   *  poll+dispatch contract): resolves once the queue is empty, nothing is
   *  in flight and no pipeline is active — never waits on pendingReports. */
  executionSettled(): Promise<void>;
  pendingCount(): number;
  runnerCalls(): number;
}

function createDaemon(
  app: FakeBoot["app"],
  runner: AgentRunner,
  seenReportBodies?: unknown[],
  fetchOverride?: typeof fetch,
): DaemonHarness {
  let runnerCalls = 0;
  const countingRunner: AgentRunner = {
    run: (delivery, signal) => {
      runnerCalls += 1;
      return runner.run(delivery, signal);
    },
  };
  const baseFetch = fetchOverride ?? appFetch(app);
  const client = createMachineClient({
    baseUrl: "http://fault.local",
    machineCredential: TOKEN,
    fetchImpl: seenReportBodies ? recordingReportBodies(baseFetch, seenReportBodies) : baseFetch,
  });
  const runtime = createDaemonRuntime({
    client,
    runner: countingRunner,
    identity: { host: "fault-host", platform: "test", arch: "test", version: "0.1.0" },
    pollMs: 3000,
    machineCredential: TOKEN,
  });
  return {
    pollOnce: () => runtime.pollOnce(),
    executionSettled: () => runtime.executionSettled(),
    pendingCount: () => runtime.pendingCount(),
    runnerCalls: () => runnerCalls,
  };
}

/** Create a loop on the daemon's machine and manually trigger its exec run. */
async function createLoopAndTrigger(app: FakeBoot["app"]): Promise<{ loopId: string; runId: string }> {
  const createRes = await app.request("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId: machineIdFromToken(TOKEN), name: "fault-loop", workdir: "/srv/project" }),
  });
  expect(createRes.status).toBe(201);
  const { loop } = createLoopResponseSchema.parse(await createRes.json());
  const triggerRes = await app.request(`/api/loops/${loop.id}/run`, { method: "POST" });
  expect(triggerRes.status).toBe(202);
  const trigger = triggerRunResponseSchema.parse(await triggerRes.json());
  if (!trigger.enqueued) throw new Error("expected the trigger to enqueue");
  return { loopId: loop.id, runId: trigger.runId };
}

describe("T5 — the sleeping daemon's late report reconciles the sweep's misjudgment", () => {
  it("claim → sleep past the timeout → sweep reclaims → wake report flips done/exec → second report 401", async () => {
    const b = await bootFake();
    const seenReports: unknown[] = [];
    const gate = createGatedRunner();
    const daemon = createDaemon(b.app, gate.runner, seenReports);

    await daemon.pollOnce(); // register only — nothing pending yet
    const { loopId, runId } = await createLoopAndTrigger(b.app);

    // The daemon claims the run and the "laptop sleeps" inside the runner.
    const claimPromise = daemon.pollOnce();
    const delivery = await gate.started;
    expect(delivery.runId).toBe(runId);

    // 20min+ pass with the daemon asleep; the sweep's ONE pass reclaims.
    b.clock.advance(21 * 60_000);
    const stats = await b.sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 1, failed: 0 });

    // The misjudged failure is OBSERVABLE on the JSON surface.
    const midRes = await b.app.request(`/api/loops/${loopId}/runs`);
    const midRuns = runListResponseSchema.parse(await midRes.json()).runs;
    expect(midRuns[0]).toMatchObject({ id: runId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });

    // The laptop wakes; the daemon reports the REAL success with the original
    // credential and sees the report confirmed. (poll+dispatch: the claiming
    // pollOnce returned long ago — the settle seam joins the pipeline.)
    gate.release({ ok: true, message: "slept through the sweep, finished fine" });
    await claimPromise;
    await daemon.executionSettled();
    expect(daemon.pendingCount()).toBe(0);
    expect(seenReports).toEqual([{ ok: true, reconciled: true }]);

    // The run is flipped to done/exec with the real message and NO error.
    const finalRes = await b.app.request(`/api/loops/${loopId}/runs`);
    const finalRuns = runListResponseSchema.parse(await finalRes.json()).runs;
    expect(finalRuns[0]).toMatchObject({
      id: runId,
      phase: "done",
      outcome: "exec",
      message: "slept through the sweep, finished fine",
      error: null,
    });

    // The consumed credential is dead: a second report meets the coded 401.
    const again = await b.app.request("/api/machine/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${delivery.runToken}` },
      body: JSON.stringify({ ok: true }),
    });
    expect(again.status).toBe(401);
    expect(apiErrorSchema.parse(await again.json()).code).toBe(RUN_CAPABILITY_INVALID_CODE);
  });
});

describe("T6 — a canceled run's late report is intercepted", () => {
  it("claim → owner cancel over HTTP → late success report meets the coded 401 → the daemon clears the pending report", async () => {
    const b = await bootFake();
    const gate = createGatedRunner();
    const daemon = createDaemon(b.app, gate.runner);

    await daemon.pollOnce(); // register
    const { loopId, runId } = await createLoopAndTrigger(b.app);

    // The daemon claims the run; the runner is mid-execution holding the
    // credential.
    const claimPromise = daemon.pollOnce();
    await gate.started;

    // The owner cancels over HTTP: run → canceled, capability revoked in the
    // SAME transaction.
    const cancelRes = await b.app.request(`/api/runs/${runId}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRunResponseSchema.parse(await cancelRes.json())).toEqual({ canceled: true });

    // Snapshot BEFORE the late report — nothing may move afterwards.
    const loopsBefore = loopListResponseSchema.parse(await (await b.app.request("/api/loops")).json());

    // The runner finishes with a SUCCESS and the daemon reports it: the coded
    // 401 is the terminal confirmation — the pending report is cleared, never
    // retried forever.
    gate.release({ ok: true, message: "finished after the cancel" });
    await claimPromise;
    await daemon.executionSettled();
    expect(daemon.pendingCount()).toBe(0);

    // The run stays canceled: no late terminal write reaches the run's
    // outcome/message/error, and the loop snapshot is untouched.
    const runsRes = await b.app.request(`/api/loops/${loopId}/runs`);
    const runs = runListResponseSchema.parse(await runsRes.json()).runs;
    expect(runs[0]).toMatchObject({ id: runId, phase: "canceled", outcome: null, message: null, error: null });
    expect(loopListResponseSchema.parse(await (await b.app.request("/api/loops")).json())).toEqual(loopsBefore);
  });
});

describe("delivery response lost — the orphaned run converges to an observable error, never re-dispatched", () => {
  it("server claimed, client dropped the response, machine keeps polling fresh — sweep still reclaims", async () => {
    const b = await bootFake();
    const gate = createGatedRunner();
    const daemon = createDaemon(b.app, gate.runner);

    await daemon.pollOnce(); // register
    const { loopId, runId } = await createLoopAndTrigger(b.app);

    // A RAW poll completes the claim server-side; the daemon never processes
    // the response (dropped Delivery — the credential is lost with it).
    const rawClaim = await b.app.request("/api/machine/poll", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });
    expect(rawClaim.status).toBe(200);
    expect(pollResponseSchema.parse(await rawClaim.json()).deliveries).toHaveLength(1);

    // The machine keeps polling right up to the sweep — heartbeat FRESH — and
    // the run is NEVER re-delivered (at-most-once: it left the dispatch
    // surface at claim time).
    b.clock.advance(21 * 60_000);
    await daemon.pollOnce();
    expect(daemon.runnerCalls()).toBe(0);

    const stats = await b.sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 1 });
    // The reclaim log records the paradox for operators: the machine looked
    // ALIVE while its run timed out.
    expect(b.sweepLogs.some((l) => l.includes(runId) && l.includes("machineHeartbeat=valid"))).toBe(true);

    const runsRes = await b.app.request(`/api/loops/${loopId}/runs`);
    const runs = runListResponseSchema.parse(await runsRes.json()).runs;
    expect(runs[0]).toMatchObject({ id: runId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });

    // Still no re-dispatch after the reclaim.
    await daemon.pollOnce();
    expect(daemon.runnerCalls()).toBe(0);
  });
});

describe("T4 — a server restart never loses an in-flight run", () => {
  it("claim on server A → close A and its DB → server B on the same dataDir: the lease survives, B's immediate sweep mis-reclaims nothing, the late report finalizes", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-t4-${process.pid}-`));
    const a = await bootFake(dataDir);

    // The daemon's fetch follows the CURRENT server process (same URL, new
    // process after the restart).
    let current: FakeBoot = a;
    const switchableFetch: typeof fetch = (input, init) => appFetch(current.app)(input, init);
    const gate = createGatedRunner();
    const daemon = createDaemon(a.app, gate.runner, undefined, switchableFetch);

    await daemon.pollOnce(); // register against A
    const { loopId, runId } = await createLoopAndTrigger(a.app);

    // A claims the run; the runner is mid-execution holding the credential.
    const claimPromise = daemon.pollOnce();
    const delivery = await gate.started;
    expect(delivery.runId).toBe(runId);

    // The "restart": close server A and its database.
    await closeDb(a.handle);
    handles.splice(handles.indexOf(a.handle), 1);

    // Server B on the SAME dataDir: the persisted lease is intact…
    const b = await bootFake(dataDir);
    current = b;
    const leases = await b.db.select().from(runLeases);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ runId, state: "active", expiresAt: null });

    // …and B's boot-time immediate sweep pass (the same runOnce main() arms)
    // does NOT mis-reclaim the run: it is far below the inactivity timeout.
    const bootSweep = await b.sweep.runOnce();
    expect(bootSweep).toMatchObject({ scanned: 1, reclaimed: 0, failed: 0 });

    // The runner finishes; the daemon reports to server B with the ORIGINAL
    // credential and is confirmed.
    gate.release({ ok: true, message: "across the restart" });
    await claimPromise;
    await daemon.executionSettled();
    expect(daemon.pendingCount()).toBe(0);

    const runsRes = await b.app.request(`/api/loops/${loopId}/runs`);
    const runs = runListResponseSchema.parse(await runsRes.json()).runs;
    expect(runs[0]).toMatchObject({ id: runId, phase: "done", outcome: "exec", message: "across the restart" });

    // The capability was consumed: a repeat report meets the coded 401.
    expect(await b.db.select().from(runLeases)).toHaveLength(0);
    const again = await b.app.request("/api/machine/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${delivery.runToken}` },
      body: JSON.stringify({ ok: true }),
    });
    expect(again.status).toBe(401);
    expect(apiErrorSchema.parse(await again.json()).code).toBe(RUN_CAPABILITY_INVALID_CODE);
  });
});
