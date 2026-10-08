/**
 * Login Session service (SE1/SE2/SE3/SE6 at the service layer): hash-only
 * minting, the pinned absolute-expiry boundary, revocation, and independent
 * concurrent sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { authSessions } from "../db/schema.js";
import { FakeClock, FIXTURE_T0, seedPersonalIdentity, seedSession } from "../testkit/index.js";
import { deriveSessionCsrfToken } from "./session-csrf.js";
import { createSessionService, SESSION_TTL_MS } from "./session.js";

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

describe("session mint", () => {
  it("persists ONLY the credential hash — the plaintext credential is nowhere in the row", async () => {
    const { userId } = await seedPersonalIdentity(db);
    const svc = createSessionService({ db, clock });
    const { credential, row } = await svc.mint(userId);

    expect(credential).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(row).toEqual({
      credentialHash: sha256(credential),
      userId,
      createdAt: clock.iso(),
      expiresAt: new Date(FIXTURE_T0.getTime() + SESSION_TTL_MS).toISOString(),
    });
    const [stored] = await db.select().from(authSessions);
    expect(JSON.stringify(stored)).not.toContain(credential);
  });
});

describe("session resolve (SE1/SE2)", () => {
  it("unknown, empty and absent credentials all resolve to null (SE1)", async () => {
    const { userId } = await seedPersonalIdentity(db);
    await seedSession(db, { userId });
    const svc = createSessionService({ db, clock });
    expect(await svc.resolve(undefined)).toBeNull();
    expect(await svc.resolve("")).toBeNull();
    expect(await svc.resolve("sk_no_such_credential")).toBeNull();
  });

  it("a live credential resolves with the user AND the personal team joined, plus the derived CSRF token", async () => {
    const { userId, teamId } = await seedPersonalIdentity(db);
    const { credential } = await seedSession(db, { userId });
    const svc = createSessionService({ db, clock });
    const resolved = await svc.resolve(credential);
    expect(resolved?.user.id).toBe(userId);
    expect(resolved?.team.id).toBe(teamId);
    expect(resolved?.row.credentialHash).toBe(sha256(credential));
    // The session-level CSRF token is derived, never stored.
    expect(resolved?.csrfToken).toBe(deriveSessionCsrfToken(credential));
  });

  it("expiry boundary: 1ms before expiresAt is valid, AT expiresAt is expired (SE2)", async () => {
    const { userId } = await seedPersonalIdentity(db);
    const expiresAt = new Date(FIXTURE_T0.getTime() + 60_000).toISOString();
    const { credential } = await seedSession(db, { userId, expiresAt });
    const svc = createSessionService({ db, clock });

    clock.advance(60_000 - 1);
    expect(await svc.resolve(credential)).not.toBeNull();
    clock.advance(1);
    expect(await svc.resolve(credential)).toBeNull();
  });
});

describe("session revoke (SE3/SE6)", () => {
  it("revoke deletes ONLY the current session; a second session stays live", async () => {
    const { userId } = await seedPersonalIdentity(db);
    const svc = createSessionService({ db, clock });
    const a = await svc.mint(userId);
    const b = await svc.mint(userId);
    expect(a.credential).not.toBe(b.credential);

    await svc.revoke(a.row.credentialHash);
    expect(await svc.resolve(a.credential)).toBeNull();
    expect(await svc.resolve(b.credential)).not.toBeNull();
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });

  it("revoke is idempotent — an unknown hash is a no-op", async () => {
    const svc = createSessionService({ db, clock });
    await svc.revoke("0".repeat(64));
    expect(await db.select().from(authSessions)).toHaveLength(0);
  });

  it("a session whose identity chain is broken resolves as logged-out (no FK convention)", async () => {
    const svc = createSessionService({ db, clock });
    // No seedPersonalIdentity: the session names a user that does not exist.
    const { credential } = await seedSession(db, { userId: "ghost" });
    expect(await svc.resolve(credential)).toBeNull();
  });
});
