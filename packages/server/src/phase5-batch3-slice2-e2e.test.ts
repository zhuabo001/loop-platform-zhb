/**
 * Phase 5 Batch 3 slice 2 — E2E through the REAL composition root
 * (`bootstrapServer`, file-backed PGlite in a tmp dataDir, scripted GitHub
 * transport via the `githubFetch` override, shared FakeClock):
 *
 *  SE5   A Login Session survives a full server restart (close + re-boot the
 *        same dataDir); a pending OAuth transaction does NOT (in-memory only).
 *  不变量1 A failed login produces NO usable session — zero rows in all four
 *        identity tables.
 *  不变量2 A first login does NOT grant old machines — a pre-existing
 *        Unclaimed Machine keeps teamId NULL and the new personal team holds
 *        no machines.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sessionInfoResponseSchema } from "@loopzhb/protocol";

import { OAUTH_TX_COOKIE, SESSION_COOKIE } from "./auth/cookies.js";
import { deriveSessionCsrfToken } from "./auth/session-csrf.js";
import { closeDb, type DbHandle } from "./db/index.js";
import { authSessions, machines, memberships, teams, users } from "./db/schema.js";
import { bootstrapServer, type BootedServer } from "./start.js";
import { FakeClock, makeTestAuthConfig, seedMachineForToken, setCookieValue } from "./testkit/index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let seq = 0;
async function tmpDataDir(): Promise<string> {
  seq += 1;
  return mkdtemp(path.join(tmpdir(), `loopzhb-slice2-${process.pid}-${seq}-`));
}

/** A healthy scripted GitHub: exchange succeeds, identity is 424242/tester. */
function fakeGitHub(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_e2e", token_type: "bearer" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 424242, login: "tester" }), { status: 200 });
  }) as typeof fetch;
}

async function boot(dataDir: string, clock: FakeClock): Promise<BootedServer> {
  const b = await bootstrapServer(
    { auth: makeTestAuthConfig(), host: "127.0.0.1", port: 3000, dataDir },
    { clock, githubFetch: fakeGitHub() },
  );
  handles.push(b.handle);
  return b;
}

/** Drive the login flow against a booted server; returns the credential. */
async function login(app: BootedServer["app"]): Promise<string> {
  const start = await app.request("/auth/github");
  expect(start.status).toBe(303);
  const txId = setCookieValue(start, OAUTH_TX_COOKIE)!;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await app.request(`/auth/github/callback?code=e2e-code&state=${state}`, {
    headers: { cookie: `${OAUTH_TX_COOKIE}=${txId}` },
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe("/");
  const credential = setCookieValue(callback, SESSION_COOKIE);
  expect(credential).toBeTruthy();
  return credential!;
}

describe("SE5: restart persistence", () => {
  it("a Login Session survives close + re-boot of the same dataDir; a pending OAuth transaction does NOT", async () => {
    const dir = await tmpDataDir();
    const clock = new FakeClock();
    const first = await boot(dir, clock);
    const credential = await login(first.app);

    // Start a SECOND login but never finish it — the pending transaction
    // lives only in the first boot's memory.
    const pending = await first.app.request("/auth/github");
    const pendingTxId = setCookieValue(pending, OAUTH_TX_COOKIE)!;
    const pendingState = new URL(pending.headers.get("location")!).searchParams.get("state")!;

    await closeDb(first.handle);
    handles.splice(handles.indexOf(first.handle), 1);

    const second = await boot(dir, clock);
    // The session is still valid after the restart…
    const res = await second.app.request("/api/session", {
      headers: { cookie: `${SESSION_COOKIE}=${credential}` },
    });
    expect(res.status).toBe(200);
    const body = sessionInfoResponseSchema.parse(await res.json());
    expect(body.user).toEqual({ id: "424242", username: "tester" });
    expect(body.csrfToken).toBe(deriveSessionCsrfToken(credential));

    // …but the interrupted login is dead: its transaction evaporated.
    const callback = await second.app.request(
      `/auth/github/callback?code=e2e-code&state=${pendingState}`,
      { headers: { cookie: `${OAUTH_TX_COOKIE}=${pendingTxId}` } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/login?error=state_unknown");
    expect(setCookieValue(callback, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("invariant: a failed login produces NO usable session", () => {
  it("zero rows in users/teams/memberships/auth_sessions after every failure shape", async () => {
    const dir = await tmpDataDir();
    const b = await boot(dir, new FakeClock());

    // Denied authorization through the real route chain.
    const start = await b.app.request("/auth/github");
    const txId = setCookieValue(start, OAUTH_TX_COOKIE)!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const denied = await b.app.request(`/auth/github/callback?error=access_denied&state=${state}`, {
      headers: { cookie: `${OAUTH_TX_COOKIE}=${txId}` },
    });
    expect(denied.headers.get("location")).toBe("/login?error=access_denied");

    for (const table of [users, teams, memberships, authSessions]) {
      expect(await b.handle.db.select().from(table)).toEqual([]);
    }
    // And no credential could have leaked into a usable state.
    expect((await b.app.request("/api/session")).status).toBe(401);
  });
});

describe("invariant: a first login does NOT grant old machines", () => {
  it("a pre-existing Unclaimed Machine stays teamId=NULL and outside the new team", async () => {
    const dir = await tmpDataDir();
    const b = await boot(dir, new FakeClock());
    // The Batch 2 legacy machine: exists, has history, belongs to nobody.
    const machineId = await seedMachineForToken(b.handle.db, "dk_legacy_machine");

    await login(b.app);

    const [machine] = await b.handle.db.select().from(machines);
    expect(machine.id).toBe(machineId);
    expect(machine.teamId).toBeNull();
    expect(machine.revokedAt).toBeNull();
    // The new personal team holds no machines at all.
    const [team] = await b.handle.db.select().from(teams);
    expect(team.ownerUserId).toBe("424242");
    expect(
      (await b.handle.db.select().from(machines)).filter((m) => m.teamId === team.id),
    ).toEqual([]);
  });
});
