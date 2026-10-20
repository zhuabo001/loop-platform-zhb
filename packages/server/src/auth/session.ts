/**
 * Login Session service (Batch 3 slice 2, ADR-011 决策 4): mint, resolve and
 * revoke the hash-only browser credential.
 *
 *  - Mint: `sk_` + 32 random bytes base64url (256-bit, cookie-safe); ONLY the
 *    sha256 is persisted, and the hash IS the primary key. Absolute 7-day
 *    expiry stamped from the injected Clock at creation; no sliding renewal.
 *  - Resolve: unknown, empty or EXPIRED credentials all resolve to null —
 *    the expiry boundary is pinned: `now >= expiresAt` is expired, one
 *    millisecond before is valid. No opportunistic cleanup of expired rows:
 *    reads never write. A hit carries the session-level CSRF token, DERIVED
 *    from the presented credential (session-csrf.ts) — nothing about the
 *    token is stored.
 *  - Revoke: DELETE the current row only; idempotent.
 */
import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { sha256 } from "@loopzhb/protocol/node";

import type { Db } from "../db/index.js";
import { authSessions, teams, users, type AuthSessionRow, type Team, type User } from "../db/schema.js";
import type { Clock } from "../time.js";
import { deriveSessionCsrfToken } from "./session-csrf.js";

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export interface MintedSession {
  credential: string;
  row: AuthSessionRow;
}

export interface ResolvedSession {
  row: AuthSessionRow;
  user: User;
  team: Team;
  /** The session-level form CSRF token, derived from the presented
   *  credential (never stored). */
  csrfToken: string;
}

export interface SessionService {
  mint(userId: string): Promise<MintedSession>;
  resolve(credential: string | undefined): Promise<ResolvedSession | null>;
  revoke(credentialHash: string): Promise<void>;
}

export function createSessionService(deps: { db: Db; clock: Clock }): SessionService {
  return {
    async mint(userId) {
      const credential = `sk_${randomBytes(32).toString("base64url")}`;
      const now = deps.clock.now();
      const row: AuthSessionRow = {
        credentialHash: sha256(credential),
        userId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      };
      await deps.db.insert(authSessions).values(row);
      return { credential, row };
    },

    async resolve(credential) {
      if (credential === undefined || credential === "") return null;
      const [row] = await deps.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.credentialHash, sha256(credential)))
        .limit(1);
      if (row === undefined) return null;
      // Absolute expiry boundary (SE2): AT expiresAt the session is dead.
      if (deps.clock.now().getTime() >= Date.parse(row.expiresAt)) return null;
      const [user] = await deps.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
      const [team] = await deps.db
        .select()
        .from(teams)
        .where(and(eq(teams.ownerUserId, row.userId), eq(teams.kind, "personal")))
        .limit(1);
      // No FKs by convention: a session whose identity chain is broken (a
      // direct DB edit) resolves as logged-out rather than leaking a row.
      if (user === undefined || team === undefined) return null;
      return { row, user, team, csrfToken: deriveSessionCsrfToken(credential) };
    },

    async revoke(credentialHash) {
      await deps.db.delete(authSessions).where(eq(authSessions.credentialHash, credentialHash));
    },
  };
}
