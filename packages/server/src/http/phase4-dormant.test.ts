/**
 * Phase 4 Batch 1 — R group: the FULLY DORMANT production boundary (ADR-009
 * 决策 11). These black-box tests prove that after all of Batch 1 the
 * production semantics are still exactly Phase 3's.
 *
 *  R1  Goal/Task-File/Reopen routes are NOT mounted (404); Create Loop still
 *      doesn't require a taskFile and does NOT activate a passed goal
 *  R2  a capability-carrying poll parses, persists nothing, doesn't change
 *      claim candidates, and the minted lease is EXPLICITLY v0/0/false
 *  R3  deliveries carry no terminalProtocol/goal and no requiredCapabilities
 *      hint (prompt goldens stay pinned in gateway/delivery.test.ts)
 *  R4  a v0 report carrying terminal/state/sync extensions finalizes with
 *      Phase 3 semantics only — loop state/task-file/completion untouched
 *  R6  a pending run created before the upgrade still claims as v0 — the
 *      protocol version is decided at CLAIM time, never at run creation
 *
 * R5 is the full-repo regression gate (pnpm test / typecheck / build /
 * db:check), run at batch close.
 *
 * Round-1 review regressions added on top: SP-1 (a pathologically deep
 * terminal state is a stable 400 with the lease untouched, never a 500) and
 * SP-2 (the raw Create/List observation shape carries NO Phase 4 keys).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createLoopResponseSchema, pollResponseSchema, reportResponseSchema } from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";
import { eq } from "drizzle-orm";

import { createLoopAdmin, type LoopAdmin } from "../admin/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, machines, runLeases, runs } from "../db/schema.js";
import { createOwnerControl, type OwnerControl } from "../owner/index.js";
import { FakeClock, seedLoop, seedMachineForToken, seedRun, snapshotLoops, testDeps } from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createServerApp } from "./app.js";

const TOKEN = "dk_test_machine_alpha";

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
  app = createServerApp(coordinator, admin, ownerControl, db, clock);
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

describe("R1: Phase 4 management routes are not mounted", () => {
  it("PATCH goal / PATCH task-file / POST reopen all 404", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    for (const [method, path, body] of [
      ["PATCH", "/api/loops/loop-1/goal", { goal: "g" }],
      ["PATCH", "/api/loops/loop-1/task-file", { taskFile: "/tmp/TASK.md" }],
      ["POST", "/api/loops/loop-1/reopen", {}],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("create loop still doesn't require a taskFile and does NOT activate a passed goal", async () => {
    const machineId = await fresh();
    const res = await app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, goal: "should stay dormant" }),
    });
    expect(res.status).toBe(201);
    // The RAW response must not carry the Phase 4 observation fields at all
    // (review SP-2): the production surface stays byte-identical to Phase 3.
    // Parsing with the current (optional-field) reader and finding nulls
    // would NOT prove dormancy — key absence does.
    const raw = (await res.json()) as { loop: Record<string, unknown> };
    for (const key of [
      "goal",
      "completedAt",
      "completionReason",
      "taskFileSyncedAt",
      "taskFileSyncAttemptedAt",
      "taskFileSyncError",
    ]) {
      expect(raw.loop, `response must not carry ${key}`).not.toHaveProperty(key);
    }
    expect(createLoopResponseSchema.parse(raw).loop.taskFile).toBeNull();
    const [row] = await snapshotLoops(db);
    expect(row.goal).toBeNull();
    expect(row.goalRevision).toBe(0);
  });

  it("GET /api/loops emits no Phase 4 keys either (review SP-2)", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "stored but unexposed", goalRevision: 2 });
    const res = await app.request("/api/loops");
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const key of [
      '"goal"',
      '"completedAt"',
      '"completionReason"',
      '"taskFileSyncedAt"',
      '"taskFileSyncAttemptedAt"',
      '"taskFileSyncError"',
    ]) {
      expect(text, `response must not contain ${key}`).not.toContain(key);
    }
  });
});

describe("R2: capabilities parse but change nothing", () => {
  it("poll with capabilities persists nothing and returns no upgrade hint", async () => {
    const machineId = await fresh();
    const res = await pollReq({ capabilities: ["terminal-journal-v1", "future-cap"] });
    expect(res.status).toBe(200);
    const parsed = pollResponseSchema.parse(await res.json());
    expect(parsed).toEqual({ deliveries: [] }); // no requiredCapabilities key

    const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(machine.capabilities).toBeNull(); // write-closed in Batch 1
  });

  it("a capable daemon's claim is unfiltered and mints an EXPLICIT v0/0/false lease", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "stored but undelivered", goalRevision: 3 });
    await seedRun(db, { id: "run-1", machineId });

    const res = await pollReq({ capabilities: ["terminal-journal-v1"] });
    const parsed = pollResponseSchema.parse(await res.json());
    expect(parsed.deliveries).toHaveLength(1);

    const leases = await db.select().from(runLeases);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      runId: "run-1",
      terminalProtocolVersion: 0,
      goalRevision: 0,
      canFinish: false,
      state: "active",
    });
  });
});

describe("R3: deliveries carry no Phase 4 semantics", () => {
  it("no terminalProtocol, no loop.goal, no requiredCapabilities", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "stored but undelivered", goalRevision: 3 });
    await seedRun(db, { id: "run-1", machineId });

    const res = await pollReq({ capabilities: ["terminal-journal-v1"] });
    const raw = (await res.json()) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("requiredCapabilities");
    const deliveries = raw.deliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).not.toHaveProperty("terminalProtocol");
    expect(deliveries[0]!.loop).not.toHaveProperty("goal");
  });
});

describe("R4: a v0 report with Phase 4 extensions finalizes with Phase 3 semantics", () => {
  it("terminal/state/sync are ignored; loop state/task-file/completion untouched", async () => {
    const machineId = await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      state: { cursor: 1 },
      taskFileContent: "old content",
      taskFileSyncedAt: "2026-07-02T00:00:00.000Z",
    });
    await seedRun(db, { id: "run-1", machineId });

    const poll = pollResponseSchema.parse(await (await pollReq({})).json());
    const delivery = poll.deliveries[0]!;

    const res = await reportReq(delivery.runToken, {
      runId: delivery.runId,
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
    expect(await db.select().from(runLeases)).toHaveLength(0); // lease consumed
  });
});

describe("R6: protocol version is decided at claim time, not run-creation time", () => {
  it("a pre-upgrade pending run claims as v0 (explicit mint, no DDL reliance)", async () => {
    const machineId = await fresh();
    // A run row that predates any Phase 4 concept: no lease, plain pending.
    await seedLoop(db, { id: "loop-1", machineId });
    await seedRun(db, { id: "run-legacy", machineId, ts: "2026-06-01T00:00:00.000Z" });

    const poll = pollResponseSchema.parse(
      await (await pollReq({ capabilities: ["terminal-journal-v1"] })).json(),
    );
    expect(poll.deliveries).toHaveLength(1);
    expect(poll.deliveries[0]!.runId).toBe("run-legacy");

    const [lease] = await db.select().from(runLeases).where(eq(runLeases.tokenHash, sha256(poll.deliveries[0]!.runToken)));
    expect(lease.terminalProtocolVersion).toBe(0);
    expect(lease.goalRevision).toBe(0);
    expect(lease.canFinish).toBe(false);

    // And its report follows Phase 3 semantics end to end.
    const res = await reportReq(poll.deliveries[0]!.runToken, { ok: true, message: "legacy done" });
    expect(res.status).toBe(200);
    const [loop] = await db.select().from(loops).where(eq(loops.id, "loop-1"));
    expect(loop.completedAt).toBeNull();
  });
});

describe("SP-1 regression: pathologically deep terminal state is a stable 400, never a 500", () => {
  it("a 20k-deep state body is rejected at the wire and the lease is NOT consumed", async () => {
    const machineId = await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    await seedRun(db, { id: "run-1", machineId });

    const poll = pollResponseSchema.parse(await (await pollReq({})).json());
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
