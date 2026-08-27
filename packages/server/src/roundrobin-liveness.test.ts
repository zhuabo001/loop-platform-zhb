/**
 * L group — Issue #12 cross-layer round-robin liveness acceptance (Phase 2
 * batch 3, plan Day 5): the ONE test that joins the daemon's round-robin
 * progress heartbeat to the server's sweep through the REAL chain — daemon
 * runtime → MachineClient → HTTP → coordinator → applyRunProgress → PGlite —
 * instead of testing each side separately.
 *
 * Scenario (the Issue #12 gap): a batch-delivery window (an old daemon's poll
 * omits `availableSlots`, so the server keeps its Phase-1 batch claim) leaves
 * 25 runs server-side `running` on ONE machine; the NEW daemon holds them as
 * 1 executing + 24 queued and heartbeats them under the ≤20-entries/poll
 * round-robin budget. The FakeClock-driven sweep must reclaim NONE of them
 * inside the inactivity window — while a never-heartbeated control run IS
 * reclaimed (the sweep is not vacuously broken), and once the heartbeats stop
 * and the window lapses, ALL of them are reclaimed (the zero-reclaim was
 * earned by fresh evidence, not by a dead sweep).
 */
import { describe, expect, it, afterEach } from "vitest";

import {
  createDaemonRuntime,
  createMachineClient,
  type AgentRunner,
  type MachineClient,
  type RunnerReport,
} from "@loopzhb/daemon";
import { machineIdFromToken, sha256 } from "@loopzhb/protocol/node";

import { createLoopAdmin, newUuidLoopId } from "./admin/index.js";
import { createRunCoordinator, mintRunCredential, newUuidRunId } from "./coordinator/index.js";
import { closeDb, openMigratedDb, type DbHandle } from "./db/index.js";
import { createServerApp } from "./http/app.js";
import { createOwnerControl } from "./owner/index.js";
import { createInactivitySweep } from "./sweep/index.js";
import { FakeClock, seedLease, seedLoop, seedRun, snapshotRuns } from "./testkit/index.js";

const TOKEN = "dk_liveness_machine";
const RUN_COUNT = 25;
const MINUTE = 60_000;

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/** The batch-3 graph with ONE FakeClock shared by the coordinator (progress
 *  `at` stamps) and the sweep (inactivity decisions). */
async function bootLiveness() {
  const handle = await openMigratedDb();
  handles.push(handle);
  const clock = new FakeClock();
  const coordinator = createRunCoordinator({
    db: handle.db,
    clock,
    newRunId: newUuidRunId,
    mintRunCredential,
  });
  const admin = createLoopAdmin({ db: handle.db, clock, newLoopId: newUuidLoopId });
  const ownerControl = createOwnerControl({ db: handle.db, clock });
  const app = createServerApp(coordinator, admin, ownerControl, handle.db, clock);
  const sweep = createInactivitySweep({ db: handle.db, clock, log: () => {} });
  return { app, sweep, handle, clock };
}

/** Adapt the Hono app into the daemon's fetch (no TCP port). */
function appFetch(app: ReturnType<typeof createServerApp>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(url.pathname, init) as Promise<Response>;
  }) as typeof fetch;
}

/** The runner that never finishes: its one execution stays in flight so all
 *  24 other claimed runs stay QUEUED — the round-robin population. */
function neverFinishingRunner(): { runner: AgentRunner; started: () => number } {
  let started = 0;
  return {
    runner: {
      run: () =>
        new Promise<RunnerReport>(() => {
          started += 1;
        }),
    },
    started: () => started,
  };
}

describe("Issue #12: cross-layer round-robin liveness", () => {
  it("L1/L2: 25 claimed runs survive the in-window sweep, a never-heartbeated control is reclaimed, and silence reclaims them all", async () => {
    const { app, sweep, handle, clock } = await bootLiveness();
    const db = handle.db;

    const inner = createMachineClient({
      baseUrl: "http://liveness.local",
      machineCredential: TOKEN,
      fetchImpl: appFetch(app),
    });
    // The batch-delivery window: this daemon's polls omit availableSlots, so
    // the server keeps its Phase-1 batch claim and delivers ALL pendings at
    // once. Everything else (progress heartbeats included) is the production
    // runtime's own wire behavior.
    const batchClient: MachineClient = {
      poll: (body, signal) => {
        const { availableSlots: _stripped, ...rest } = body;
        return inner.poll(rest, signal);
      },
      report: (credential, body, signal) => inner.report(credential, body, signal),
    };
    const gated = neverFinishingRunner();
    const runtime = createDaemonRuntime({
      client: batchClient,
      runner: gated.runner,
      identity: { host: "liveness-host", platform: "test", arch: "test", version: "0.1.0" },
      pollMs: 3000,
      machineCredential: TOKEN,
    });

    // 1. Registration poll (nothing pending yet).
    await runtime.pollOnce();
    const machineId = machineIdFromToken(TOKEN);

    // 2. 25 loops + 25 pending runs over real HTTP.
    const runIds: string[] = [];
    for (let i = 1; i <= RUN_COUNT; i += 1) {
      const createRes = await app.request("/api/loops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId, name: `liveness-loop-${i}`, workdir: "/srv/liveness" }),
      });
      expect(createRes.status).toBe(201);
      const { loop } = (await createRes.json()) as { loop: { id: string } };
      const triggerRes = await app.request(`/api/loops/${loop.id}/run`, { method: "POST" });
      expect(triggerRes.status).toBe(202);
      const trigger = (await triggerRes.json()) as { enqueued: boolean; runId: string | null };
      expect(trigger.enqueued).toBe(true);
      runIds.push(trigger.runId!);
    }

    // 3. The control: a run that was claimed and then its delivery was lost
    //    (running, stale ts, active lease, NO daemon-side knowledge). It must
    //    be reclaimed in EVERY pass — the sweep is never vacuous.
    await seedLoop(db, { id: "loop-control", machineId });
    const staleTs = new Date(clock.now().getTime() - 25 * MINUTE).toISOString();
    await seedRun(db, { id: "run-control", loopId: "loop-control", machineId, phase: "running", ts: staleTs });
    await seedLease(db, { tokenHash: sha256("rk_liveness_control"), runId: "run-control", loopId: "loop-control", machineId });

    // 4. The batch-delivery poll: all 25 are claimed at once (server-side
    //    running); the daemon executes ONE and queues 24.
    await runtime.pollOnce();
    expect(gated.started()).toBe(1);
    let rows = await snapshotRuns(db);
    expect(rows.filter((r) => r.phase === "running")).toHaveLength(RUN_COUNT + 1);
    expect(rows.filter((r) => runIds.includes(r.id)).every((r) => r.phase === "running")).toBe(true);

    // 5. Four heartbeat rounds, five minutes apart: each poll carries ≤20
    //    entries (1 executing + 19 rotated queued), so 24 queued runs are all
    //    refreshed within two rounds. The oldest LAST-seen stamp afterwards is
    //    T0+10min.
    for (let round = 0; round < 4; round += 1) {
      clock.advance(5 * MINUTE);
      await runtime.pollOnce();
    }
    rows = await snapshotRuns(db);
    const heartbeated = new Set(rows.filter((r) => r.progress !== null).map((r) => r.id));
    for (const id of runIds) expect(heartbeated.has(id)).toBe(true); // rotation covered EVERY claimed run
    expect(rows.find((r) => r.id === "run-control")!.progress).toBeNull();

    // 6. In-window sweep (T0+29min: the oldest heartbeat is 19min old, inside
    //    the 20min window): ZERO misreclaim of the heartbeated runs; the
    //    never-heartbeated control IS reclaimed.
    clock.advance(9 * MINUTE);
    const inWindow = await sweep.runOnce();
    expect(inWindow).toMatchObject({ scanned: RUN_COUNT + 1, reclaimed: 1, failed: 0 });
    rows = await snapshotRuns(db);
    for (const id of runIds) {
      expect(rows.find((r) => r.id === id)!.phase).toBe("running");
    }
    expect(rows.find((r) => r.id === "run-control")!.phase).toBe("error");

    // 7. L2 positive control: heartbeats stop (the daemon is hung); once the
    //    newest heartbeat lapses past the window, the sweep reclaims ALL 25.
    clock.advance(22 * MINUTE); // newest heartbeat (T0+20) is now 31min stale
    const lapsed = await sweep.runOnce();
    expect(lapsed).toMatchObject({ scanned: RUN_COUNT, reclaimed: RUN_COUNT, failed: 0 });
    rows = await snapshotRuns(db);
    for (const id of runIds) {
      expect(rows.find((r) => r.id === id)!.phase).toBe("error");
    }
  }, 60_000);
});
