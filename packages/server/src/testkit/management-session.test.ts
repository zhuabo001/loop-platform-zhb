/**
 * The slice-5 testkit helpers, pinned where they can silently lie:
 *  - `seedManagementSession` must compute expiry from the caller's clock (not
 *    FIXTURE_T0), or every August boot test would start already logged out;
 *  - `withManagementSession` must inject a cookie only when the caller did not
 *    set one (negative fixtures depend on it).
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionService } from "../auth/session.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { FakeClock, seedManagementSession, TEST_TEAM_ID, withManagementSession } from "./index.js";

const handles: DbHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await closeDb(handle);
});

async function fresh(): Promise<Db> {
  const handle = await openMigratedDb();
  handles.push(handle);
  return handle.db;
}

describe("seedManagementSession", () => {
  it("computes expiry from the CALLER's clock, not FIXTURE_T0", async () => {
    const db = await fresh();
    const clock = new FakeClock(new Date("2026-08-27T00:00:00.000Z"));
    const { credential, teamId } = await seedManagementSession(db, { clock });

    const sessions = createSessionService({ db, clock });
    expect(await sessions.resolve(credential)).not.toBeNull();
    expect(teamId).toBe(TEST_TEAM_ID);

    clock.advance(7 * 24 * 3600 * 1000);
    expect(await sessions.resolve(credential)).toBeNull();
  });

  it("seeds two independent teams when given different GitHub ids", async () => {
    const db = await fresh();
    const clock = new FakeClock();
    const a = await seedManagementSession(db, { clock, githubUserId: "111" });
    const b = await seedManagementSession(db, { clock, githubUserId: "222", teamId: "t-ffffffffffffffff" });
    expect(a.teamId).not.toBe(b.teamId);
    expect((await createSessionService({ db, clock }).resolve(b.credential))?.team.id).toBe("t-ffffffffffffffff");
  });
});

describe("withManagementSession", () => {
  it("injects the cookie but never overrides a caller-supplied one", async () => {
    const app = new Hono();
    app.get("/api/echo", (c) => c.json({ cookie: c.req.header("cookie") ?? null }));
    const wrapped = withManagementSession(app, "sk_injected");

    expect(await (await wrapped.request("/api/echo")).json()).toEqual({ cookie: "loopzhb_session=sk_injected" });
    expect(await (await wrapped.request("/api/echo", { headers: { cookie: "loopzhb_session=explicit" } })).json()).toEqual({
      cookie: "loopzhb_session=explicit",
    });
  });
});
