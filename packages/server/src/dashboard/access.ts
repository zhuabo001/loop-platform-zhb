/**
 * The Dashboard access gates (Phase 5 Batch 3 slice 6, ADR-011 决策 29).
 *
 * Two gates, both mounted before any Dashboard route:
 *
 *  - `pageGate`: the HTML surface's Session gate. A missing/expired/broken
 *    Login Session redirects GET/HEAD to `/login` (303, no cookie set) and
 *    refuses every other method with the SAME 401 body as the JSON gates.
 *    Authentication runs before form parsing, so an anonymous oversized or
 *    wrong-content-type POST is 401, never 413/415.
 *
 *  - `loopGate`: the ownership gate for `/dashboard/loops/:id` and its
 *    children. The chain is the ONE batch derivation, Run → Loop → Machine →
 *    Team (here just Loop → Machine → Team); missing, orphan, unclaimed and
 *    cross-team all answer the flat 404 produced by `jsonError`, byte-identical
 *    to `app.notFound` and WITHOUT dashboard security headers — the same
 *    "not mounted / unknown / refused are indistinguishable" convention the
 *    host gate already follows.
 *
 * The Session is resolved EXACTLY ONCE per request and carried in the context;
 * handlers read it through `sessionOf`/`teamIdOf`/`csrfTokenOf` and never touch
 * a request parameter for the team.
 */
import type { Context, MiddlewareHandler } from "hono";

import { parseCookieHeader, SESSION_COOKIE } from "../auth/cookies.js";
import type { SessionService } from "../auth/session.js";
import type { Db } from "../db/index.js";
import { jsonError } from "../http/json-error.js";
import { getLoopTeam, teamMatches } from "../store/scope.js";
import { dashboardJson, securityHeaders } from "./security.js";

export interface DashboardSession {
  /** GitHub's numeric id as a decimal string — the same value the Session
   *  resolver read from `users.id`. */
  userId: string;
  username: string;
  teamId: string;
  teamName: string;
  /** Derived from the presented credential; never stored. */
  csrfToken: string;
}

export const DASHBOARD_SESSION_KEY = "dashboardSession";

export type DashboardEnv = { Variables: { dashboardSession: DashboardSession } };

export interface DashboardAccess {
  readonly pageGate: MiddlewareHandler<DashboardEnv>;
  readonly loopGate: MiddlewareHandler<DashboardEnv>;
  sessionOf(c: Context<DashboardEnv>): DashboardSession | undefined;
  teamIdOf(c: Context<DashboardEnv>): string | undefined;
  csrfTokenOf(c: Context<DashboardEnv>): string | undefined;
}

export interface DashboardAccessDeps {
  db: Db;
  sessions: SessionService;
}

export function createDashboardAccess(deps: DashboardAccessDeps): DashboardAccess {
  const sessionOf = (c: Context<DashboardEnv>): DashboardSession | undefined =>
    c.get(DASHBOARD_SESSION_KEY) as DashboardSession | undefined;

  const pageGate: MiddlewareHandler<DashboardEnv> = async (c, next) => {
    const credential = parseCookieHeader(c.req.header("cookie")).get(SESSION_COOKIE);
    const resolved = await deps.sessions.resolve(credential);
    if (resolved === null) {
      if (c.req.method === "GET" || c.req.method === "HEAD") {
        // A redirect carries no cookie: the login page is the only next step.
        return new Response(null, { status: 303, headers: securityHeaders({ location: "/login" }) });
      }
      return dashboardJson(401, "not authenticated");
    }
    c.set(DASHBOARD_SESSION_KEY, {
      userId: resolved.user.id,
      username: resolved.user.username,
      teamId: resolved.team.id,
      teamName: resolved.team.name,
      csrfToken: resolved.csrfToken,
    });
    return next();
  };

  const loopGate: MiddlewareHandler<DashboardEnv> = async (c, next) => {
    const session = sessionOf(c);
    if (session === undefined) return dashboardJson(401, "not authenticated");
    const loopId = c.req.param("id");
    const ownership = loopId === undefined ? { found: false as const } : await getLoopTeam(deps.db, loopId);
    if (!ownership.found || !teamMatches(ownership.teamId, session.teamId)) {
      return jsonError(c, 404, "not found");
    }
    return next();
  };

  return {
    pageGate,
    loopGate,
    sessionOf,
    teamIdOf: (c) => sessionOf(c)?.teamId,
    csrfTokenOf: (c) => sessionOf(c)?.csrfToken,
  };
}
