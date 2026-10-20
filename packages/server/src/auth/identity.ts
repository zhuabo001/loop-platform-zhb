/**
 * The first-login identity transaction (Batch 3 slice 2, ADR-011 决策 1–3):
 * create-or-read the User, the personal Team and the owner Membership in ONE
 * database transaction. Concurrency is arbitrated by the constraints, not by
 * application locks:
 *
 *  - users.id duplicate → ON CONFLICT refreshes the mutable display name
 *    (every login re-stamps username/updatedAt — ADR-011 决策 1);
 *  - the personal team id is DETERMINISTIC (`t-<sha256("team:"+id)[:16]>`,
 *    决策 2 — the same derivation testkit's seedTeam uses), so two concurrent
 *    first logins compute the SAME id and the teams PK / partial unique index
 *    converge them onto one row; the re-read after ON CONFLICT DO NOTHING
 *    also covers a pre-existing personal team under a non-derived id
 *    (fixtures seed those);
 *  - memberships (userId, teamId) composite PK swallows the duplicate grant.
 */
import { and, eq } from "drizzle-orm";

import { sha256 } from "@loopzhb/protocol/node";

import type { Db } from "../db/index.js";
import { memberships, teams, users, type Team, type User } from "../db/schema.js";
import type { Clock } from "../time.js";

/** ADR-011 决策 2: the deterministic personal-team id. */
export function mintPersonalTeamId(githubUserId: string): string {
  return `t-${sha256(`team:${githubUserId}`).slice(0, 16)}`;
}

export interface IdentityService {
  login(input: { githubUserId: string; username: string }): Promise<{ user: User; team: Team }>;
}

export function createIdentityService(deps: { db: Db; clock: Clock }): IdentityService {
  return {
    async login({ githubUserId, username }) {
      const now = deps.clock.now().toISOString();
      return deps.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ id: githubUserId, username, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: users.id, set: { username, updatedAt: now } })
          .returning();

        const inserted = await tx
          .insert(teams)
          .values({
            id: mintPersonalTeamId(githubUserId),
            name: username,
            ownerUserId: githubUserId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        const team =
          inserted[0] ??
          (
            await tx
              .select()
              .from(teams)
              .where(and(eq(teams.ownerUserId, githubUserId), eq(teams.kind, "personal")))
              .limit(1)
          )[0];

        // The PK upsert above RETURNINGs exactly one row; the re-read after a
        // conflict is guaranteed by the partial unique index. Both are
        // structural invariants — a miss means the schema drifted.
        if (user === undefined || team === undefined) {
          throw new Error("[auth] identity transaction invariant violated");
        }

        await tx
          .insert(memberships)
          .values({ userId: githubUserId, teamId: team.id, role: "owner", createdAt: now })
          .onConflictDoNothing();

        return { user, team };
      });
    },
  };
}
