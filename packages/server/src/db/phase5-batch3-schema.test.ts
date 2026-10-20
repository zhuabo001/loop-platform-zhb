/**
 * Phase 5 Batch 3 slice 1 — the identity schema (migration 0006, ADR-011,
 * codex-phase5-batch3-slices-plan.md Slice 1) on a FRESH database.
 *
 *  SC-RT  Round-trips: the four identity tables (users / teams / memberships /
 *         auth_sessions) round-trip verbatim; machines.teamId/revokedAt cover
 *         the three shapes (unclaimed = both null by default, claimed,
 *         revoked).
 *  SC-UQ  Unique keys arbitrate exactly their declared scope: users PK (the
 *         GitHub numeric id IS the unique external identity key), the partial
 *         unique index teams_personal_owner_idx (one personal team per user),
 *         memberships composite PK (no duplicate membership), auth_sessions
 *         credentialHash PK (the hash-only credential).
 *  SC-CK  CHECKs pin the id formats: users.id must be a decimal string
 *         (GITHUB_USER_ID_RE), teams.id must satisfy the BlobStore namespace
 *         key rule (ADR-011 决策 2).
 *  SC-ENUM TEAM_KINDS / MEMBERSHIP_ROLES are SERVER-INTERNAL value sets —
 *         declared here, never on the wire (ADR-011 决策 6); these pins fail
 *         loudly on drift.
 *
 *  NO foreign keys anywhere (the global convention): association between
 *  identity rows and business rows is validated in the store/service layer,
 *  never by the DB.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./index.js";
import {
  authSessions,
  GITHUB_USER_ID_RE,
  machines,
  memberships,
  MEMBERSHIP_ROLES,
  teams,
  TEAM_KINDS,
  users,
} from "./schema.js";

const handles: DbHandle[] = [];
let db: Db;

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

const NOW = "2026-10-07T00:00:00.000Z";
const SESSION_EXPIRES = "2026-10-14T00:00:00.000Z"; // NOW + 7 days (absolute)

const USER_FIXTURE = { id: "424242", username: "tester", createdAt: NOW, updatedAt: NOW };
const TEAM_FIXTURE = {
  id: "t-team-424242",
  name: "tester",
  kind: "personal" as const,
  ownerUserId: "424242",
  createdAt: NOW,
  updatedAt: NOW,
};
const MEMBERSHIP_FIXTURE = { userId: "424242", teamId: "t-team-424242", role: "owner" as const, createdAt: NOW };
const SESSION_FIXTURE = {
  credentialHash: "c".repeat(64),
  userId: "424242",
  createdAt: NOW,
  expiresAt: SESSION_EXPIRES,
};

/** Fresh migrated in-memory db per test, with one identity chain seeded. */
async function seeded(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  await db.insert(users).values(USER_FIXTURE);
  await db.insert(teams).values(TEAM_FIXTURE);
  await db.insert(memberships).values(MEMBERSHIP_FIXTURE);
}

/** drizzle wraps the driver error as "Failed query: …"; the violated
 *  constraint's name lives on the PG error down the `cause` chain. Works for
 *  unique violations and CHECK violations alike. */
async function expectConstraintViolation(promise: Promise<unknown>, constraint: string): Promise<void> {
  const err: unknown = await promise.then(
    () => {
      throw new Error(`expected a violation of ${constraint}, but the statement succeeded`);
    },
    (e: unknown) => e,
  );
  const messages: string[] = [];
  for (let cur: unknown = err; cur; cur = (cur as { cause?: unknown }).cause) {
    messages.push(String((cur as Error).message ?? cur));
  }
  expect(messages.join("\n")).toContain(constraint);
}

describe("SC-RT: identity tables and machine columns round-trip", () => {
  it("user/team/membership/session rows round-trip verbatim", async () => {
    await seeded();
    await db.insert(authSessions).values(SESSION_FIXTURE);

    const [user] = await db.select().from(users);
    expect(user).toEqual(USER_FIXTURE);
    const [team] = await db.select().from(teams);
    expect(team).toEqual(TEAM_FIXTURE);
    const [membership] = await db.select().from(memberships);
    expect(membership).toEqual(MEMBERSHIP_FIXTURE);
    const [session] = await db.select().from(authSessions);
    expect(session).toEqual(SESSION_FIXTURE);
  });

  it("teams.kind lands on its DDL default 'personal' when omitted", async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    await db.insert(users).values(USER_FIXTURE);
    await db.insert(teams).values({
      id: "t-team-default",
      name: "tester",
      ownerUserId: "424242",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [team] = await db.select().from(teams).where(eq(teams.id, "t-team-default"));
    expect(team!.kind).toBe("personal");
  });

  it("machines.teamId/revokedAt: omitted = unclaimed (null/null); claimed and revoked shapes round-trip", async () => {
    await seeded();
    await db.insert(machines).values({ id: "m-unclaimed", name: "", tokenHash: "a".repeat(64), createdAt: NOW });
    await db.insert(machines).values({
      id: "m-claimed",
      name: "",
      tokenHash: "b".repeat(64),
      teamId: "t-team-424242",
      createdAt: NOW,
    });
    await db.insert(machines).values({
      id: "m-revoked",
      name: "",
      tokenHash: "d".repeat(64),
      teamId: "t-team-424242",
      revokedAt: NOW,
      createdAt: NOW,
    });

    const [unclaimed] = await db.select().from(machines).where(eq(machines.id, "m-unclaimed"));
    expect([unclaimed!.teamId, unclaimed!.revokedAt]).toEqual([null, null]);
    const [claimed] = await db.select().from(machines).where(eq(machines.id, "m-claimed"));
    expect([claimed!.teamId, claimed!.revokedAt]).toEqual(["t-team-424242", null]);
    const [revoked] = await db.select().from(machines).where(eq(machines.id, "m-revoked"));
    expect([revoked!.teamId, revoked!.revokedAt]).toEqual(["t-team-424242", NOW]);
  });
});

describe("SC-UQ: unique keys arbitrate exactly their declared scope", () => {
  it("users.id duplicate is rejected (the GitHub numeric id is the PK)", async () => {
    await seeded();
    await expectConstraintViolation(
      db.insert(users).values({ ...USER_FIXTURE, username: "renamed" }),
      "users_pkey",
    );
    // A different GitHub id is a different user, even with the same username.
    await db.insert(users).values({ ...USER_FIXTURE, id: "777" });
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it("one personal team per user: a second personal team for the same owner is rejected; another owner succeeds", async () => {
    await seeded();
    await expectConstraintViolation(
      db.insert(teams).values({ ...TEAM_FIXTURE, id: "t-team-second", name: "second" }),
      "teams_personal_owner_idx",
    );
    await db.insert(users).values({ ...USER_FIXTURE, id: "777", username: "other" });
    await db.insert(teams).values({ ...TEAM_FIXTURE, id: "t-team-777", ownerUserId: "777" });
    expect(await db.select().from(teams)).toHaveLength(2);
  });

  it("memberships (userId, teamId) composite PK rejects a duplicate membership", async () => {
    await seeded();
    await expectConstraintViolation(
      db.insert(memberships).values({ ...MEMBERSHIP_FIXTURE }),
      "memberships_pkey",
    );
    // The same user in ANOTHER team is a different membership.
    await db.insert(users).values({ ...USER_FIXTURE, id: "777", username: "other" });
    await db.insert(teams).values({ ...TEAM_FIXTURE, id: "t-team-777", ownerUserId: "777" });
    await db.insert(memberships).values({ ...MEMBERSHIP_FIXTURE, teamId: "t-team-777" });
    expect(await db.select().from(memberships)).toHaveLength(2);
  });

  it("auth_sessions credentialHash PK rejects a duplicate; a different hash is a different session", async () => {
    await seeded();
    await db.insert(authSessions).values(SESSION_FIXTURE);
    await expectConstraintViolation(
      db.insert(authSessions).values({ ...SESSION_FIXTURE }),
      "auth_sessions_pkey",
    );
    await db.insert(authSessions).values({ ...SESSION_FIXTURE, credentialHash: "d".repeat(64) });
    expect(await db.select().from(authSessions)).toHaveLength(2);
  });

  it("NO foreign keys: identity rows may name nonexistent counterparts at the DB level", async () => {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    // The no-FK convention (schema.ts header) is deliberate: the identity chain
    // is validated in the login transaction (slice 2) and the claim CLI
    // (slice 4), never by the DB. Pins the split so a "helpful" future FK
    // fails loudly here.
    await db.insert(memberships).values({ userId: "ghost-user", teamId: "t-ghost", role: "owner", createdAt: NOW });
    await db.insert(authSessions).values({ credentialHash: "e".repeat(64), userId: "ghost-user", createdAt: NOW, expiresAt: SESSION_EXPIRES });
    expect(await db.select().from(memberships)).toHaveLength(1);
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });
});

describe("SC-CK: CHECK constraints pin the id formats", () => {
  it.each(["abc", "12a34", "", " 123", "-5"])(
    "users.id %j is rejected by users_id_github_numeric_ck",
    async (badId) => {
      const h = await openMigratedDb();
      handles.push(h);
      db = h.db;
      await expectConstraintViolation(
        db.insert(users).values({ ...USER_FIXTURE, id: badId }),
        "users_id_github_numeric_ck",
      );
      expect(GITHUB_USER_ID_RE.test(badId)).toBe(false);
    },
  );

  it.each(["T-UPPER", "t team", "-leading-dash", "t_" + "x".repeat(80)])(
    "teams.id %j is rejected by teams_id_namespace_ck",
    async (badId) => {
      await seeded();
      await expectConstraintViolation(
        db.insert(teams).values({ ...TEAM_FIXTURE, id: badId }),
        "teams_id_namespace_ck",
      );
    },
  );

  it("a legal namespace-key team id ('t-' + 16 hex) is accepted", async () => {
    await seeded();
    await db.insert(users).values({ ...USER_FIXTURE, id: "777", username: "other" });
    await db.insert(teams).values({ ...TEAM_FIXTURE, id: "t-0123456789abcdef", ownerUserId: "777" });
    const [team] = await db.select().from(teams).where(eq(teams.id, "t-0123456789abcdef"));
    expect(team!.ownerUserId).toBe("777");
  });
});

describe("SC-ENUM: server-internal value sets are pinned", () => {
  it("teams.kind enumValues are exactly TEAM_KINDS", () => {
    expect(TEAM_KINDS).toEqual(["personal"]);
    const config = teams.kind.enumValues;
    expect([...config!]).toEqual([...TEAM_KINDS]);
  });

  it("memberships.role enumValues are exactly MEMBERSHIP_ROLES", () => {
    expect(MEMBERSHIP_ROLES).toEqual(["owner"]);
    const config = memberships.role.enumValues;
    expect([...config!]).toEqual([...MEMBERSHIP_ROLES]);
  });
});
