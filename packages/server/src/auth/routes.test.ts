/**
 * The five-route login surface (Batch 3 slice 2): AU1–AU8/AU12 and
 * SE1–SE4/SE6–SE8 at the route layer.
 *
 * Independent test assembly (the slice's stop boundary): a bare Hono app
 * mounting exactly the five handlers — production composition through
 * `createServerApp`/`bootstrapServer` is pinned separately (mount + e2e
 * tests). GitHub is a scripted in-process `fetchImpl`; time is a FakeClock.
 *
 * Conventions pinned here: every failure branch of the callback is a
 * ZERO-WRITE path (no identity row, no session, no session Set-Cookie) with
 * the tx consumed (replay → state_unknown); cookie attributes come from the
 * frozen matrix; the redirect_uri is the config-frozen callback URL,
 * uninfluenced by the request Host (AU12).
 */
import { afterEach, describe, expect, it } from "vitest";

import { Hono } from "hono";

import { sessionInfoResponseSchema } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { authSessions, memberships, teams, users } from "../db/schema.js";
import {
  FakeClock,
  FIXTURE_T0,
  makeTestAuthConfig,
  parseSetCookies,
  seedPersonalIdentity,
  seedSession,
  setCookieValue,
} from "../testkit/index.js";
import { OAUTH_TX_COOKIE, SESSION_COOKIE } from "./cookies.js";
import { createAuthModule } from "./index.js";
import { deriveSessionCsrfToken } from "./session-csrf.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

// ---- scripted GitHub ----

interface GitHubScript {
  /** Overrides for the two upstream calls; default is a healthy GitHub. */
  exchange?: Response;
  user?: Response;
  throwOn?: "exchange" | "user";
  githubUserId?: number;
  login?: string;
}

function fakeGitHub(script: GitHubScript = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      if (script.throwOn === "exchange") throw new Error("network down");
      return (
        script.exchange ??
        new Response(JSON.stringify({ access_token: "gho_test", token_type: "bearer" }), { status: 200 })
      );
    }
    if (script.throwOn === "user") throw new Error("network down");
    return (
      script.user ??
      new Response(JSON.stringify({ id: script.githubUserId ?? 424242, login: script.login ?? "tester" }), {
        status: 200,
      })
    );
  }) as typeof fetch;
}

// ---- assembly ----

interface Rig {
  app: Hono;
  db: Db;
  clock: FakeClock;
}

async function fresh(opts: { authConfig?: ReturnType<typeof makeTestAuthConfig>; github?: typeof fetch } = {}): Promise<Rig> {
  const h = await openMigratedDb();
  handles.push(h);
  const clock = new FakeClock();
  const auth = createAuthModule({
    authConfig: opts.authConfig ?? makeTestAuthConfig(),
    db: h.db,
    clock,
    fetchImpl: opts.github ?? fakeGitHub(),
  });
  const app = new Hono();
  app.get("/login", auth.loginPage);
  app.get("/auth/github", auth.githubStart);
  app.get("/auth/github/callback", auth.githubCallback);
  app.post("/auth/logout", auth.formContentType, auth.bodyCap, auth.logout);
  app.get("/api/session", auth.sessionApi);
  return { app, db: h.db, clock };
}

async function startLogin(app: Hono): Promise<{ txId: string; state: string; location: string }> {
  const res = await app.request("/auth/github");
  expect(res.status).toBe(303);
  const location = res.headers.get("location");
  const txId = setCookieValue(res, OAUTH_TX_COOKIE);
  expect(location).toBeTruthy();
  expect(txId).toBeTruthy();
  const state = new URL(location!).searchParams.get("state");
  expect(state).toBeTruthy();
  return { txId: txId!, state: state!, location: location! };
}

const txCookieHeader = (txId: string): string => `${OAUTH_TX_COOKIE}=${txId}`;
const sessionCookieHeader = (credential: string): string => `${SESSION_COOKIE}=${credential}`;

async function callbackReq(app: Hono, query: string, cookie?: string): Promise<Response> {
  return await app.request(`/auth/github/callback${query}`, { headers: cookie === undefined ? {} : { cookie } });
}

/** A full successful login; returns the issued session credential. */
async function login(app: Hono): Promise<string> {
  const { txId, state } = await startLogin(app);
  const res = await callbackReq(app, `?code=oauth-code&state=${state}`, txCookieHeader(txId));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const credential = setCookieValue(res, SESSION_COOKIE);
  expect(credential).toBeTruthy();
  return credential!;
}

async function identityRowCounts(db: Db): Promise<[number, number, number, number]> {
  return [
    (await db.select().from(users)).length,
    (await db.select().from(teams)).length,
    (await db.select().from(memberships)).length,
    (await db.select().from(authSessions)).length,
  ];
}

/** The zero-write + no-session-cookie contract of every failure branch. */
async function expectFailedLogin(res: Response, classification: string, db: Db): Promise<void> {
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`/login?error=${classification}`);
  expect(setCookieValue(res, SESSION_COOKIE)).toBeUndefined();
  // The tx cookie is cleared on every terminal callback response.
  expect(parseSetCookies(res).find((c) => c.name === OAUTH_TX_COOKIE)?.attrs["max-age"]).toBe("0");
  expect(await identityRowCounts(db)).toEqual([0, 0, 0, 0]);
}

// ---- GET /login ----

describe("GET /login", () => {
  it("renders the GitHub entry with the shared security headers", async () => {
    const { app } = await fresh();
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('href="/auth/github"');
  });

  it("maps a frozen error classification to its fixed message", async () => {
    const { app } = await fresh();
    const res = await app.request("/login?error=access_denied");
    expect(await res.text()).toContain("你拒绝了 GitHub 授权");
  });

  it("an unknown error value falls back to the generic message and is NEVER echoed", async () => {
    const { app } = await fresh();
    const sentinel = "evil<script>alert(1)</script>";
    const res = await app.request(`/login?error=${encodeURIComponent(sentinel)}`);
    const html = await res.text();
    expect(html).toContain("登录未完成，请重新登录。");
    expect(html).not.toContain("evil");
    expect(html).not.toContain("<script>");
  });
});

// ---- GET /auth/github ----

describe("GET /auth/github (AU5/AU12)", () => {
  it("303 to github.com with one-time state, an S256 challenge and the CONFIG-FROZEN redirect_uri", async () => {
    const { app, db } = await fresh();
    const a = await startLogin(app);
    const url = new URL(a.location);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-gh-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/auth/github/callback");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("scope")).toBe(false);

    // One-time: a second start mints fresh state.
    const b = await startLogin(app);
    expect(b.state).not.toBe(a.state);

    // Starting a login writes NOTHING to the database.
    expect(await identityRowCounts(db)).toEqual([0, 0, 0, 0]);
  });

  it("the tx cookie is scoped to /auth/github with a 600s lifetime (http origin → no Secure)", async () => {
    const { app } = await fresh();
    const res = await app.request("/auth/github");
    const tx = parseSetCookies(res).find((c) => c.name === OAUTH_TX_COOKIE);
    expect(tx?.attrs).toEqual({ httponly: true, "samesite": "Lax", path: "/auth/github", "max-age": "600" });
  });

  it("AU12: a hostile Host header cannot influence the redirect_uri", async () => {
    const { app } = await fresh();
    const res = await app.request("/auth/github", { headers: { host: "evil.example.com" } });
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/auth/github/callback");
  });

  it("an https origin marks the tx cookie Secure", async () => {
    const { app } = await fresh({
      authConfig: makeTestAuthConfig({
        origin: "https://loop.example.com",
        githubCallbackUrl: "https://loop.example.com/auth/github/callback",
      }),
    });
    const res = await app.request("/auth/github");
    expect(parseSetCookies(res).find((c) => c.name === OAUTH_TX_COOKIE)?.attrs.secure).toBe(true);
    expect(new URL(res.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://loop.example.com/auth/github/callback",
    );
  });
});

// ---- GET /auth/github/callback — failure matrix ----

describe("GET /auth/github/callback — every failure branch is zero-write (AU1–AU4, AU7, AU8)", () => {
  it("AU1: no transaction cookie → state_missing", async () => {
    const { app, db } = await fresh();
    await expectFailedLogin(await callbackReq(app, "?code=x&state=y"), "state_missing", db);
  });

  it("AU4: an unknown/foreign txId → state_unknown", async () => {
    const { app, db } = await fresh();
    await expectFailedLogin(
      await callbackReq(app, "?code=x&state=y", txCookieHeader("f".repeat(32))),
      "state_unknown",
      db,
    );
  });

  it("AU3: a transaction older than 10 minutes is gone → state_unknown", async () => {
    const { app, db, clock } = await fresh();
    const { txId, state } = await startLogin(app);
    clock.advance(10 * 60 * 1000);
    await expectFailedLogin(
      await callbackReq(app, `?code=x&state=${state}`, txCookieHeader(txId)),
      "state_unknown",
      db,
    );
  });

  it("AU7: a denied authorization → access_denied (and the tx is consumed)", async () => {
    const { app, db } = await fresh();
    const { txId, state } = await startLogin(app);
    await expectFailedLogin(
      await callbackReq(app, `?error=access_denied&state=${state}`, txCookieHeader(txId)),
      "access_denied",
      db,
    );
  });

  it("AU1b: a callback without the state param → state_missing", async () => {
    const { app, db } = await fresh();
    const { txId } = await startLogin(app);
    await expectFailedLogin(await callbackReq(app, "?code=x", txCookieHeader(txId)), "state_missing", db);
  });

  it("AU2: a state that does not match the server-side record → state_mismatch", async () => {
    const { app, db } = await fresh();
    const { txId } = await startLogin(app);
    await expectFailedLogin(
      await callbackReq(app, "?code=x&state=forged-state", txCookieHeader(txId)),
      "state_mismatch",
      db,
    );
  });

  it("a well-formed callback without a code → code_missing", async () => {
    const { app, db } = await fresh();
    const { txId, state } = await startLogin(app);
    await expectFailedLogin(await callbackReq(app, `?state=${state}`, txCookieHeader(txId)), "code_missing", db);
  });

  it("AU8: upstream exchange failure / transport failure → fixed classifications", async () => {
    const exchange500 = await fresh({
      github: fakeGitHub({ exchange: new Response("upstream meltdown", { status: 500 }) }),
    });
    const a = await startLogin(exchange500.app);
    await expectFailedLogin(
      await callbackReq(exchange500.app, `?code=x&state=${a.state}`, txCookieHeader(a.txId)),
      "exchange_failed",
      exchange500.db,
    );

    const network = await fresh({ github: fakeGitHub({ throwOn: "exchange" }) });
    const b = await startLogin(network.app);
    await expectFailedLogin(
      await callbackReq(network.app, `?code=x&state=${b.state}`, txCookieHeader(b.txId)),
      "network_error",
      network.db,
    );
  });

  it("AU6: replaying a consumed callback → state_unknown, and no second session", async () => {
    const { app, db } = await fresh();
    const { txId, state } = await startLogin(app);
    const query = `?code=oauth-code&state=${state}`;
    const first = await callbackReq(app, query, txCookieHeader(txId));
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/");
    expect(await identityRowCounts(db)).toEqual([1, 1, 1, 1]);

    // The byte-identical replay finds the transaction GONE — a zero-WRITE
    // failure (the counts stay exactly what the first login committed).
    const replay = await callbackReq(app, query, txCookieHeader(txId));
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe("/login?error=state_unknown");
    expect(setCookieValue(replay, SESSION_COOKIE)).toBeUndefined();
    expect(await identityRowCounts(db)).toEqual([1, 1, 1, 1]);
  });
});

// ---- GET /auth/github/callback — success ----

describe("GET /auth/github/callback — success", () => {
  it("303 to / with the session cookie (frozen attribute matrix), tx cookie cleared, identity + session persisted hash-only", async () => {
    const { app, db } = await fresh();
    const credential = await login(app);

    const res = await (async () => {
      const { txId, state } = await startLogin(app);
      return callbackReq(app, `?code=oauth-code&state=${state}`, txCookieHeader(txId));
    })();
    const cookies = parseSetCookies(res);
    const session = cookies.find((c) => c.name === SESSION_COOKIE);
    expect(session?.attrs).toEqual({
      httponly: true,
      samesite: "Lax",
      path: "/",
      "max-age": "604800",
    });
    expect(cookies.find((c) => c.name === OAUTH_TX_COOKIE)?.attrs["max-age"]).toBe("0");

    // The second login converged on the SAME identity (deterministic team id).
    expect(await identityRowCounts(db)).toEqual([1, 1, 1, 2]);
    const [sessionRow] = await db.select().from(authSessions);
    expect(JSON.stringify(sessionRow)).not.toContain(credential);
  });

  it("an https origin marks the session cookie Secure (SE4)", async () => {
    const { app } = await fresh({
      authConfig: makeTestAuthConfig({
        origin: "https://loop.example.com",
        githubCallbackUrl: "https://loop.example.com/auth/github/callback",
      }),
    });
    await startLogin(app).then(async ({ txId, state }) => {
      const res = await callbackReq(app, `?code=oauth-code&state=${state}`, txCookieHeader(txId));
      expect(parseSetCookies(res).find((c) => c.name === SESSION_COOKIE)?.attrs.secure).toBe(true);
    });
  });

  it("AU10: a renamed account keeps its identity — username refreshes, ids stay stable (AU11)", async () => {
    // GitHub reports a NEW login name on the second login.
    let githubLogin = "old-name";
    const github = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_test" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 424242, login: githubLogin }), { status: 200 });
    }) as typeof fetch;
    const { app, db } = await fresh({ github });

    await login(app);
    expect((await db.select().from(users))[0]!.username).toBe("old-name");
    const teamBefore = (await db.select().from(teams))[0]!.id;

    githubLogin = "new-name";
    await login(app);
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0]!.id).toBe("424242"); // identity = the numeric id, not the name
    expect(allUsers[0]!.username).toBe("new-name");
    expect((await db.select().from(teams)).map((t) => t.id)).toEqual([teamBefore]); // AU11
    expect(await db.select().from(authSessions)).toHaveLength(2);
  });
});

// ---- GET /api/session ----

describe("GET /api/session (SE1/SE2 at the route layer)", () => {
  it("401 without a cookie, with an unknown credential, and with an expired session", async () => {
    const { app, db, clock } = await fresh();
    expect((await app.request("/api/session")).status).toBe(401);
    expect(await (await app.request("/api/session")).json()).toEqual({ error: "not authenticated" });

    const { userId } = await seedPersonalIdentity(db);
    const { credential } = await seedSession(db, { userId });
    expect((await app.request("/api/session", { headers: { cookie: sessionCookieHeader("sk_unknown") } })).status).toBe(
      401,
    );
    clock.advance(7 * 24 * 3600 * 1000); // exactly at the absolute expiry
    expect((await app.request("/api/session", { headers: { cookie: sessionCookieHeader(credential) } })).status).toBe(
      401,
    );
  });

  it("200 with the schema-valid session view; csrfToken is the derived token; no-store", async () => {
    const { app, db } = await fresh();
    const { userId, teamId } = await seedPersonalIdentity(db);
    const { credential } = await seedSession(db, { userId });
    const res = await app.request("/api/session", { headers: { cookie: sessionCookieHeader(credential) } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(sessionInfoResponseSchema.parse(body)).toEqual({
      user: { id: userId, username: "tester" },
      team: { id: teamId, name: "tester" },
      session: { expiresAt: new Date(FIXTURE_T0.getTime() + 7 * 24 * 3600 * 1000).toISOString() },
      csrfToken: deriveSessionCsrfToken(credential),
    });
  });
});

// ---- POST /auth/logout ----

describe("POST /auth/logout (SE3/SE6/SE7/SE8 at the route layer)", () => {
  const FORM = { "content-type": "application/x-www-form-urlencoded" };

  async function seededSession(rig: Rig): Promise<{ credential: string; csrfToken: string }> {
    const { userId } = await seedPersonalIdentity(rig.db);
    const { credential } = await seedSession(rig.db, { userId });
    return { credential, csrfToken: deriveSessionCsrfToken(credential) };
  }

  function logoutReq(app: Hono, opts: { cookie?: string; body?: string; contentType?: string }): Promise<Response> {
    return Promise.resolve(
      app.request("/auth/logout", {
        method: "POST",
        headers: {
          "content-type": opts.contentType ?? FORM["content-type"],
          ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
        },
        body: opts.body ?? "",
      }),
    );
  }

  it("415 for a non-form content type; 413 beyond the 4 KiB form cap", async () => {
    const { app, db } = await fresh();
    const { userId } = await seedPersonalIdentity(db);
    const { credential } = await seedSession(db, { userId });

    const wrongType = await app.request("/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookieHeader(credential) },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ error: "unsupported media type" });

    const oversized = await logoutReq(app, {
      cookie: sessionCookieHeader(credential),
      body: `csrf=${"x".repeat(5000)}`,
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request body too large" });
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });

  it("401 without a session cookie or with an unknown credential", async () => {
    const { app } = await fresh();
    expect((await logoutReq(app, { body: "csrf=x" })).status).toBe(401);
    expect((await logoutReq(app, { cookie: sessionCookieHeader("sk_unknown"), body: "csrf=x" })).status).toBe(401);
  });

  it("403 for a missing, duplicate, or wrong token; 400 for a malformed form — and NOTHING is revoked (SE8)", async () => {
    const rig = await fresh();
    const { credential, csrfToken } = await seededSession(rig);
    const cookie = sessionCookieHeader(credential);

    const probes: [string, Response, number][] = [
      ["missing", await logoutReq(rig.app, { cookie, body: "" }), 403],
      ["wrong token", await logoutReq(rig.app, { cookie, body: "csrf=wrong" }), 403],
      ["duplicate", await logoutReq(rig.app, { cookie, body: `csrf=${csrfToken}&csrf=${csrfToken}` }), 403],
      ["stray field", await logoutReq(rig.app, { cookie, body: `csrf=${csrfToken}&extra=1` }), 400],
      ["corrupt escape", await logoutReq(rig.app, { cookie, body: "csrf=%" }), 400],
    ];
    for (const [label, res, status] of probes) {
      expect([label, res.status]).toEqual([label, status]);
      expect(await res.json(), label).toEqual({ error: expect.any(String) });
    }
    // Every failure left the session intact.
    expect(await rig.db.select().from(authSessions)).toHaveLength(1);
    const alive = await rig.app.request("/api/session", { headers: { cookie } });
    expect(alive.status).toBe(200);
  });

  it("SE7: another session's token does not authorize THIS session's logout", async () => {
    const rig = await fresh();
    const a = await seededSession(rig);
    const { credential: otherCredential } = await seedSession(rig.db, {
      userId: (await seedPersonalIdentity(rig.db, { githubUserId: "777", username: "other" })).userId,
    });
    const foreignToken = deriveSessionCsrfToken(otherCredential);
    const res = await logoutReq(rig.app, {
      cookie: sessionCookieHeader(a.credential),
      body: `csrf=${foreignToken}`,
    });
    expect(res.status).toBe(403);
    expect(await rig.db.select().from(authSessions)).toHaveLength(2);
  });

  it("success: 303 /login, the session cookie is cleared, the row is deleted, and /api/session is 401 afterwards (SE3)", async () => {
    const rig = await fresh();
    const a = await seededSession(rig);
    // A second, independent session survives (SE6).
    const { credential: otherCredential } = await seedSession(rig.db, {
      userId: (await seedPersonalIdentity(rig.db, { githubUserId: "777", username: "other" })).userId,
    });

    const res = await logoutReq(rig.app, {
      cookie: sessionCookieHeader(a.credential),
      body: `csrf=${a.csrfToken}`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    const cleared = parseSetCookies(res).find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe("");
    expect(cleared?.attrs["max-age"]).toBe("0");

    expect((await rig.app.request("/api/session", { headers: { cookie: sessionCookieHeader(a.credential) } })).status).toBe(401);
    expect((await rig.app.request("/api/session", { headers: { cookie: sessionCookieHeader(otherCredential) } })).status).toBe(200);
    expect(await rig.db.select().from(authSessions)).toHaveLength(1);
  });
});
