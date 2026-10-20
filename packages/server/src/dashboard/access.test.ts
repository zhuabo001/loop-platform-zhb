/**
 * DG1/DG2/DG4 at the gate boundary (Phase 5 Batch 3 slice 6, ADR-011 决策 29):
 * the Session gate's redirect/401 split, the loop ownership gate's flat 404,
 * and the Hono path registration the composition root relies on.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { deriveSessionCsrfToken } from "../auth/session-csrf.js";
import { createSessionService } from "../auth/session.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { jsonError } from "../http/json-error.js";
import { createDashboardAccess, type DashboardAccess, type DashboardEnv } from "./access.js";
import {
  FakeClock,
  seedLoop,
  seedMachine,
  seedManagementSession,
  seedSession,
  TEST_TEAM_ID,
} from "../testkit/index.js";

const TEAM_B = "t-ffffffffffffffff";
const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

interface Rig {
  db: Db;
  clock: FakeClock;
  access: DashboardAccess;
  app: Hono<DashboardEnv>;
  credential: string;
}

function assemble(access: DashboardAccess, withPageGate: boolean): Hono<DashboardEnv> {
  const app = new Hono<DashboardEnv>();
  if (withPageGate) {
    app.use("/", access.pageGate);
    app.use("/dashboard/*", access.pageGate);
  }
  app.use("/dashboard/loops/:id", access.loopGate);
  app.use("/dashboard/loops/:id/*", access.loopGate);

  app.get("/", (c) => c.json({ session: access.sessionOf(c) }));
  app.get("/dashboard/loops/:id/artifacts", (c) => c.text("page"));
  app.post("/dashboard/loops/:id/run", (c) => c.text("posted", 201));
  // A dashboard write that is NOT loop-scoped: only `pageGate` guards it, so
  // a pageGate regression cannot hide behind the ownership gate's 401.
  app.post("/dashboard/post", (c) => c.text("posted", 201));
  app.notFound((c) => jsonError(c, 404, "not found"));
  return app;
}

async function fresh(): Promise<Rig> {
  const h = await openMigratedDb();
  handles.push(h);
  const db = h.db;
  const clock = new FakeClock();

  await seedMachine(db, "m-test", { teamId: TEST_TEAM_ID });
  await seedLoop(db, { id: "loop-a" });
  await seedMachine(db, "m-b", { teamId: TEAM_B });
  await seedLoop(db, { id: "loop-b", machineId: "m-b" });
  await seedMachine(db, "m-u"); // unclaimed
  await seedLoop(db, { id: "loop-u", machineId: "m-u" });
  await seedLoop(db, { id: "loop-orphan", machineId: "m-absent" }); // no machine row

  const { credential } = await seedManagementSession(db, { clock });
  const access = createDashboardAccess({
    db,
    sessions: createSessionService({ db, clock }),
  });
  return { db, clock, access, app: assemble(access, true), credential };
}

const cookie = (credential: string) => `loopzhb_session=${credential}`;

describe("pageGate (DG1/DG2)", () => {
  it("redirects anonymous GET/HEAD to /login with security headers and no cookie", async () => {
    const { app } = await fresh();
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/", "/dashboard", "/dashboard/", "/dashboard/loops/loop-a", "/dashboard/loops/loop-a/artifacts"]) {
        const res = await app.request(path, { method });
        expect([method, path, res.status]).toEqual([method, path, 303]);
        expect([method, path, res.headers.get("location")]).toEqual([method, path, "/login"]);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      }
    }
  });

  it("answers every anonymous non-GET with the fixed 401 before any body handling", async () => {
    const { app } = await fresh();
    for (const path of ["/dashboard/loops/loop-a/run", "/dashboard/loops/loop-b/run", "/dashboard/post"]) {
      const res = await app.request(path, { method: "POST", body: "csrf=whatever" });
      expect([path, res.status]).toEqual([path, 401]);
      expect(await res.json()).toEqual({ error: "not authenticated" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("does not gate paths outside `/` and `/dashboard/*`", async () => {
    const { app } = await fresh();
    // `/dashboardX` is not a dashboard path; no route matches it either.
    expect((await app.request("/dashboardX/anything")).status).toBe(404);
    // `/dashboard/loops` is under the page gate (302-family), not a 404.
    expect((await app.request("/dashboard/loops")).status).toBe(303);
  });

  it("carries the resolved Session (user/team/CSRF) into the handler", async () => {
    const { app, credential } = await fresh();
    const res = await app.request("/", { headers: { cookie: cookie(credential) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { teamId: string; username: string; csrfToken: string } };
    expect(body.session.teamId).toBe(TEST_TEAM_ID);
    expect(body.session.username).toBe("tester");
    // The same derivation the login module and /api/session use.
    expect(body.session.csrfToken).toBe(deriveSessionCsrfToken(credential));
  });

  it("treats expired, unknown and broken-identity sessions as anonymous", async () => {
    const { db, clock, app } = await fresh();
    // Expired by 1ms — the resolve boundary is `now >= expiresAt`.
    await seedSession(db, {
      userId: "424242",
      credential: "sk_expired",
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() - 1).toISOString(),
    });
    await seedSession(db, {
      userId: "999999", // no users row: the identity chain is broken
      credential: "sk_broken",
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 3600_000).toISOString(),
    });

    for (const credential of ["sk_expired", "sk_broken", "sk_unknown", ""]) {
      const res = await app.request("/", { headers: { cookie: cookie(credential) } });
      expect([credential, res.status]).toEqual([credential, 303]);
      expect(res.headers.get("location")).toBe("/login");
    }
  });
});

describe("loopGate (DG4)", () => {
  async function canonical(app: Hono<DashboardEnv>): Promise<string> {
    return (await app.request("/nope")).text();
  }

  it("lets the owning team through and refuses every other world identically", async () => {
    const { app, credential } = await fresh();
    const headers = { cookie: cookie(credential) };

    expect((await app.request("/dashboard/loops/loop-a/artifacts", { headers })).status).toBe(200);

    const notFound = await canonical(app);
    for (const loopId of ["loop-b", "loop-u", "loop-orphan", "loop-missing"]) {
      const res = await app.request(`/dashboard/loops/${loopId}/artifacts`, { headers });
      expect([loopId, res.status]).toEqual([loopId, 404]);
      expect(await res.text()).toBe(notFound);
      // The flat 404 deliberately has NO dashboard headers.
      expect(res.headers.get("content-security-policy")).toBeNull();
    }

    // A write under someone else's loop is the same 404 (the handler never runs).
    const write = await app.request("/dashboard/loops/loop-b/run", { method: "POST", headers, body: "" });
    expect(write.status).toBe(404);
    expect(await write.text()).toBe(notFound);
  });

  it("passes for a session of the owning team (team B sees loop-b, not loop-a)", async () => {
    const { db, clock, app } = await fresh();
    const b = await seedManagementSession(db, { clock, githubUserId: "222", teamId: TEAM_B, username: "other" });
    const headers = { cookie: cookie(b.credential) };
    expect((await app.request("/dashboard/loops/loop-b/artifacts", { headers })).status).toBe(200);
    expect((await app.request("/dashboard/loops/loop-a/artifacts", { headers })).status).toBe(404);
  });

  it("fails closed when the Session gate did not run", async () => {
    const { access, credential } = await fresh();
    const withoutPageGate = assemble(access, false);
    const res = await withoutPageGate.request("/dashboard/loops/loop-a/artifacts", {
      headers: { cookie: cookie(credential) },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not authenticated" });
  });
});
