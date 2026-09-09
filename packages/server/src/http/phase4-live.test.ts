/**
 * Phase 4 Batch 2 — the PRODUCTION behavior boundary (ADR-009 决策 11's
 * dormancy ends here). These black-box HTTP tests pin what Batch 2 turns on:
 *
 *  L1  the Goal/Task-File/Reopen routes are MOUNTED and enforce their stable
 *      taxonomy (404/400/409 codes, no-op, revision exhaustion)
 *  L2  Create Loop requires taskFile at the application layer (400) and
 *      normalizes/persists the goal; LoopSummary always emits the Phase 4
 *      observation fields
 *  L3  capability declaration: persisted as the current complete snapshot;
 *      illegal declarations 400 the whole poll BEFORE any write; a
 *      capability-less machine claims nothing and gets the upgrade hint only
 *      when work exists
 *  L4  a capable claim mints the EXPLICIT v1 lease (terminalProtocolVersion=1,
 *      goalRevision=<current>, canFinish=role==='exec' && goal!=null) and the
 *      Delivery carries terminalProtocol:1 + the current goal
 *  L5  a v0 lease (pre-upgrade) still finalizes with Phase 3 semantics —
 *      terminal/state/sync extensions are ignored entirely
 *  L6  a pending run created BEFORE the upgrade claims as v1 (the protocol
 *      version is decided at CLAIM time, never at run creation)
 *  L7  a pathologically deep terminal state is a stable 400 with the lease
 *      untouched
 */
import { afterEach, describe, expect, it } from "vitest";

import { createLoopResponseSchema, pollResponseSchema, reportResponseSchema } from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";
import { eq } from "drizzle-orm";

import { createLoopAdmin, type LoopAdmin } from "../admin/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, machines, runLeases, runs } from "../db/schema.js";
import { createLifecycleAdmin } from "../loop-lifecycle/admin.js";
import { createOwnerControl, type OwnerControl } from "../owner/index.js";
import { createScheduleAdmin } from "../schedule/index.js";
import { FakeClock, seedLoop, seedMachineForToken, seedRun, snapshotLoops, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createServerApp } from "./app.js";

const TOKEN = "dk_test_machine_alpha";
const V1 = ["terminal-journal-v1"];

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let coordinator: RunCoordinator;
let app: ReturnType<typeof createServerApp>;

async function fresh(): Promise<string> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  coordinator = createRunCoordinator(testDeps(db, clock));
  let loopN = 0;
  const admin: LoopAdmin = createLoopAdmin({ db, clock, newLoopId: () => `loop-${++loopN}` });
  const ownerControl: OwnerControl = createOwnerControl({ db, clock });
  app = createServerApp(coordinator, admin, createLifecycleAdmin({ db, clock }), createScheduleAdmin({ db, clock }), ownerControl);
  return seedMachineForToken(db, TOKEN);
}

async function pollReq(body: unknown): Promise<Response> {
  return app.request("/api/machine/poll", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function reportReq(token: string, body: unknown): Promise<Response> {
  return app.request("/api/machine/report", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("L1: Phase 4 management routes are mounted", () => {
  it("PATCH goal / PATCH task-file / POST reopen answer with their real taxonomy", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/tmp/TASK.md" });

    const goal = await app.request("/api/loops/loop-1/goal", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "close the gap" }),
    });
    expect(goal.status).toBe(200);
    const goalJson = createLoopResponseSchema.parse({ loop: ((await goal.json()) as { loop: unknown }).loop });
    expect(goalJson.loop.goal).toBe("close the gap");
    expect((await snapshotLoops(db))[0]!.goalRevision).toBe(1);

    const taskFile = await app.request("/api/loops/loop-1/task-file", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskFile: "/tmp/NEW-TASK.md" }),
    });
    expect(taskFile.status).toBe(200);
    expect((await snapshotLoops(db))[0]!.taskFile).toBe("/tmp/NEW-TASK.md");

    // Not completed → the stable 409 + loop_not_completed code.
    const reopen = await app.request("/api/loops/loop-1/reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reopen.status).toBe(409);
    expect(await reopen.json()).toEqual({ error: "loop is not completed", code: "loop_not_completed" });

    // Unknown loop → flat 404 on all three.
    for (const [method, path, body] of [
      ["PATCH", "/api/loops/loop-nope/goal", { goal: "g" }],
      ["PATCH", "/api/loops/loop-nope/task-file", { taskFile: "/t" }],
      ["POST", "/api/loops/loop-nope/reopen", {}],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("L2: Create Loop application-layer requirements + observation fields", () => {
  it("a missing taskFile is a 400; a passed goal is ACTIVATED; the summary emits every Phase 4 key", async () => {
    const machineId = await fresh();
    const missing = await app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId }),
    });
    expect(missing.status).toBe(400);

    const res = await app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, taskFile: "/tmp/TASK.md", goal: "  close the gap  " }),
    });
    expect(res.status).toBe(201);
    const raw = (await res.json()) as { loop: Record<string, unknown> };
    // The Phase 4 keys are present and explicit (null when unset).
    expect(raw.loop.goal).toBe("close the gap"); // normalized (trimmed)
    for (const key of [
      "completedAt",
      "completionReason",
      "taskFileSyncedAt",
      "taskFileSyncAttemptedAt",
      "taskFileSyncError",
    ]) {
      expect(raw.loop, `response must carry ${key}`).toHaveProperty(key, null);
    }
    const [row] = await snapshotLoops(db);
    expect(row.goal).toBe("close the gap");
    expect(row.goalRevision).toBe(0); // creation never counts as a change
  });
});

describe("L3: capability declaration persistence + gating", () => {
  it("a capable poll persists the deduped+sorted snapshot; a capability-less poll claims nothing and gets the hint", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/tmp/TASK.md" });
    await seedRun(db, { id: "run-1", machineId });

    const gated = pollResponseSchema.parse(await (await pollReq({})).json());
    expect(gated.deliveries).toEqual([]);
    expect(gated.requiredCapabilities).toEqual(["terminal-journal-v1"]);
    expect((await db.select().from(runs)).every((r) => r.phase === "pending")).toBe(true);
    expect(await db.select().from(runLeases)).toEqual([]);

    const capable = pollResponseSchema.parse(
      await (await pollReq({ capabilities: ["zzz-future", "terminal-journal-v1", "zzz-future"] })).json(),
    );
    expect(capable.deliveries).toHaveLength(1);
    const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(machine.capabilities).toEqual(["terminal-journal-v1", "zzz-future"]);
  });

  it("an illegal declaration 400s the WHOLE poll — before any heartbeat/snapshot/claim write", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    await seedRun(db, { id: "run-1", machineId });
    const [before] = await db.select().from(machines).where(eq(machines.id, machineId));

    const res = await pollReq({ capabilities: ["UPPERCASE"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request" });

    const [after] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(after).toEqual(before); // lastSeen/capabilities untouched
    expect((await db.select().from(runs))[0]!.phase).toBe("pending");
  });
});

describe("L4: capable claims mint explicit v1 leases and v1 deliveries", () => {
  it("lease = v1/current-goalRevision/canFinish-by-goal; delivery carries terminalProtocol:1 + goal", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/tmp/TASK.md", goal: "close it", goalRevision: 3 });
    await seedRun(db, { id: "run-1", machineId });

    const parsed = pollResponseSchema.parse(await (await pollReq({ capabilities: V1 })).json());
    expect(parsed).not.toHaveProperty("requiredCapabilities");
    const delivery = parsed.deliveries[0]!;
    expect(delivery.terminalProtocol).toBe(1);
    expect(delivery.loop.goal).toBe("close it");

    const [lease] = await db.select().from(runLeases);
    expect(lease).toMatchObject({
      runId: "run-1",
      terminalProtocolVersion: 1,
      goalRevision: 3,
      canFinish: true,
      state: "active",
    });
    expect(lease.tokenHash).toBe(sha256(delivery.runToken));
  });

  it("an Open Loop (goal=null) mints canFinish=false", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/tmp/TASK.md" });
    await seedRun(db, { id: "run-1", machineId });
    await pollReq({ capabilities: V1 });
    const [lease] = await db.select().from(runLeases);
    expect(lease).toMatchObject({ terminalProtocolVersion: 1, goalRevision: 0, canFinish: false });
  });

  it("a Completed loop is never claimed (its pending run stays pending)", async () => {
    const machineId = await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      taskFile: "/tmp/TASK.md",
      goal: "done",
      enabled: false,
      completedAt: "2026-07-28T00:00:00.000Z",
      completionReason: "finished",
    });
    await seedRun(db, { id: "run-1", machineId });
    const parsed = pollResponseSchema.parse(await (await pollReq({ capabilities: V1 })).json());
    expect(parsed.deliveries).toEqual([]);
    expect(parsed).not.toHaveProperty("requiredCapabilities"); // not claimable → no hint
    expect((await db.select().from(runs))[0]!.phase).toBe("pending");
    expect(await db.select().from(runLeases)).toEqual([]);
  });
});

describe("L5: v0 leases keep Phase 3 semantics forever", () => {
  it("a v0 report carrying terminal/state/sync extensions finalizes the Phase 3 way", async () => {
    const machineId = await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      state: { cursor: 1 },
      taskFileContent: "old content",
      taskFileSyncedAt: "2026-07-02T00:00:00.000Z",
    });
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    // A pre-upgrade claimed lease: explicitly v0 (seedLease's default).
    await db.insert(runLeases).values({
      tokenHash: sha256("rk_legacy"),
      runId: "run-1",
      loopId: "loop-1",
      machineId,
      role: "exec",
      state: "active",
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const res = await reportReq("rk_legacy", {
      runId: "run-1",
      ok: true,
      message: "done the phase-3 way",
      terminal: { kind: "finish", reason: "goal met", state: { cursor: 99 } },
      taskFileContent: "new content",
    });
    expect(res.status).toBe(200);
    expect(reportResponseSchema.parse(await res.json())).toEqual({ ok: true });

    const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    expect(loop.state).toEqual({ cursor: 1 }); // NOT promoted
    expect(loop.taskFileContent).toBe("old content"); // NOT synced
    expect(loop.taskFileSyncAttemptedAt).toBeNull();
    expect(loop.completedAt).toBeNull(); // finish NEVER landed
    expect(loop.enabled).toBe(true);
    const [run] = await db.select().from(runs).where(eq(runs.id, "run-1"));
    expect(run).toMatchObject({ phase: "done", outcome: "exec", message: "done the phase-3 way" });
    expect(await db.select().from(runLeases)).toHaveLength(0); // lease consumed
  });
});

describe("L6: protocol version is decided at claim time, not run-creation time", () => {
  it("a pre-upgrade pending run claims as v1 for a capable daemon", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/tmp/TASK.md", goal: "g", goalRevision: 2 });
    await seedRun(db, { id: "run-legacy", machineId, ts: "2026-06-01T00:00:00.000Z" });

    const poll = pollResponseSchema.parse(await (await pollReq({ capabilities: V1 })).json());
    expect(poll.deliveries[0]!.runId).toBe("run-legacy");

    const [lease] = await db.select().from(runLeases);
    expect(lease).toMatchObject({ terminalProtocolVersion: 1, goalRevision: 2, canFinish: true });
  });
});

describe("L7: pathologically deep terminal state is a stable 400, never a 500", () => {
  it("a 20k-deep state body is rejected at the wire and the lease is NOT consumed", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/tmp/TASK.md" });
    await seedRun(db, { id: "run-1", machineId });

    const poll = pollResponseSchema.parse(await (await pollReq({ capabilities: V1 })).json());
    const delivery = poll.deliveries[0]!;

    // JSON.stringify cannot build this body (it would recurse), so construct
    // the JSON text directly: a `{"next":…}` chain 20,000 levels deep.
    const depth = 20_000;
    const deepState = `{"next":`.repeat(depth) + "1" + `}`.repeat(depth);
    const body =
      `{"runId":"${delivery.runId}","ok":true,` +
      `"terminal":{"kind":"report","status":"nothing-new","state":${deepState}},` +
      `"taskFileContent":"x"}`;

    const res = await app.request("/api/machine/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${delivery.runToken}` },
      body,
    });
    expect(res.status).toBe(400);

    // The lease survives: the rejection happened at the wire, before any
    // finalize path could consume it.
    const leases = await db.select().from(runLeases);
    expect(leases).toHaveLength(1);
    expect(leases[0]!.runId).toBe("run-1");
    const [run] = await db.select().from(runs).where(eq(runs.id, "run-1"));
    expect(run.phase).toBe("running");
  });
});
