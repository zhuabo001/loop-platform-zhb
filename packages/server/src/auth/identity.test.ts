/**
 * The first-login identity transaction (AU9/AU10/AU11): create-or-read User +
 * personal Team + owner Membership in one transaction, Clock-stamped,
 * convergent under concurrency, stable across logins.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { memberships, teams, users } from "../db/schema.js";
import { FakeClock, seedPersonalIdentity } from "../testkit/index.js";
import { createIdentityService, mintPersonalTeamId } from "./identity.js";

const handles: DbHandle[] = [];
let db: Db;
let clock: FakeClock;

beforeEach(async () => {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

describe("identity.login — first login (AU11)", () => {
  it("creates exactly one User, one personal Team and one owner Membership, Clock-stamped", async () => {
    const svc = createIdentityService({ db, clock });
    const { user, team } = await svc.login({ githubUserId: "424242", username: "tester" });

    const now = clock.iso();
    expect(user).toEqual({ id: "424242", username: "tester", createdAt: now, updatedAt: now });
    expect(team).toEqual({
      id: mintPersonalTeamId("424242"),
      name: "tester",
      kind: "personal",
      ownerUserId: "424242",
      createdAt: now,
      updatedAt: now,
    });
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(teams)).toHaveLength(1);
    expect(await db.select().from(memberships)).toEqual([
      { userId: "424242", teamId: team.id, role: "owner", createdAt: now },
    ]);
  });

  it("the team id matches the deterministic derivation fixtures use (ADR-011 决策 2)", async () => {
    const svc = createIdentityService({ db, clock });
    const { team } = await svc.login({ githubUserId: "424242", username: "tester" });
    // seedTeam derives the same id — the fixture and production agree.
    const fixture = await seedPersonalIdentity(await freshDb(), { githubUserId: "777" });
    expect(fixture.teamId).toBe(mintPersonalTeamId("777"));
    expect(team.id).toBe(mintPersonalTeamId("424242"));
  });
});

describe("identity.login — repeat login (AU10)", () => {
  it("refreshes the mutable username and updatedAt; identity and team stay stable", async () => {
    const svc = createIdentityService({ db, clock });
    const first = await svc.login({ githubUserId: "424242", username: "old-name" });
    clock.advance(60_000);
    const second = await svc.login({ githubUserId: "424242", username: "new-name" });

    expect(second.user.id).toBe("424242");
    expect(second.user.username).toBe("new-name");
    expect(second.user.createdAt).toBe(first.user.createdAt); // createdAt untouched
    expect(second.user.updatedAt).toBe(clock.iso());
    expect(second.team.id).toBe(first.team.id); // AU11: team id stable
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(teams)).toHaveLength(1);
    expect(await db.select().from(memberships)).toHaveLength(1);
  });

  it("a pre-existing personal team under a NON-derived id is adopted, not duplicated", async () => {
    // Fixtures seed teams with arbitrary ids; the partial unique index makes
    // the derived-id insert a no-op and the re-read returns the fixture team.
    const fixture = await seedPersonalIdentity(db, { githubUserId: "424242", username: "seeded" });
    const svc = createIdentityService({ db, clock });
    const { team } = await svc.login({ githubUserId: "424242", username: "tester" });
    expect(team.id).toBe(fixture.teamId);
    expect(await db.select().from(teams)).toHaveLength(1);
    expect(await db.select().from(memberships)).toHaveLength(1);
  });
});

describe("identity.login — concurrent first logins (AU9)", () => {
  it("two parallel logins for the same GitHub id converge on one identity", async () => {
    const svc = createIdentityService({ db, clock });
    // PGlite serializes transactions on its single writer, so true row-level
    // interleaving cannot be forced here; the observable contract — one user,
    // one team, one membership, BOTH logins succeeding — is what this pins.
    // The ON CONFLICT + re-read path is the real-Postgres insurance.
    const [a, b] = await Promise.all([
      svc.login({ githubUserId: "424242", username: "tester" }),
      svc.login({ githubUserId: "424242", username: "tester" }),
    ]);
    expect(a.user.id).toBe("424242");
    expect(b.user.id).toBe("424242");
    expect(a.team.id).toBe(b.team.id);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(teams)).toHaveLength(1);
    expect(await db.select().from(memberships)).toHaveLength(1);
  });
});

async function freshDb(): Promise<Db> {
  const h = await openMigratedDb();
  handles.push(h);
  return h.db;
}
