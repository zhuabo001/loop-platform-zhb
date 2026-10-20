/**
 * Phase 5 Batch 3 slice 5 E2E — through the PRODUCTION composition root
 * (`bootstrapServer`, file-backed PGlite, real BlobStore) rather than a
 * hand-built app. MG9 is the focus: an Unclaimed Machine's history stays
 * exactly as it was, it is invisible to every management entry, and no
 * management call can add or supersede a Run on it.
 *
 * In-process `app.request` per the slice decision (D3); the real-HTTP upgrade
 * drill remains slice 7's BI1–BI6.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, type Db } from "./db/index.js";
import { bootstrapServer, type BootedServer } from "./start.js";
import {
  FakeClock,
  makeTestAuthConfig,
  seedLease,
  seedLoop,
  seedMachine,
  seedManagementSession,
  seedRun,
  snapshotBusinessState,
  snapshotIdentityState,
  TEST_TEAM_ID,
} from "./testkit/index.js";

const TEAM_B = "t-ffffffffffffffff";
const MACHINE_A = "m-aaaaaaaaaaaaaaaa";
const MACHINE_B = "m-bbbbbbbbbbbbbbbb";
const MACHINE_U = "m-cccccccccccccccc";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

interface World {
  booted: BootedServer;
  db: Db;
  credential: string;
  clock: FakeClock;
}

async function boot(): Promise<World> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-slice5-e2e-${process.pid}-`));
  const clock = new FakeClock(new Date("2026-10-20T00:00:00.000Z"));
  const booted = await bootstrapServer(
    { auth: makeTestAuthConfig(), host: "127.0.0.1", port: 0, dataDir },
    { clock },
  );
  cleanups.push(async () => {
    await closeDb(booted.handle);
    await rm(dataDir, { recursive: true, force: true });
  });
  const db = booted.handle.db;

  // Team A = the session's team; team B exists without a session; one machine
  // is UNCLAIMED. All three carry a populated history.
  const { credential } = await seedManagementSession(db, { clock });
  await seedMachine(db, MACHINE_A, { teamId: TEST_TEAM_ID });
  await seedLoop(db, { id: "loop-a", machineId: MACHINE_A });
  await seedRun(db, { id: "run-a", loopId: "loop-a", machineId: MACHINE_A, phase: "pending" });

  await seedManagementSession(db, { clock, githubUserId: "222", teamId: TEAM_B, username: "other" });
  await seedMachine(db, MACHINE_B, { teamId: TEAM_B });
  await seedLoop(db, { id: "loop-b", machineId: MACHINE_B });
  await seedRun(db, { id: "run-b", loopId: "loop-b", machineId: MACHINE_B, phase: "pending" });

  await seedMachine(db, MACHINE_U);
  await seedLoop(db, { id: "loop-u", machineId: MACHINE_U });
  await seedRun(db, { id: "run-u", loopId: "loop-u", machineId: MACHINE_U, phase: "pending" });
  await seedLease(db, { tokenHash: "hash-u-run", runId: "run-u", loopId: "loop-u", machineId: MACHINE_U });

  return { booted, db, credential, clock };
}

const headers = (credential: string) => ({
  "content-type": "application/json",
  cookie: `loopzhb_session=${credential}`,
});

const jsonBody = (credential: string, body: unknown = {}) => ({
  method: "POST",
  headers: headers(credential),
  body: JSON.stringify(body),
});

describe("slice 5 E2E: the production root is Session-gated and team-scoped", () => {
  it("anonymous management calls are 401 at the REAL bootstrap; /api/session stays a 401 probe", async () => {
    const { booted } = await boot();
    for (const path of ["/api/machines", "/api/loops", "/api/loops/loop-a/runs"]) {
      const res = await booted.app.request(path);
      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual({ error: "not authenticated" });
    }
    expect((await booted.app.request("/api/session")).status).toBe(401);
  });

  it("team A sees only its own machine/loop/run; B and the unclaimed world are invisible", async () => {
    const { booted, credential } = await boot();
    const machines = (await (await booted.app.request("/api/machines", { headers: headers(credential) })).json()) as {
      machines: Array<{ id: string }>;
    };
    const loops = (await (await booted.app.request("/api/loops", { headers: headers(credential) })).json()) as {
      loops: Array<{ id: string }>;
    };
    const runs = (await (await booted.app.request("/api/loops/loop-a/runs", { headers: headers(credential) })).json()) as {
      runs: Array<{ id: string }>;
    };
    expect(machines.machines.map((m) => m.id)).toEqual([MACHINE_A]);
    expect(loops.loops.map((l) => l.id)).toEqual(["loop-a"]);
    expect(runs.runs.map((r) => r.id)).toEqual(["run-a"]);
  });

  it("MG9: the unclaimed machine's whole history survives cross-scope refusals byte for byte", async () => {
    const { booted, db, credential } = await boot();
    const beforeBusiness = await snapshotBusinessState(db);
    const beforeIdentity = await snapshotIdentityState(db);

    const canonical = await (await booted.app.request("/nope")).text();
    for (const loopId of ["loop-u", "loop-b", "loop-missing"]) {
      for (const [method, path, body] of [
        ["POST", `/api/loops/${loopId}/run`, {}],
        ["PATCH", `/api/loops/${loopId}/schedule`, { cron: "0 10 * * *" }],
        ["PATCH", `/api/loops/${loopId}/goal`, { goal: "new goal" }],
        ["PATCH", `/api/loops/${loopId}/task-file`, { taskFile: "/srv/NEW.md" }],
        ["POST", `/api/loops/${loopId}/reopen`, {}],
        ["GET", `/api/loops/${loopId}/runs`, null],
        ["GET", `/api/loops/${loopId}/artifacts`, null],
        ["GET", `/api/loops/${loopId}/artifacts/diff?to=amf-x`, null],
      ] as const) {
        const res =
          method === "GET"
            ? await booted.app.request(path, { headers: headers(credential) })
            : await booted.app.request(path, {
                method,
                headers: headers(credential),
                body: JSON.stringify(body),
              });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text(), `${method} ${path}`).toBe(canonical);
      }
    }
    for (const runId of ["run-u", "run-b"]) {
      const res = await booted.app.request(`/api/runs/${runId}/cancel`, jsonBody(credential));
      expect(res.status, runId).toBe(404);
    }

    // Not one row moved — including the unclaimed pending Run and its lease.
    expect(await snapshotBusinessState(db)).toEqual(beforeBusiness);
    expect(await snapshotIdentityState(db)).toEqual(beforeIdentity);
  });

  it("team A still acts on its own loop: a trigger enqueues exactly one run", async () => {
    const { booted, credential } = await boot();
    const res = await booted.app.request("/api/loops/loop-a/run", jsonBody(credential));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { enqueued: boolean; runId: string };
    expect(body.enqueued).toBe(true);
    // The pre-existing pending run was superseded (T7), not silently kept.
    const runs = (await (await booted.app.request("/api/loops/loop-a/runs", { headers: headers(credential) })).json()) as {
      runs: Array<{ id: string; phase: string }>;
    };
    const phases = new Map(runs.runs.map((r) => [r.id, r.phase]));
    expect(phases.get("run-a")).toBe("canceled");
    expect(phases.get(body.runId)).toBe("pending");
  });

  it("a foreign/unknown session sees nothing and cannot act", async () => {
    const { booted, db, clock } = await boot();
    const b = await seedManagementSession(db, { clock, githubUserId: "222", teamId: TEAM_B, username: "other" });
    const lists = (await (await booted.app.request("/api/loops", { headers: headers(b.credential) })).json()) as {
      loops: Array<{ id: string }>;
    };
    expect(lists.loops.map((l) => l.id)).toEqual(["loop-b"]);
    const refused = await booted.app.request("/api/loops/loop-a/run", jsonBody(b.credential));
    expect(refused.status).toBe(404);
  });
});
