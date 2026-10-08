/**
 * The auth routes (Batch 3 slice 2): the five-route login surface —
 * `GET /login`, `GET /auth/github`, `GET /auth/github/callback`,
 * `POST /auth/logout`, `GET /api/session`.
 *
 * Conventions carried over from the dashboard module:
 *  - EVERY response is a bare `new Response(...)` with headers built
 *    explicitly via `securityHeaders()` — Hono drops prepared headers on
 *    returned Responses, so nothing here uses `c.html`/`c.redirect`;
 *  - all redirects are 303; JSON errors keep the `{error}` envelope;
 *  - log lines are fixed strings — the OAuth classification taxonomy
 *    (errors.ts) is the only thing that can ever be said about a failure.
 *
 * The callback consumes the pending transaction EXACTLY ONCE, on every
 * branch: a replay finds nothing (`state_unknown`) and every failure branch
 * is a zero-write path — no identity row, no session, no session cookie.
 */
import { timingSafeEqual } from "node:crypto";

import { bodyLimit } from "hono/body-limit";
import type { Handler, MiddlewareHandler } from "hono";

import type { AuthConfig } from "../config.js";
import { securityHeaders } from "../dashboard/routes.js";
import {
  buildOAuthTxCookie,
  buildOAuthTxCookieClear,
  buildSessionCookie,
  buildSessionCookieClear,
  OAUTH_TX_COOKIE,
  parseCookieHeader,
  SESSION_COOKIE,
} from "./cookies.js";
import type { OAuthFailure } from "./errors.js";
import type { GitHubOAuthAdapter } from "./github.js";
import type { IdentityService } from "./identity.js";
import { renderLoginPage } from "./login-page.js";
import { pkceS256Challenge, type PendingOAuthTxStore } from "./pending-tx.js";
import { checkSessionCsrfForm } from "./session-csrf.js";
import type { SessionService } from "./session.js";

/** Same form byte cap as the dashboard (4 KiB). */
const FORM_CAP_BYTES = 4096;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export interface AuthRouteDeps {
  authConfig: AuthConfig;
  pendingTx: PendingOAuthTxStore;
  github: GitHubOAuthAdapter;
  identity: IdentityService;
  sessions: SessionService;
}

export interface AuthRoutes {
  loginPage: Handler;
  githubStart: Handler;
  githubCallback: Handler;
  /** Rejects anything that is not an URL-encoded form (415). */
  formContentType: MiddlewareHandler;
  bodyCap: MiddlewareHandler;
  logout: Handler;
  sessionApi: Handler;
}

function authJson(status: 400 | 401 | 403 | 413 | 415, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: securityHeaders({ "content-type": "application/json" }),
  });
}

/** Constant-time string compare with a length pre-check. */
function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createAuthRoutes(deps: AuthRouteDeps): AuthRoutes {
  // Derived ONCE from the configured origin — never from the request.
  const secure = new URL(deps.authConfig.origin).protocol === "https:";

  const loginPage: Handler = (c) =>
    new Response(renderLoginPage({ error: c.req.query("error") }), {
      status: 200,
      headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
    });

  const githubStart: Handler = () => {
    const { txId, tx } = deps.pendingTx.create();
    const headers = securityHeaders({
      location: deps.github.authorizeUrl({ state: tx.state, codeChallenge: pkceS256Challenge(tx.codeVerifier) }),
    });
    headers.append("set-cookie", buildOAuthTxCookie(txId, { secure }));
    return new Response(null, { status: 303, headers });
  };

  const githubCallback: Handler = async (c) => {
    /** Every terminal failure: fixed classification, tx cookie cleared (the
     *  transaction itself is already consumed or never existed). */
    const fail = (classification: OAuthFailure): Response => {
      const headers = securityHeaders({ location: `/login?error=${classification}` });
      headers.append("set-cookie", buildOAuthTxCookieClear({ secure }));
      return new Response(null, { status: 303, headers });
    };

    // 1. Browser binding: no transaction cookie → the flow never started here.
    const txId = parseCookieHeader(c.req.header("cookie")).get(OAUTH_TX_COOKIE);
    if (txId === undefined) {
      console.warn("[auth] oauth state missing");
      return fail("state_missing");
    }
    // 2. Atomic one-time consumption — from here on the tx is GONE, whatever
    //    happens (replay → state_unknown; TTL enforced inside consume).
    const tx = deps.pendingTx.consume(txId);
    if (tx === null) {
      console.warn("[auth] oauth state unknown");
      return fail("state_unknown");
    }
    // 3. A denied authorization still consumed the transaction.
    if (c.req.query("error") !== undefined) {
      console.warn("[auth] oauth denied by user or upstream");
      return fail("access_denied");
    }
    // 4. State binding.
    const state = c.req.query("state");
    if (state === undefined) {
      console.warn("[auth] oauth state missing");
      return fail("state_missing");
    }
    if (!secretsEqual(state, tx.state)) {
      console.warn("[auth] oauth state mismatch");
      return fail("state_mismatch");
    }
    // 5. The authorization code.
    const code = c.req.query("code");
    if (code === undefined || code === "") {
      console.warn("[auth] oauth callback missing code");
      return fail("code_missing");
    }
    // 6. Upstream identity resolution (classification fixed in the adapter).
    const identityResult = await deps.github.resolveIdentity(code, tx.codeVerifier);
    if (!identityResult.ok) return fail(identityResult.classification);

    // 7. Identity transaction + session mint — the ONLY writing branch.
    const { user } = await deps.identity.login({ githubUserId: identityResult.id, username: identityResult.username });
    const minted = await deps.sessions.mint(user.id);
    const headers = securityHeaders({ location: "/" });
    headers.append("set-cookie", buildSessionCookie(minted.credential, { secure }));
    headers.append("set-cookie", buildOAuthTxCookieClear({ secure }));
    return new Response(null, { status: 303, headers });
  };

  const formContentType: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header("content-type");
    const mediaType = raw?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== FORM_CONTENT_TYPE) return authJson(415, "unsupported media type");
    return next();
  };

  const bodyCap = bodyLimit({
    maxSize: FORM_CAP_BYTES,
    onError: () => authJson(413, "request body too large"),
  });

  const logout: Handler = async (c) => {
    const credential = parseCookieHeader(c.req.header("cookie")).get(SESSION_COOKIE);
    const resolved = await deps.sessions.resolve(credential);
    if (resolved === null) return authJson(401, "not authenticated");
    const verdict = checkSessionCsrfForm(await c.req.text(), resolved.csrfToken);
    switch (verdict) {
      case "bad_form":
        return authJson(400, "invalid request");
      case "token_missing":
      case "token_duplicate":
      case "token_mismatch":
        // Fixed classification only; a CSRF failure revokes NOTHING.
        console.warn(`[auth] logout csrf ${verdict}`);
        return authJson(403, "forbidden");
      case "ok":
        break;
    }
    await deps.sessions.revoke(resolved.row.credentialHash);
    const headers = securityHeaders({ location: "/login" });
    headers.append("set-cookie", buildSessionCookieClear({ secure }));
    return new Response(null, { status: 303, headers });
  };

  const sessionApi: Handler = async (c) => {
    const credential = parseCookieHeader(c.req.header("cookie")).get(SESSION_COOKIE);
    const resolved = await deps.sessions.resolve(credential);
    if (resolved === null) return authJson(401, "not authenticated");
    // The csrfToken plaintext rides ONLY this response, on no-store.
    return new Response(
      JSON.stringify({
        user: { id: resolved.user.id, username: resolved.user.username },
        team: { id: resolved.team.id, name: resolved.team.name },
        session: { expiresAt: resolved.row.expiresAt },
        csrfToken: resolved.csrfToken,
      }),
      { status: 200, headers: securityHeaders({ "content-type": "application/json" }) },
    );
  };

  return { loginPage, githubStart, githubCallback, formContentType, bodyCap, logout, sessionApi };
}
