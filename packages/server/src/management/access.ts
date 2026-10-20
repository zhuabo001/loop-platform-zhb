/**
 * Management Access — the Session gate and the ownership gates for the
 * management JSON surface (Phase 5 Batch 3 slice 5, ADR-011 决策 23/25/27).
 *
 * Three middlewares, one policy:
 *
 *  - `sessionGate` is mounted on "/api/*" and is DENY-BY-DEFAULT. Only
 *    `/api/session` (the login-status probe) and `/api/machine` +
 *    `/api/machine/*` (Bearer machine credentials) are exempt. A new /api
 *    route is therefore gated the moment it exists — there is no per-route
 *    list to forget.
 *
 *    The exemption is written with an explicit slash: `startsWith("/api/machine")`
 *    would also exempt `/api/machines`, the MACHINE LIST — a silent
 *    cross-team data leak.
 *
 *  - `loopGate` / `runGate` resolve the path id through the ONE ownership
 *    chain (store/scope.ts) BEFORE the handler runs, and answer a flat code-less
 *    404 for missing / orphan / unclaimed / cross-team alike. They are
 *    registered both without and with a trailing `/*` so a future bare
 *    `/api/loops/:id` route cannot slip past.
 *
 * The ownership read is authoritative for the request because this batch has
 * NO online claim and NO online revoke (the slice-4 CLI requires a stopped
 * server and holds the dataDir lock); Batch 4 must revisit the TOCTOU window
 * if it introduces online ownership changes.
 *
 * Credential isolation (决策 27) is structural: this module reads ONLY the
 * session cookie; machine routes read ONLY the Authorization header. There is
 * no shared resolver that could accept the other credential type.
 */
import type { Context, MiddlewareHandler } from "hono";

import { parseCookieHeader, SESSION_COOKIE } from "../auth/cookies.js";
import type { SessionService } from "../auth/session.js";
import type { Db } from "../db/index.js";
import { jsonError } from "../http/json-error.js";
import { getLoopTeam, getRunTeam, teamMatches } from "../store/scope.js";

/** The Hono variable that carries the resolved Team Scope to the route. */
export const MANAGEMENT_TEAM_KEY = "managementTeamId";

export type ManagementEnv = { Variables: { managementTeamId: string } };

export interface ManagementAccess {
  readonly sessionGate: MiddlewareHandler<ManagementEnv>;
  readonly loopGate: MiddlewareHandler<ManagementEnv>;
  readonly runGate: MiddlewareHandler<ManagementEnv>;
  /** The Team Scope established by `sessionGate`, or undefined if a route was
   *  assembled without it (fail-closed at every consumer). */
  teamIdOf(c: Context<ManagementEnv>): string | undefined;
}

export interface ManagementAccessDeps {
  db: Db;
  sessions: SessionService;
}

/** The ONE exemption predicate. Exported so its tests can pin the
 *  `/api/machines`-vs-`/api/machine` boundary directly. */
export function isManagementExempt(path: string): boolean {
  if (path === "/api/session") return true;
  if (path === "/api/machine") return true;
  if (path.startsWith("/api/machine/")) return true;
  return false;
}

export function createManagementAccess(deps: ManagementAccessDeps): ManagementAccess {
  const teamIdOf = (c: Context<ManagementEnv>): string | undefined => c.get(MANAGEMENT_TEAM_KEY);

  const sessionGate: MiddlewareHandler<ManagementEnv> = async (c, next) => {
    if (isManagementExempt(c.req.path)) return next();
    const credential = parseCookieHeader(c.req.header("cookie")).get(SESSION_COOKIE);
    const resolved = await deps.sessions.resolve(credential);
    if (resolved === null) return jsonError(c, 401, "not authenticated");
    c.set(MANAGEMENT_TEAM_KEY, resolved.team.id);
    return next();
  };

  /** One refusal shape for every ownership miss: byte-identical to
   *  `app.notFound`. */
  const notFound = (c: Context<ManagementEnv>): Response => jsonError(c, 404, "not found");

  const loopGate: MiddlewareHandler<ManagementEnv> = async (c, next) => {
    const teamId = teamIdOf(c);
    if (teamId === undefined) return jsonError(c, 401, "not authenticated");
    const id = c.req.param("id");
    const ownership = id === undefined ? ({ found: false } as const) : await getLoopTeam(deps.db, id);
    if (!ownership.found || !teamMatches(ownership.teamId, teamId)) return notFound(c);
    return next();
  };

  const runGate: MiddlewareHandler<ManagementEnv> = async (c, next) => {
    const teamId = teamIdOf(c);
    if (teamId === undefined) return jsonError(c, 401, "not authenticated");
    const id = c.req.param("id");
    const ownership = id === undefined ? ({ found: false } as const) : await getRunTeam(deps.db, id);
    if (!ownership.found || !teamMatches(ownership.teamId, teamId)) return notFound(c);
    return next();
  };

  return { sessionGate, loopGate, runGate, teamIdOf };
}
