/**
 * Phase 5 Batch 3 slice 6 E2E — through the PRODUCTION composition root
 * (`bootstrapServer`, file-backed PGlite, real login routes, scripted GitHub
 * adapter). DG1–DG6 with three logged-in users (A, B, empty-team C) and one
 * Unclaimed Machine:
 *
 *  DG1 anonymous GET → 303 /login;
 *  DG2 anonymous POST → 401 with zero writes;
 *  DG3 A sees only A's loops, with the account block;
 *  DG4 B's and U's pages are the flat 404 white-to-white;
 *  DG5 a token from another Session is refused;
 *  DG6 logout revokes the current Session only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OAUTH_TX_COOKIE, SESSION_COOKIE } from "./auth/cookies.js";
import { deriveSessionCsrfToken } from "./auth/session-csrf.js";
import { closeDb, type Db } from "./db/index.js";
import { bootstrapServer, type BootedServer } from "./start.js";
import {
  FakeClock,
  makeTestAuthConfig,
  seedLoop,
  seedMachine,
  seedRun,
  setCookieValue,
  snapshotBusinessState,
  snapshotIdentityState,
} from "./testkit/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

interface World {
  booted: BootedServer;
  db: Db;
  clock: FakeClock;
  loginAs: (id: number, login: string) => Promise<string>;
  credentials: Record<"a" | "b" | "c", string>;
}

async function boot(): Promise<World> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-slice6-e2e-${process.pid}-`));
  const clock = new FakeClock(new Date("2026-10-20T00:00:00.000Z"));
  // One adapter, one mutable identity: the logins in this file are sequential.
  let nextIdentity = { id: 424242, login: "alice" };
  const githubFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_e2e", token_type: "bearer" }), { status: 200 });
    }
    return new Response(JSON.stringify(nextIdentity), { status: 200 });
  }) as typeof fetch;

  const booted = await bootstrapServer(
    { auth: makeTestAuthConfig(), host: "127.0.0.1", port: 0, dataDir },
    { clock, githubFetch },
  );
  cleanups.push(async () => {
    await closeDb(booted.handle);
    await rm(dataDir, { recursive: true, force: true });
  });

  const loginAs = async (id: number, login: string): Promise<string> => {
    nextIdentity = { id, login };
    const start = await booted.app.request("/auth/github");
    expect(start.status).toBe(303);
    const txId = setCookieValue(start, OAUTH_TX_COOKIE)!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await booted.app.request(`/auth/github/callback?code=e2e&state=${state}`, {
      headers: { cookie: `${OAUTH_TX_COOKIE}=${txId}` },
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/");
    const credential = setCookieValue(callback, SESSION_COOKIE);
    expect(credential).toBeTruthy();
    return credential!;
  };

  // The fake adapter's identity is swapped per login; log in A, B and C.
  const a = await loginAs(424242, "alice");
  const b = await loginAs(222, "bob");
  const c = await loginAs(333, "carol");

  // Read the three team ids from the API (the session is the only authority).
  const teamIdOf = async (credential: string): Promise<string> => {
    const res = await booted.app.request("/api/session", { headers: { cookie: `${SESSION_COOKIE}=${credential}` } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { team: { id: string } }).team.id;
  };
  const teamA = await teamIdOf(a);
  const teamB = await teamIdOf(b);

  // A populated world: A and B each own one machine+loop; U is unclaimed.
  await seedMachine(booted.handle.db, "m-aaaaaaaaaaaaaaaa", { teamId: teamA });
  await seedLoop(booted.handle.db, { id: "loop-a", machineId: "m-aaaaaaaaaaaaaaaa", name: "A 的 Loop" });
  await seedRun(booted.handle.db, {
    id: "run-a",
    loopId: "loop-a",
    machineId: "m-aaaaaaaaaaaaaaaa",
    phase: "pending",
  });

  await seedMachine(booted.handle.db, "m-bbbbbbbbbbbbbbbb", { teamId: teamB });
  await seedLoop(booted.handle.db, { id: "loop-b", machineId: "m-bbbbbbbbbbbbbbbb", name: "B 的 Loop" });

  await seedMachine(booted.handle.db, "m-cccccccccccccccc"); // unclaimed
  await seedLoop(booted.handle.db, { id: "loop-u", machineId: "m-cccccccccccccccc", name: "U 的 Loop" });

  // C owns an empty team — asserted below through the page.
  return { booted, db: booted.handle.db, clock, loginAs, credentials: { a, b, c } };
}

const cookie = (credential: string) => `${SESSION_COOKIE}=${credential}`;

function formFrom(html: string): { action: string; token: string } {
  const action = /action="([^"]*\/run)"/.exec(html)?.[1];
  const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (action === undefined || token === undefined) throw new Error("no Run form in the rendered page");
  return { action, token };
}

describe("slice 6 E2E: the Dashboard is Session-gated and team-scoped", () => {
  it("DG1–DG6 through the real composition root", async () => {
    const { booted, db, loginAs, credentials } = await boot();
    const { a, b, c } = credentials;
    const tokenA = deriveSessionCsrfToken(a);
    const tokenB = deriveSessionCsrfToken(b);

    // ---- DG1: anonymous pages redirect to /login ----
    for (const route of ["/", "/dashboard/loops/loop-a/artifacts"]) {
      const res = await booted.app.request(route);
      expect([route, res.status]).toEqual([route, 303]);
      expect([route, res.headers.get("location")]).toEqual([route, "/login"]);
      expect(res.headers.get("set-cookie")).toBeNull();
    }

    // ---- DG2: anonymous POST is 401 with ZERO writes ----
    // BOTH halves of the oracle, captured HERE: the identity tables are
    // populated (three logins), so an UPDATE on users/teams/sessions during
    // this anonymous window would be caught. Sampling identity only at DG4
    // cannot see writes made by the rejected POSTs above.
    const beforeAnonymous = await snapshotBusinessState(db);
    const beforeAnonymousIdentity = await snapshotIdentityState(db);
    for (const route of ["/dashboard/loops/loop-a/run", "/dashboard/loops/loop-a/artifacts/config"]) {
      const res = await booted.app.request(route, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `csrf=${encodeURIComponent(tokenA)}`,
      });
      expect([route, res.status]).toEqual([route, 401]);
      expect(await res.json()).toEqual({ error: "not authenticated" });
    }
    expect(await snapshotBusinessState(db)).toEqual(beforeAnonymous);
    expect(await snapshotIdentityState(db)).toEqual(beforeAnonymousIdentity);

    // ---- DG3: A sees only A's loop and the account block ----
    const pageA = await booted.app.request("/", { headers: { cookie: cookie(a) } });
    expect(pageA.status).toBe(200);
    const htmlA = await pageA.text();
    expect(htmlA).toContain("A 的 Loop");
    expect(htmlA).not.toContain("B 的 Loop");
    expect(htmlA).not.toContain("U 的 Loop");
    expect(htmlA).toContain("当前账号：alice");
    expect(htmlA).toContain("退出登录");

    // The page token IS the session-derived token /api/session reports.
    const sessionA = (await (
      await booted.app.request("/api/session", { headers: { cookie: cookie(a) } })
    ).json()) as { csrfToken: string };
    const formA = formFrom(htmlA);
    expect(formA.token).toBe(sessionA.csrfToken);
    expect(formA.token).toBe(tokenA);

    // C owns an empty team: the claim hint, no other team's loops.
    const pageC = await booted.app.request("/", { headers: { cookie: cookie(c) } });
    const htmlC = await pageC.text();
    expect(htmlC).toContain("当前团队暂无 Loop");
    expect(htmlC).toContain("claim:legacy");
    expect(htmlC).not.toContain("A 的 Loop");

    // ---- DG4: B's and U's loops are the flat 404 for A ----
    const canonical = await (await booted.app.request("/nope")).text();
    const beforeForeign = await snapshotBusinessState(db);
    const beforeIdentity = await snapshotIdentityState(db);
    for (const loopId of ["loop-b", "loop-u", "loop-missing"]) {
      const page = await booted.app.request(`/dashboard/loops/${loopId}/artifacts`, {
        headers: { cookie: cookie(a) },
      });
      expect([loopId, page.status]).toEqual([loopId, 404]);
      expect(await page.text()).toBe(canonical);

      const write = await booted.app.request(`/dashboard/loops/${loopId}/run`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(a) },
        body: `csrf=${encodeURIComponent(tokenA)}`,
      });
      expect([loopId, write.status]).toEqual([loopId, 404]);
      expect(await write.text()).toBe(canonical);
    }
    expect(await snapshotBusinessState(db)).toEqual(beforeForeign);
    expect(await snapshotIdentityState(db)).toEqual(beforeIdentity);

    // B's own page renders B's loop.
    const pageB = await booted.app.request("/", { headers: { cookie: cookie(b) } });
    expect(await pageB.text()).toContain("B 的 Loop");

    // ---- DG5: another Session's CSRF token is refused ----
    const beforeCsrf = await snapshotBusinessState(db);
    const crossToken = await booted.app.request("/dashboard/loops/loop-a/run", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(a) },
      body: `csrf=${encodeURIComponent(tokenB)}`,
    });
    expect(crossToken.status).toBe(403);
    expect(await snapshotBusinessState(db)).toEqual(beforeCsrf);

    // B's cookie + B's token on A's loop is ownership, not CSRF: flat 404.
    const crossOwner = await booted.app.request("/dashboard/loops/loop-a/run", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(b) },
      body: `csrf=${encodeURIComponent(tokenB)}`,
    });
    expect(crossOwner.status).toBe(404);
    expect(await crossOwner.text()).toBe(canonical);

    // A's own token does act (the handler is reachable): 303.
    const own = await booted.app.request("/dashboard/loops/loop-a/run", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(a) },
      body: `csrf=${encodeURIComponent(tokenA)}`,
    });
    expect(own.status).toBe(303);

    // ---- DG6: logout revokes the CURRENT Session only ----
    // A second Session for ALICE: log in again through the same adapter.
    const secondSession = await loginAs(424242, "alice");

    // Refresh A's page token (unchanged) and log out.
    const logout = await booted.app.request("/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(a) },
      body: `csrf=${encodeURIComponent(tokenA)}`,
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("location")).toBe("/login");

    const afterLogout = await booted.app.request("/", { headers: { cookie: cookie(a) } });
    expect(afterLogout.status).toBe(303);
    expect(afterLogout.headers.get("location")).toBe("/login");
    expect(
      (await booted.app.request("/api/session", { headers: { cookie: cookie(a) } })).status,
    ).toBe(401);

    // The OTHER session (alice's second login) still works.
    expect(
      (await booted.app.request("/api/session", { headers: { cookie: cookie(secondSession) } })).status,
    ).toBe(200);
  });
});
