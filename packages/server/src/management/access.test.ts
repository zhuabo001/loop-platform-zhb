/**
 * Management Access (Phase 5 Batch 3 slice 5, ADR-011 决策 23/25/27):
 * MG1 (anonymous rejection + exemptions), MG2 (session expiry / broken
 * identity chain), MG10 (credential types never mix), plus the Hono path-param
 * binding the ownership gates rely on.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionService } from "../auth/session.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { users } from "../db/schema.js";
import { jsonError } from "../http/json-error.js";
import {
  FakeClock,
  seedClaimedMachineById,
  seedClaimedMachineForToken,
  seedLoop,
  seedMachine,
  seedMembership,
  seedRun,
  seedSession,
  seedTeam,
  seedUser,
  TEST_TEAM_ID,
} from "../testkit/index.js";
import { createManagementAccess, isManagementExempt, MANAGEMENT_TEAM_KEY, type ManagementEnv } from "./access.js";

const handles: DbHandle[] = [];
const MACHINE_TOKEN = "dk_management_gate_machine_1";
const COOKIE = (credential: string) => `loopzhb_session=${credential}`;

afterEach(async () => {
  for (const handle of handles.splice(0)) await closeDb(handle);
});

interface Rig {
  db: Db;
  clock: FakeClock;
  credential: string;
  app: Hono<ManagementEnv>;
}

async function fresh(): Promise<Rig> {
  const handle = await openMigratedDb();
  handles.push(handle);
  const db = handle.db;
  const clock = new FakeClock();

  const userId = await seedUser(db, { id: "424242" });
  await seedTeam(db, { id: TEST_TEAM_ID, ownerUserId: userId });
  await seedMembership(db, { userId, teamId: TEST_TEAM_ID });
  const { credential } = await seedSession(db, { userId, credential: "sk_management_gate_1" });

  await seedClaimedMachineForToken(db, MACHINE_TOKEN);
  // The ownership fixtures: own team, another team, and unclaimed.
  await seedClaimedMachineById(db, "m-own");
  await seedMachine(db, "m-foreign", { teamId: "t-ffffffffffffffff" });
  await seedMachine(db, "m-unclaimed");
  await seedLoop(db, { id: "loop-own", machineId: "m-own" });
  await seedLoop(db, { id: "loop-foreign", machineId: "m-foreign" });
  await seedLoop(db, { id: "loop-unclaimed", machineId: "m-unclaimed" });
  await seedRun(db, { id: "run-own", loopId: "loop-own", machineId: "m-own" });
  await seedRun(db, { id: "run-foreign", loopId: "loop-foreign", machineId: "m-foreign" });

  const access = createManagementAccess({ db, sessions: createSessionService({ db, clock }) });
  const app = new Hono<ManagementEnv>();
  app.use("/api/*", access.sessionGate);
  app.use("/api/loops/:id", access.loopGate);
  app.use("/api/loops/:id/*", access.loopGate);
  app.use("/api/runs/:id", access.runGate);
  app.use("/api/runs/:id/*", access.runGate);
  app.get("/api/machines", (c) => c.json({ teamId: c.get(MANAGEMENT_TEAM_KEY) }));
  app.get("/api/loops", (c) => c.json({ teamId: c.get(MANAGEMENT_TEAM_KEY) }));
  app.get("/api/session", (c) => c.json({ error: "not authenticated" }, 401));
  app.post("/api/machine/poll", (c) =>
    c.req.header("authorization") === `Bearer ${MACHINE_TOKEN}`
      ? c.json({ ok: true })
      : jsonError(c, 401, "invalid machine credential"),
  );
  app.post("/api/loops/:id/run", (c) => c.json({ id: c.req.param("id") }));
  app.post("/api/runs/:id/cancel", (c) => c.json({ id: c.req.param("id") }));
  app.notFound((c) => jsonError(c, 404, "not found"));

  return { db, clock, credential, app };
}

describe("isManagementExempt", () => {
  it("exempts ONLY /api/session and /api/machine(+slash)", () => {
    expect(isManagementExempt("/api/session")).toBe(true);
    expect(isManagementExempt("/api/machine")).toBe(true);
    expect(isManagementExempt("/api/machine/poll")).toBe(true);
    expect(isManagementExempt("/api/machine/blob/abc")).toBe(true);
    // The trap: the machine LIST shares the prefix but not the slash.
    expect(isManagementExempt("/api/machines")).toBe(false);
    expect(isManagementExempt("/api/machines/anything")).toBe(false);
    expect(isManagementExempt("/api/loops")).toBe(false);
    expect(isManagementExempt("/api/loops/loop-1/run")).toBe(false);
  });
});

describe("MG1: anonymous management requests are rejected", () => {
  it("401 not authenticated on every management route, including unknown /api paths", async () => {
    const { app } = await fresh();
    for (const path of ["/api/machines", "/api/loops", "/api/loops/loop-own/runs", "/api/unknown"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual({ error: "not authenticated" });
    }
    // Ownership gates never run without a session team (fail-closed).
    expect((await app.request("/api/loops/loop-own/run", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/runs/run-own/cancel", { method: "POST" })).status).toBe(401);
  });

  it("leaves /api/session and /api/machine/* to their own credential surfaces", async () => {
    const { app } = await fresh();
    expect((await app.request("/api/session")).status).toBe(401); // its own handler
    expect((await app.request("/api/machine/poll", { method: "POST" })).status).toBe(401); // invalid machine credential
    expect(
      (await app.request("/api/machine/poll", { method: "POST", headers: { authorization: `Bearer ${MACHINE_TOKEN}` } })).status,
    ).toBe(200);
  });
});

describe("MG2: session validity", () => {
  it("accepts a live session and carries its team to the route", async () => {
    const { app, credential } = await fresh();
    const res = await app.request("/api/machines", { headers: { cookie: COOKIE(credential) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teamId: TEST_TEAM_ID });
  });

  it("rejects at the exact expiry instant and accepts one ms before", async () => {
    const { app, credential, clock } = await fresh();
    clock.advance(7 * 24 * 3600 * 1000 - 1);
    expect((await app.request("/api/machines", { headers: { cookie: COOKIE(credential) } })).status).toBe(200);
    clock.advance(1);
    expect((await app.request("/api/machines", { headers: { cookie: COOKIE(credential) } })).status).toBe(401);
  });

  it("rejects unknown, empty and malformed credentials; a broken identity chain logs out", async () => {
    const rig = await fresh();
    const db = rig.db;
    for (const cookie of ["loopzhb_session=", "loopzhb_session=sk_nope", "garbage"]) {
      expect((await rig.app.request("/api/loops", { headers: { cookie } })).status).toBe(401);
    }
    // Remove the user row: the session row still exists, the chain does not.
    await db.delete(users).where(eq(users.id, "424242"));
    expect((await rig.app.request("/api/loops", { headers: { cookie: COOKIE(rig.credential) } })).status).toBe(401);
  });
});

describe("MG10: credential types do not mix", () => {
  it("a machine Bearer does NOT authenticate management routes", async () => {
    const { app } = await fresh();
    const res = await app.request("/api/loops", { headers: { authorization: `Bearer ${MACHINE_TOKEN}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not authenticated" });
  });

  it("a session cookie does NOT authenticate the machine surface", async () => {
    const { app, credential } = await fresh();
    const res = await app.request("/api/machine/poll", { method: "POST", headers: { cookie: COOKIE(credential) } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid machine credential" });
  });

  it("carrying both credentials grants each surface only its own", async () => {
    const { app, credential } = await fresh();
    const both = { cookie: COOKIE(credential), authorization: `Bearer ${MACHINE_TOKEN}` };
    expect((await app.request("/api/loops", { headers: both })).status).toBe(200);
    expect((await app.request("/api/machine/poll", { method: "POST", headers: both })).status).toBe(200);
  });
});

describe("ownership gates (MG6/MG7 shape)", () => {
  it("passes the loop id through to the handler and 404s every other owner", async () => {
    const rig = await fresh();
    const own = await rig.app.request("/api/loops/loop-own/run", {
      method: "POST",
      headers: { cookie: COOKIE(rig.credential) },
    });
    // Proves the middleware READ the id: a broken param binding 404s here too.
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ id: "loop-own" });

    for (const id of ["loop-foreign", "loop-unclaimed", "loop-missing"]) {
      const res = await rig.app.request(`/api/loops/${id}/run`, {
        method: "POST",
        headers: { cookie: COOKIE(rig.credential) },
      });
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ error: "not found" });
    }
  });

  it("protects run paths through the run's loop", async () => {
    const rig = await fresh();
    const own = await rig.app.request("/api/runs/run-own/cancel", {
      method: "POST",
      headers: { cookie: COOKIE(rig.credential) },
    });
    expect(own.status).toBe(200);
    expect(
      (await rig.app.request("/api/runs/run-missing/cancel", { method: "POST", headers: { cookie: COOKIE(rig.credential) } }))
        .status,
    ).toBe(404);
  });
});
