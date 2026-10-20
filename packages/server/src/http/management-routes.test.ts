/**
 * The management HTTP surface under the slice-5 gate (ADR-011 决策 23/25):
 * MG1 (anonymous rejection on EVERY management route + the two exemptions),
 * MG6 (cross-team / unclaimed / missing writes are the flat 404 with ZERO
 * business writes), MG7 (the same for reads).
 *
 * The world is POPULATED on purpose (runs, a lease, a manifest, a blob): a
 * snapshot compare over empty tables proves nothing (#123).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createLoopAdmin } from "../admin/index.js";
import { createArtifactApi } from "../artifact/api.js";
import { createAuthModule } from "../auth/index.js";
import { createMemoryBlobStore } from "../artifact/blob-store-memory.js";
import { createRunCoordinator } from "../coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { createLifecycleAdmin } from "../loop-lifecycle/admin.js";
import { createOwnerControl } from "../owner/index.js";
import { createScheduleAdmin } from "../schedule/index.js";
import {
  createTestManagementAccess,
  FakeClock,
  makeTestAuthConfig,
  seedArtifactBlob,
  seedArtifactManifest,
  seedArtifactSyncSession,
  seedLease,
  seedLoop,
  seedMachine,
  seedManagementSession,
  seedRun,
  snapshotBusinessState,
  snapshotIdentityState,
  staticAttribution,
  testDeps,
  TEST_TEAM_ID,
  withManagementSession,
} from "../testkit/index.js";
import { createServerApp } from "./app.js";

const TEAM_B = "t-ffffffffffffffff";
const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

interface Rig {
  db: Db;
  raw: ReturnType<typeof createServerApp>;
  app: ReturnType<typeof createServerApp>;
}

async function fresh(): Promise<Rig> {
  const handle = await openMigratedDb();
  handles.push(handle);
  const db = handle.db;
  const clock = new FakeClock();

  // Team A (the session's team) with a fully populated loop.
  const { credential } = await seedManagementSession(db, { clock });
  await seedMachine(db, "m-aaaaaaaaaaaaaaaa", { teamId: TEST_TEAM_ID });
  await seedLoop(db, { id: "loop-a", machineId: "m-aaaaaaaaaaaaaaaa" });
  await seedRun(db, { id: "run-a", loopId: "loop-a", machineId: "m-aaaaaaaaaaaaaaaa", phase: "pending" });
  await seedLease(db, { tokenHash: "hash-of-a-run-credential", runId: "run-a", loopId: "loop-a", machineId: "m-aaaaaaaaaaaaaaaa" });

  // Team B — a different owner, a resolvable machine and loop.
  await seedManagementSession(db, { clock, githubUserId: "222", teamId: TEAM_B, username: "other" });
  await seedMachine(db, "m-bbbbbbbbbbbbbbbb", { teamId: TEAM_B });
  await seedLoop(db, { id: "loop-b", machineId: "m-bbbbbbbbbbbbbbbb" });
  await seedRun(db, { id: "run-b", loopId: "loop-b", machineId: "m-bbbbbbbbbbbbbbbb", phase: "pending" });

  // Unclaimed — the pre-slice-4 shape.
  await seedMachine(db, "m-cccccccccccccccc");
  await seedLoop(db, { id: "loop-u", machineId: "m-cccccccccccccccc" });
  await seedRun(db, { id: "run-u", loopId: "loop-u", machineId: "m-cccccccccccccccc", phase: "pending" });

  // An artifact history on team A, so the reads have something to serve.
  const store = createMemoryBlobStore();
  const blob = await seedArtifactBlob(db, store, {
    namespaceId: TEST_TEAM_ID,
    bytes: new TextEncoder().encode("management route bytes"),
  });
  await seedArtifactManifest(db, {
    id: "amf-a",
    namespaceId: TEST_TEAM_ID,
    machineId: "m-aaaaaaaaaaaaaaaa",
    loopId: "loop-a",
    entries: [{ path: "a.txt", hash: blob.hash, size: blob.size }],
  });
  await seedRun(db, { id: "run-a-bound", loopId: "loop-a", machineId: "m-aaaaaaaaaaaaaaaa", artifactSnapshotId: "amf-a" });

  // Committed and pending sync sessions across ALL THREE worlds. The zero-write
  // oracle snapshots `artifact_sync_sessions`, and the table was empty here and
  // in the E2E: an empty table cannot prove a refusal left a receipt (UPDATE)
  // or a pending session (DELETE) alone. One committed row per team plus a
  // pending row on the unclaimed machine closes that hole.
  await seedArtifactSyncSession(db, {
    id: "sync-a",
    namespaceId: TEST_TEAM_ID,
    machineId: "m-aaaaaaaaaaaaaaaa",
    loopId: "loop-a",
    requestId: "req-a",
    normalizedManifest: [{ path: "a.txt", hash: blob.hash, size: blob.size }],
    negotiatedHashes: [blob.hash],
    receipt: { artifactSnapshotId: "amf-a", manifestRevision: 1 },
  });
  await seedArtifactManifest(db, { id: "amf-b", namespaceId: TEAM_B, machineId: "m-bbbbbbbbbbbbbbbb", loopId: "loop-b" });
  await seedArtifactSyncSession(db, {
    id: "sync-b",
    namespaceId: TEAM_B,
    machineId: "m-bbbbbbbbbbbbbbbb",
    loopId: "loop-b",
    requestId: "req-b",
    receipt: { artifactSnapshotId: "amf-b", manifestRevision: 1 },
  });
  await seedArtifactManifest(db, {
    id: "amf-u",
    namespaceId: "m-cccccccccccccccc",
    machineId: "m-cccccccccccccccc",
    loopId: "loop-u",
  });
  await seedArtifactSyncSession(db, {
    id: "sync-u",
    namespaceId: "m-cccccccccccccccc",
    machineId: "m-cccccccccccccccc",
    loopId: "loop-u",
    requestId: "req-u",
    // PENDING on purpose: the unclaimed world's in-flight session is the row a
    // "clean up on refusal" bug would delete.
    receipt: null,
  });

  const auth = createAuthModule({
    authConfig: makeTestAuthConfig(),
    db,
    clock,
    fetchImpl: (() => {
      throw new Error("unexpected GitHub call");
    }) as unknown as typeof fetch,
  });
  const raw = createServerApp({
    coordinator: createRunCoordinator(testDeps(db, clock)),
    admin: createLoopAdmin({ db, clock, newLoopId: () => `loop-${Date.now()}` }),
    lifecycle: createLifecycleAdmin({ db, clock }),
    schedule: createScheduleAdmin({ db, clock }),
    ownerControl: createOwnerControl({ db, clock }),
    management: createTestManagementAccess(db, clock),
    artifacts: createArtifactApi({
      db,
      clock,
      ids: { syncId: () => "sync-1", manifestId: () => "amf-new" },
      blobStore: store,
      attribution: staticAttribution({ "m-aaaaaaaaaaaaaaaa": TEST_TEAM_ID }),
    }),
    auth: auth.routes,
  });
  return { db, raw, app: withManagementSession(raw, credential) };
}

const json = (cookie: string) => ({
  "content-type": "application/json",
  cookie: `loopzhb_session=${cookie}`,
});

const sessionCookie = async (db: Db, clock = new FakeClock()): Promise<string> =>
  (await seedManagementSession(db, { clock })).credential;

describe("MG1: every management route is Session-gated", () => {
  it("anonymous calls are 401 not authenticated, including unknown /api paths", async () => {
    const { raw } = await fresh();
    const probes: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/machines"],
      ["GET", "/api/loops"],
      ["GET", "/api/loops/loop-a/runs"],
      ["POST", "/api/loops"],
      ["POST", "/api/loops/loop-a/run"],
      ["POST", "/api/runs/run-a/cancel"],
      ["PATCH", "/api/loops/loop-a/schedule"],
      ["PATCH", "/api/loops/loop-a/goal"],
      ["PATCH", "/api/loops/loop-a/task-file"],
      ["POST", "/api/loops/loop-a/reopen"],
      ["PATCH", "/api/loops/loop-a/artifact-dir"],
      ["GET", "/api/loops/loop-a/artifacts"],
      ["GET", "/api/runs/run-a-bound/artifacts"],
      ["GET", "/api/loops/loop-a/artifacts/diff?to=amf-a"],
      ["GET", "/api/loops/loop-a/artifacts/download?snapshotId=amf-a&path=a.txt"],
      ["GET", "/api/unknown"],
    ];
    for (const [method, path] of probes) {
      const res = await raw.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json(), `${method} ${path}`).toEqual({ error: "not authenticated" });
    }
  });

  it("the exemptions keep their own surfaces", async () => {
    const { raw } = await fresh();
    expect((await raw.request("/api/session")).status).toBe(401);
    const machine = await raw.request("/api/machine/poll", { method: "POST" });
    expect(machine.status).toBe(401);
    expect(await machine.json()).toEqual({ error: "invalid machine credential" });
  });

  it("an authenticated caller reaches the route (the 401 is the gate, not an unmounted path)", async () => {
    const { app, db } = await fresh();
    const credential = await sessionCookie(db);
    const res = await app.request("/api/loops", { headers: json(credential) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loops: Array<{ id: string }> };
    expect(body.loops.map((l) => l.id)).toEqual(["loop-a"]);
  });
});

describe("MG6/MG7: cross-team and unclaimed resources are the flat 404", () => {
  it("every loop/run-scoped write refuses foreign, unclaimed and missing ids byte-identically to /nope", async () => {
    const rig = await fresh();
    const credential = await sessionCookie(rig.db);
    const canonical = await (await rig.app.request("/nope")).text();

    const write = (method: string, path: string, body: unknown = {}) =>
      method === "GET" || method === "HEAD"
        ? rig.app.request(path, { method, headers: json(credential) })
        : rig.app.request(path, { method, headers: json(credential), body: JSON.stringify(body) });

    for (const id of ["loop-b", "loop-u", "loop-missing"]) {
      const calls: ReadonlyArray<readonly [string, string]> = [
        ["POST", `/api/loops/${id}/run`],
        ["PATCH", `/api/loops/${id}/schedule`],
        ["PATCH", `/api/loops/${id}/goal`],
        ["PATCH", `/api/loops/${id}/task-file`],
        ["POST", `/api/loops/${id}/reopen`],
        ["PATCH", `/api/loops/${id}/artifact-dir`],
        ["GET", `/api/loops/${id}/runs`],
        ["GET", `/api/loops/${id}/artifacts`],
        ["GET", `/api/loops/${id}/artifacts/diff?to=amf-a`],
        ["GET", `/api/loops/${id}/artifacts/download?snapshotId=amf-a&path=a.txt`],
      ];
      for (const [method, path] of calls) {
        const res = await write(method, path);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text(), `${method} ${path}`).toBe(canonical);
      }
    }

    for (const id of ["run-b", "run-u", "run-missing"]) {
      for (const [method, path] of [
        ["POST", `/api/runs/${id}/cancel`],
        ["GET", `/api/runs/${id}/artifacts`],
      ] as const) {
        const res = await write(method, path);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text(), `${method} ${path}`).toBe(canonical);
      }
    }
  });

  it("those refusals write NOTHING (business + identity snapshots are item-equal)", async () => {
    const rig = await fresh();
    const credential = await sessionCookie(rig.db);
    const beforeBusiness = await snapshotBusinessState(rig.db);
    const beforeIdentity = await snapshotIdentityState(rig.db);

    for (const id of ["loop-b", "loop-u", "loop-missing"]) {
      for (const [method, path] of [
        ["POST", `/api/loops/${id}/run`],
        ["PATCH", `/api/loops/${id}/schedule`],
        ["PATCH", `/api/loops/${id}/goal`],
        ["PATCH", `/api/loops/${id}/task-file`],
        ["POST", `/api/loops/${id}/reopen`],
        ["PATCH", `/api/loops/${id}/artifact-dir`],
      ] as const) {
        await rig.app.request(path, {
          method,
          headers: json(credential),
          body: JSON.stringify({ cron: "0 10 * * *", goal: "g", taskFile: "/t/T", artifactDir: "/a", enabled: true }),
        });
      }
    }
    for (const id of ["run-b", "run-u", "run-missing"]) {
      await rig.app.request(`/api/runs/${id}/cancel`, { method: "POST", headers: json(credential), body: "{}" });
    }

    expect(await snapshotBusinessState(rig.db)).toEqual(beforeBusiness);
    expect(await snapshotIdentityState(rig.db)).toEqual(beforeIdentity);
  });

  it("POST /api/loops refuses foreign, unclaimed and missing machines with zero writes", async () => {
    const rig = await fresh();
    const credential = await sessionCookie(rig.db);
    const before = await snapshotBusinessState(rig.db);

    for (const machineId of ["m-bbbbbbbbbbbbbbbb", "m-cccccccccccccccc", "m-dddddddddddddddd"]) {
      const res = await rig.app.request("/api/loops", {
        method: "POST",
        headers: json(credential),
        body: JSON.stringify({ machineId, taskFile: "/srv/TASK.md" }),
      });
      expect(res.status, machineId).toBe(404);
      expect(await res.json(), machineId).toEqual({ error: "not found" });
    }
    expect(await snapshotBusinessState(rig.db)).toEqual(before);

    // The own team's machine still creates.
    const ok = await rig.app.request("/api/loops", {
      method: "POST",
      headers: json(credential),
      body: JSON.stringify({ machineId: "m-aaaaaaaaaaaaaaaa", taskFile: "/srv/TASK.md" }),
    });
    expect(ok.status).toBe(201);
  });

  it("the artifact download of another team's blob is refused before any bytes are served", async () => {
    const rig = await fresh();
    const credential = await sessionCookie(rig.db);
    const res = await rig.app.request("/api/loops/loop-b/artifacts/download?snapshotId=amf-a&path=a.txt", {
      headers: json(credential),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await (await rig.app.request("/nope")).text());
  });
});

describe("MG7: lists never leak another team or the unclaimed world", () => {
  it("machines, loops and run lists are team-scoped", async () => {
    const rig = await fresh();
    const credential = await sessionCookie(rig.db);
    const machines = (await (await rig.app.request("/api/machines", { headers: json(credential) })).json()) as {
      machines: Array<{ id: string }>;
    };
    const loops = (await (await rig.app.request("/api/loops", { headers: json(credential) })).json()) as {
      loops: Array<{ id: string }>;
    };
    const runs = (await (await rig.app.request("/api/loops/loop-a/runs", { headers: json(credential) })).json()) as {
      runs: Array<{ id: string }>;
    };

    expect(machines.machines.map((m) => m.id)).toEqual(["m-aaaaaaaaaaaaaaaa"]);
    expect(loops.loops.map((l) => l.id)).toEqual(["loop-a"]);
    expect(new Set(runs.runs.map((r) => r.id))).toEqual(new Set(["run-a", "run-a-bound"]));
  });
});

describe("MG1: authentication precedes body validation", () => {
  it("an anonymous oversized/malformed write is 401, not 400/413", async () => {
    const { raw } = await fresh();
    const res = await raw.request("/api/loops/loop-a/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(401);
  });
});
