/**
 * Phase 4 Batch 2 concurrency & fault-injection matrix (plan §4.1 并发):
 * every pairing is driven over the FULL user chain — file-backed PGlite +
 * the REAL HTTP app + the REAL @loopzhb/daemon runtime with the runner held
 * behind a test gate, and time under the server-side FakeClock. Each case
 * pins ADR-009 修订 2026-09-01's race verdicts: no partial writes, no double
 * completion, no old-generation penetration.
 *
 *  C1 goal/report        claim mints goalRevision 0 → PATCH goal (rev 1)
 *                        mid-run → the finish report is `stale_goal`: stable
 *                        run failure, Loop zero writes, lease consumed.
 *  C2 task-file/claim    a retarget PATCH lands between enqueue and claim:
 *                        the pending run does not block, the sync snapshot is
 *                        cleared, and the claim transaction's authoritative
 *                        snapshot delivers the NEW path.
 *  C3 finish/report      two daemon runtimes share ONE credential: run 2's
 *                        finish completes the Loop while run 1 sleeps
 *                        reclaimed; its late wake-report finalizes the run
 *                        but freezes every Loop field (v1_late_success).
 *  C4 finish/sweep       the sweep reclaims mid-run; the wake-report is a
 *                        FINISH: the same v1 branch runs, `reconciled:true`,
 *                        and the Loop completes exactly once.
 *  C5 reopen/late-report reopen revokes the old generation (EVERY lease
 *                        deleted, terminal-grace included); the late report
 *                        of the revoked generation meets the coded 401 and
 *                        nothing moves.
 *  C6 duplicate delivery the daemon's exact report bytes replayed after a
 *                        committed success: coded 401, zero extra writes.
 *  C7 double report      two DIFFERENT terminals on one lease (report, then
 *                        finish): the second meets the coded 401 — no double
 *                        completion.
 *
 * cancel/report is pinned by T6 in fault-injection.test.ts (v1 body).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDaemonRuntime,
  createMachineClient,
  type AgentRunner,
  type RunnerReport,
} from "@loopzhb/daemon";
import {
  apiErrorSchema,
  createLoopResponseSchema,
  loopListResponseSchema,
  reopenLoopResponseSchema,
  RUN_CAPABILITY_INVALID_CODE,
  runListResponseSchema,
  triggerRunResponseSchema,
  type Delivery,
  type JsonObject,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { createLoopAdmin } from "./admin/index.js";
import { createRunCoordinator } from "./coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "./db/index.js";
import { loops, runLeases, type Loop } from "./db/schema.js";
import { createServerApp } from "./http/app.js";
import { createLifecycleAdmin, type LifecycleOpsHooks } from "./loop-lifecycle/admin.js";
import { createOwnerControl } from "./owner/index.js";
import { createScheduleAdmin } from "./schedule/index.js";
import { RECLAIM_RUN_ERROR } from "./store/runs.js";
import { createInactivitySweep, type InactivitySweep } from "./sweep/index.js";
import { FakeClock, makeTestFactories } from "./testkit/index.js";

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
}

/** The same layered black-box composition root as fault-injection: file
 *  PGlite + FakeClock + the real HTTP app, time under test control. The
 *  optional lifecycle hooks ride the LifecycleAdmin (review SPEC-1: C8
 *  commits a real claim inside the retarget's resolve/write window). */
async function bootFake(options: { lifecycleHooks?: LifecycleOpsHooks } = {}): Promise<FakeBoot> {
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-conc-${process.pid}-`));
  const handle = await openMigratedDb({ dataDir: dir });
  handles.push(handle);
  const clock = new FakeClock();
  const coordinator = createRunCoordinator({ db: handle.db, clock, ...makeTestFactories() });
  let loopN = 0;
  const admin = createLoopAdmin({ db: handle.db, clock, newLoopId: () => `loop-${++loopN}` });
  const sweep = createInactivitySweep({ db: handle.db, clock, log: () => {} });
  const ownerControl = createOwnerControl({ db: handle.db, clock });
  const lifecycle = createLifecycleAdmin({ db: handle.db, clock, hooks: options.lifecycleHooks });
  const schedule = createScheduleAdmin({ db: handle.db, clock });
  return { app: createServerApp(coordinator, admin, lifecycle, schedule, ownerControl), db: handle.db, handle, clock, sweep };
}

function appFetch(app: FakeBoot["app"]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(url.pathname, init) as Promise<Response>;
  }) as typeof fetch;
}

/** Record every /api/machine/report response body (the reconciled pin). */
function recordingReportBodies(fetchImpl: typeof fetch, seen: unknown[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetchImpl(input, init);
    if (String(input).includes("/api/machine/report")) seen.push(await res.clone().json());
    return res;
  }) as typeof fetch;
}

/** Capture the exact /api/machine/report REQUEST the daemon sends. */
function capturingReportRequests(
  fetchImpl: typeof fetch,
  seen: { body: string; authorization: string }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/api/machine/report")) {
      const headers = new Headers(init?.headers);
      seen.push({ body: String(init?.body ?? ""), authorization: headers.get("authorization") ?? "" });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

interface Gate {
  /** Resolves with the delivery the moment the run begins. */
  started: Promise<Delivery>;
  /** Complete the run with this report. */
  release(report: RunnerReport): void;
}

/** A runner whose EVERY call gets its own gate, consumed by index — the
 *  deterministic multi-run harness (each run blocks until released). */
function createSequentialGates(): { runner: AgentRunner; gates: Gate[] } {
  const gates: Gate[] = [];
  const runner: AgentRunner = {
    run: (delivery) =>
      new Promise<RunnerReport>((resolve) => {
        let startedFn!: (delivery: Delivery) => void;
        const started = new Promise<Delivery>((r) => {
          startedFn = r;
        });
        gates.push({ started, release: resolve });
        startedFn(delivery);
      }),
  };
  return { runner, gates };
}

/** Await the gate the runner's Nth call creates (the push happens inside the
 *  async poll pipeline, after pollOnce() is called). */
async function gateAt(gates: Gate[], index: number): Promise<Gate> {
  while (gates[index] === undefined) await new Promise((r) => setImmediate(r));
  return gates[index]!;
}

interface DaemonHarness {
  pollOnce(): Promise<void>;
  executionSettled(): Promise<void>;
  pendingCount(): number;
}

function createDaemon(
  app: FakeBoot["app"],
  token: string,
  runner: AgentRunner,
  fetchWrap?: (base: typeof fetch) => typeof fetch,
): DaemonHarness {
  const baseFetch = appFetch(app);
  const client = createMachineClient({
    baseUrl: "http://conc.local",
    machineCredential: token,
    fetchImpl: fetchWrap !== undefined ? fetchWrap(baseFetch) : baseFetch,
  });
  const runtime = createDaemonRuntime({
    client,
    runner,
    identity: { host: "conc-host", platform: "test", arch: "test", version: "0.1.0", capabilities: ["terminal-journal-v1"] },
    pollMs: 3000,
    machineCredential: token,
  });
  return {
    pollOnce: () => runtime.pollOnce(),
    executionSettled: () => runtime.executionSettled(),
    pendingCount: () => runtime.pendingCount(),
  };
}

async function createLoop(
  app: FakeBoot["app"],
  token: string,
  extra: { goal?: string; taskFile?: string } = {},
): Promise<string> {
  const createRes = await app.request("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineId: machineIdFromToken(token),
      name: "conc-loop",
      workdir: "/srv/project",
      taskFile: extra.taskFile ?? "/srv/project/TASK.md",
      ...(extra.goal !== undefined ? { goal: extra.goal } : {}),
    }),
  });
  expect(createRes.status).toBe(201);
  const { loop } = createLoopResponseSchema.parse(await createRes.json());
  return loop.id;
}

async function trigger(app: FakeBoot["app"], loopId: string): Promise<string> {
  const triggerRes = await app.request(`/api/loops/${loopId}/run`, { method: "POST" });
  expect(triggerRes.status).toBe(202);
  const trigger = triggerRunResponseSchema.parse(await triggerRes.json());
  if (!trigger.enqueued) throw new Error("expected the trigger to enqueue");
  return trigger.runId;
}

async function runsOf(app: FakeBoot["app"], loopId: string) {
  const res = await app.request(`/api/loops/${loopId}/runs`);
  expect(res.status).toBe(200);
  return runListResponseSchema.parse(await res.json()).runs;
}

async function loopRow(db: Db, loopId: string): Promise<Loop> {
  const rows = await db.select().from(loops).where(eq(loops.id, loopId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** A raw report with an explicit credential — the wake/replay/double pins. */
async function rawReport(app: FakeBoot["app"], runToken: string, body: unknown): Promise<Response> {
  return await app.request("/api/machine/report", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runToken}` },
    body: JSON.stringify(body),
  });
}

const V1_REPORT = (message: string, state?: JsonObject): RunnerReport => ({
  ok: true,
  outcome: "exec",
  durationMs: 1,
  terminal:
    state === undefined
      ? { kind: "report", status: "resolved", message }
      : { kind: "report", status: "resolved", message, state },
  taskFileSyncError: "missing",
});

const V1_FINISH = (reason: string): RunnerReport => ({
  ok: true,
  outcome: "exec",
  durationMs: 1,
  terminal: { kind: "finish", reason },
  taskFileSyncError: "missing",
});

describe("C1 — goal/report: a mid-run goal change makes the in-flight finish stale_goal", () => {
  it("claim at goalRevision 0 → PATCH goal → finish report is a stable run failure, Loop frozen, lease consumed", async () => {
    const b = await bootFake();
    const token = "dk_conc_goal";
    const { runner, gates } = createSequentialGates();
    const daemon = createDaemon(b.app, token, runner);

    await daemon.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { goal: "goal-one" });
    const runId = await trigger(b.app, loopId);

    const claimPromise = daemon.pollOnce();
    const gate = await gateAt(gates, 0);
    const delivery = await gate.started;
    expect(delivery.runId).toBe(runId);
    // The claim-time mint: the delivery carries the CURRENT goal…
    expect(delivery.loop.goal).toBe("goal-one");

    // …and the owner moves the goal BEFORE the run reports.
    const goalRes = await b.app.request(`/api/loops/${loopId}/goal`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "goal-two" }),
    });
    expect(goalRes.status).toBe(200);

    gate.release(V1_FINISH("finished the old goal"));
    await claimPromise;
    await daemon.executionSettled();
    expect(daemon.pendingCount()).toBe(0);

    // The finish is stale: the run records the stable classification and the
    // Loop writes NOTHING (no completion, no state, goal untouched).
    const runs = await runsOf(b.app, loopId);
    expect(runs[0]).toMatchObject({ id: runId, phase: "error", outcome: "error", error: "stale_goal" });
    const row = await loopRow(b.db, loopId);
    expect(row.goal).toBe("goal-two");
    expect(row.completedAt).toBeNull();
    expect(row.completionReason).toBeNull();
    expect(row.state).toBeNull();

    // The lease was consumed: a retry of the same finish meets the coded 401.
    const again = await rawReport(b.app, delivery.runToken, { ok: true });
    expect(again.status).toBe(401);
    expect(apiErrorSchema.parse(await again.json()).code).toBe(RUN_CAPABILITY_INVALID_CODE);
  });
});

describe("C2 — task-file/claim: a retarget between enqueue and claim clears the sync snapshot and the claim delivers the new path", () => {
  it("run 1 syncs content → retarget PATCH on a pending run → snapshot cleared → claim's authoritative snapshot carries the new taskFile", async () => {
    const b = await bootFake();
    const token = "dk_conc_taskfile";
    const { runner, gates } = createSequentialGates();
    const daemon = createDaemon(b.app, token, runner);

    await daemon.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { taskFile: "/srv/project/A.md" });

    // Run 1 completes and syncs the task-file content onto the loop.
    const run1 = await trigger(b.app, loopId);
    const claim1 = daemon.pollOnce();
    const gate1 = await gateAt(gates, 0);
    const delivery1 = await gate1.started;
    expect(delivery1.runId).toBe(run1);
    expect(delivery1.loop.taskFile).toBe("/srv/project/A.md");
    gate1.release({
      ok: true,
      outcome: "exec",
      durationMs: 1,
      terminal: { kind: "report", status: "resolved", message: "one" },
      taskFileContent: "# A content",
    });
    await claim1;
    await daemon.executionSettled();

    const synced = await loopRow(b.db, loopId);
    expect(synced.taskFileContent).toBe("# A content");
    expect(synced.taskFileSyncedAt).not.toBeNull();
    expect(synced.taskFileSyncAttemptedAt).not.toBeNull();
    expect(synced.taskFileSyncError).toBeNull();

    // A pending run exists; the retarget PATCH does NOT block on it (plan
    // §2.2) and clears the whole sync snapshot.
    const run2 = await trigger(b.app, loopId);
    const patchRes = await b.app.request(`/api/loops/${loopId}/task-file`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskFile: "/srv/project/B.md" }),
    });
    expect(patchRes.status).toBe(200);
    const cleared = await loopRow(b.db, loopId);
    expect(cleared.taskFile).toBe("/srv/project/B.md");
    expect(cleared.taskFileContent).toBeNull();
    expect(cleared.taskFileSyncedAt).toBeNull();
    expect(cleared.taskFileSyncAttemptedAt).toBeNull();
    expect(cleared.taskFileSyncError).toBeNull();

    // The claim transaction re-reads the loop: the pending run enqueued
    // against A is delivered with B — the authoritative snapshot, never the
    // enqueue-time row.
    const claim2 = daemon.pollOnce();
    const gate2 = await gateAt(gates, 1);
    const delivery2 = await gate2.started;
    expect(delivery2.runId).toBe(run2);
    expect(delivery2.loop.taskFile).toBe("/srv/project/B.md");
    gate2.release(V1_REPORT("two"));
    await claim2;
    await daemon.executionSettled();

    const runs = await runsOf(b.app, loopId);
    expect(runs.map((r) => r.phase).sort()).toEqual(["done", "done"]);
  });
});

describe("C8 — task-file/claim TRUE interleave (review SPEC-1/ADV-3): a claim committed inside the retarget's resolve/write window turns it into a 409 with zero retarget writes", () => {
  it("PATCH resolves → the hook commits a REAL claim (revision bump) → the guarded write cannot land the stale retarget", async () => {
    let fired = false;
    let daemonRef!: DaemonHarness;
    const b = await bootFake({
      lifecycleHooks: {
        afterResolve: async (_loopId, surface) => {
          if (surface !== "taskFile" || fired) return;
          fired = true;
          // Commit the REAL claim inside the retarget's resolve/write window —
          // the deterministic form of the review's counterexample.
          await daemonRef.pollOnce();
        },
      },
    });
    const token = "dk_conc_interleave";
    const { runner, gates } = createSequentialGates();
    daemonRef = createDaemon(b.app, token, runner);

    await daemonRef.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { taskFile: "/srv/project/A.md" });
    const runId = await trigger(b.app, loopId); // pending, unclaimed

    const patchRes = await b.app.request(`/api/loops/${loopId}/task-file`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskFile: "/srv/project/B.md" }),
    });
    expect(patchRes.status).toBe(409);
    expect(await patchRes.json()).toEqual({ error: "a run is in progress" });

    // The claimed run belongs to the OLD path — the retarget never landed,
    // so its post-run sync can only ever write A's snapshot.
    const gate = await gateAt(gates, 0);
    const delivery = await gate.started;
    expect(delivery.runId).toBe(runId);
    expect(delivery.loop.taskFile).toBe("/srv/project/A.md");
    gate.release(V1_REPORT("done"));
    await daemonRef.executionSettled();

    const loop = await loopRow(b.db, loopId);
    expect(loop.taskFile).toBe("/srv/project/A.md");
  });
});

describe("C3 — finish/report: run 2's finish completes the Loop while run 1 sleeps reclaimed; its late wake-report finalizes the run but freezes the Loop", () => {
  // Two daemon RUNTIMES sharing ONE machine credential (the double-daemon
  // fault): instance 2 claims the re-enqueued run while instance 1 sleeps.
  it("finish wins → Completed; the reclaimed run's late plain report = done/exec + byte-frozen Loop + reconciled:true", async () => {
    const b = await bootFake();
    const token = "dk_conc_fin";
    const gates1 = createSequentialGates();
    const gates2 = createSequentialGates();
    const seenReports: unknown[] = [];
    const daemon1 = createDaemon(b.app, token, gates1.runner, (base) => recordingReportBodies(base, seenReports));
    const daemon2 = createDaemon(b.app, token, gates2.runner);

    await daemon1.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { goal: "shared-goal" });

    // Instance 1 claims run 1 and "sleeps"; the sweep reclaims it
    // (terminal-grace lease, observable error).
    const run1 = await trigger(b.app, loopId);
    const claim1 = daemon1.pollOnce();
    const gate1 = await gateAt(gates1.gates, 0);
    const delivery1 = await gate1.started;
    expect(delivery1.runId).toBe(run1);
    b.clock.advance(21 * 60_000);
    const stats = await b.sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 1, failed: 0 });

    // Run 2 enqueues over the errored run 1; instance 2 (same credential,
    // free capacity) claims it and FINISHES — the Loop completes.
    const run2 = await trigger(b.app, loopId);
    const claim2 = daemon2.pollOnce();
    const gate2 = await gateAt(gates2.gates, 0);
    const delivery2 = await gate2.started;
    expect(delivery2.runId).toBe(run2);
    gate2.release(V1_FINISH("goal met by run 2"));
    await claim2;
    await daemon2.executionSettled();

    const afterFinish = await loopRow(b.db, loopId);
    expect(afterFinish.completedAt).not.toBeNull();
    expect(afterFinish.completionReason).toBe("goal met by run 2");
    expect(afterFinish.enabled).toBe(false);
    // Run 1's misjudged error still stands; its terminal-grace lease survives.
    const midRuns = await runsOf(b.app, loopId);
    expect(midRuns.find((r) => r.id === run1)).toMatchObject({ phase: "error", error: RECLAIM_RUN_ERROR });
    expect(await b.db.select().from(runLeases)).toHaveLength(1);

    // Instance 1 wakes with a plain report: the terminal-grace wake-report
    // hits the ALREADY-COMPLETED loop — v1_late_success. The RUN finalizes
    // (done/exec + status/message/state) but every Loop field stays frozen.
    gate1.release(V1_REPORT("late success after completion", { n: 1 }));
    await claim1;
    await daemon1.executionSettled();
    expect(seenReports).toEqual([{ ok: true, reconciled: true }]);

    const finalRuns = await runsOf(b.app, loopId);
    expect(finalRuns.find((r) => r.id === run1)).toMatchObject({
      phase: "done",
      outcome: "exec",
      status: "resolved",
      message: "late success after completion",
      error: null,
    });
    expect(await loopRow(b.db, loopId)).toEqual(afterFinish);
    expect(await b.db.select().from(runLeases)).toHaveLength(0);
  });
});

describe("C4 — finish/sweep: the wake-report after a reclaim is a FINISH — reconciled:true and exactly one completion", () => {
  it("claim → sleep past the timeout → sweep reclaims → the waking daemon's finish completes the Loop once", async () => {
    const b = await bootFake();
    const token = "dk_conc_sweep";
    const seenReports: unknown[] = [];
    const { runner, gates } = createSequentialGates();
    const daemon = createDaemon(b.app, token, runner, (base) => recordingReportBodies(base, seenReports));

    await daemon.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { goal: "sweep-goal" });
    const runId = await trigger(b.app, loopId);

    const claimPromise = daemon.pollOnce();
    const gate = await gateAt(gates, 0);
    await gate.started;

    b.clock.advance(21 * 60_000);
    const stats = await b.sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 1, failed: 0 });
    const midRuns = await runsOf(b.app, loopId);
    expect(midRuns[0]).toMatchObject({ id: runId, phase: "error", error: RECLAIM_RUN_ERROR });

    // The laptop wakes with a FINISH: the terminal-grace wake-report runs
    // the same v1 branch table — a legal finish completes the Loop.
    gate.release(V1_FINISH("slept through the sweep, goal still met"));
    await claimPromise;
    await daemon.executionSettled();
    expect(daemon.pendingCount()).toBe(0);
    expect(seenReports).toEqual([{ ok: true, reconciled: true }]);

    const finalRuns = await runsOf(b.app, loopId);
    expect(finalRuns[0]).toMatchObject({
      id: runId,
      phase: "done",
      outcome: "exec",
      status: "resolved",
      message: "slept through the sweep, goal still met",
      error: null,
    });
    const row = await loopRow(b.db, loopId);
    expect(row.completedAt).not.toBeNull();
    expect(row.completionReason).toBe("slept through the sweep, goal still met");
    expect(row.enabled).toBe(false);
    expect(await b.db.select().from(runLeases)).toHaveLength(0);
  });
});

describe("C5 — reopen/late-report: reopen revokes the old generation; its late report meets the coded 401 and nothing moves", () => {
  it("finish completes → reopen deletes the reclaimed run's terminal-grace lease → the late wake-report is 401, run stays an error", async () => {
    const b = await bootFake();
    const token = "dk_conc_reopen";
    const gates1 = createSequentialGates();
    const gates2 = createSequentialGates();
    const daemon1 = createDaemon(b.app, token, gates1.runner);
    const daemon2 = createDaemon(b.app, token, gates2.runner);

    await daemon1.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { goal: "reopen-goal" });

    // Same build-up as C3: instance 1 sleeps past the sweep; instance 2
    // finishes run 2 and completes the Loop.
    const run1 = await trigger(b.app, loopId);
    const claim1 = daemon1.pollOnce();
    const gate1 = await gateAt(gates1.gates, 0);
    const delivery1 = await gate1.started;
    expect(delivery1.runId).toBe(run1);
    b.clock.advance(21 * 60_000);
    await b.sweep.runOnce();
    const run2 = await trigger(b.app, loopId);
    const claim2 = daemon2.pollOnce();
    const gate2 = await gateAt(gates2.gates, 0);
    await gate2.started;
    gate2.release(V1_FINISH("done, but reopen follows"));
    await claim2;
    await daemon2.executionSettled();
    expect((await loopRow(b.db, loopId)).completedAt).not.toBeNull();

    // Reopen: the old generation is revoked in one transaction — run 1's
    // terminal-grace lease deleted (EVERY lease goes), completion cleared.
    const reopenRes = await b.app.request(`/api/loops/${loopId}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(reopenRes.status).toBe(200);
    const { loop: reopened } = reopenLoopResponseSchema.parse(await reopenRes.json());
    expect(reopened).toMatchObject({ id: loopId, enabled: true, completedAt: null, completionReason: null, goal: "reopen-goal" });
    expect(await b.db.select().from(runLeases)).toHaveLength(0);

    // Snapshot BEFORE the late report — nothing may move afterwards.
    const loopsBefore = loopListResponseSchema.parse(await (await b.app.request("/api/loops")).json());
    const runsBefore = await runsOf(b.app, loopId);

    // Instance 1 wakes and reports: the revoked credential meets the coded
    // 401 (the terminal confirmation — the daemon clears its pending report).
    gate1.release(V1_REPORT("late after reopen"));
    await claim1;
    await daemon1.executionSettled();
    expect(daemon1.pendingCount()).toBe(0);

    // Run 1 keeps the sweep's misjudgment (reopen never rewrites history);
    // run 2's done/exec stands; the Loop snapshot is untouched.
    const finalRuns = await runsOf(b.app, loopId);
    expect(finalRuns).toEqual(runsBefore);
    expect(finalRuns.find((r) => r.id === run1)).toMatchObject({ phase: "error", error: RECLAIM_RUN_ERROR });
    expect(finalRuns.find((r) => r.id === run2)).toMatchObject({ phase: "done", outcome: "exec" });
    expect(loopListResponseSchema.parse(await (await b.app.request("/api/loops")).json())).toEqual(loopsBefore);
  });
});

describe("C6 — duplicate delivery: the daemon's exact report bytes replayed after a committed success meet the coded 401 with zero extra writes", () => {
  it("daemon reports successfully → byte-identical replay → 401; run/loop snapshots unchanged", async () => {
    const b = await bootFake();
    const token = "dk_conc_replay";
    const seenRequests: { body: string; authorization: string }[] = [];
    const { runner, gates } = createSequentialGates();
    const daemon = createDaemon(b.app, token, runner, (base) => capturingReportRequests(base, seenRequests));

    await daemon.pollOnce(); // register
    const loopId = await createLoop(b.app, token);
    const runId = await trigger(b.app, loopId);

    const claimPromise = daemon.pollOnce();
    const gate = await gateAt(gates, 0);
    await gate.started;
    gate.release(V1_REPORT("committed once", { cursor: 1 }));
    await claimPromise;
    await daemon.executionSettled();
    expect(daemon.pendingCount()).toBe(0);

    expect(seenRequests).toHaveLength(1);
    const runsBefore = await runsOf(b.app, loopId);
    const loopsBefore = loopListResponseSchema.parse(await (await b.app.request("/api/loops")).json());

    // The at-least-once network replays the EXACT bytes (same credential,
    // same body): the consumed lease answers the coded 401 and not a single
    // field moves — no double write, no double state promotion.
    const replay = await b.app.request("/api/machine/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: seenRequests[0]!.authorization },
      body: seenRequests[0]!.body,
    });
    expect(replay.status).toBe(401);
    expect(apiErrorSchema.parse(await replay.json()).code).toBe(RUN_CAPABILITY_INVALID_CODE);

    expect(await runsOf(b.app, loopId)).toEqual(runsBefore);
    expect(loopListResponseSchema.parse(await (await b.app.request("/api/loops")).json())).toEqual(loopsBefore);
    const row = await loopRow(b.db, loopId);
    expect(row.state).toEqual({ cursor: 1 });
    const runs = await runsOf(b.app, loopId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, phase: "done", outcome: "exec" });
  });
});

describe("C7 — double report: two different terminals on one lease — the second meets the coded 401 (no double completion)", () => {
  it("plain report consumes the lease → a finish on the same credential is refused, the Loop never completes", async () => {
    const b = await bootFake();
    const token = "dk_conc_double";
    const { runner, gates } = createSequentialGates();
    const daemon = createDaemon(b.app, token, runner);

    await daemon.pollOnce(); // register
    const loopId = await createLoop(b.app, token, { goal: "double-goal" });
    const runId = await trigger(b.app, loopId);

    const claimPromise = daemon.pollOnce();
    const gate = await gateAt(gates, 0);
    const delivery = await gate.started;
    expect(delivery.runId).toBe(runId);

    // Report #1 (plain report) commits and consumes the lease.
    const first = await rawReport(b.app, delivery.runToken, {
      ok: true,
      outcome: "exec",
      durationMs: 1,
      terminal: { kind: "report", status: "resolved", message: "first wins" },
      taskFileSyncError: "missing",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // Report #2 (finish) on the SAME credential: 401 — the completion never
    // happens twice and the first report's outcome stands.
    const second = await rawReport(b.app, delivery.runToken, {
      ok: true,
      outcome: "exec",
      durationMs: 1,
      terminal: { kind: "finish", reason: "second tries to complete" },
      taskFileSyncError: "missing",
    });
    expect(second.status).toBe(401);
    expect(apiErrorSchema.parse(await second.json()).code).toBe(RUN_CAPABILITY_INVALID_CODE);

    const runs = await runsOf(b.app, loopId);
    expect(runs[0]).toMatchObject({ id: runId, phase: "done", outcome: "exec", message: "first wins" });
    const row = await loopRow(b.db, loopId);
    expect(row.completedAt).toBeNull();
    expect(row.completionReason).toBeNull();
    expect(row.enabled).toBe(true);
    await claimPromise; // the claiming poll already returned; join for hygiene
  });
});
