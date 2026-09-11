/**
 * The Dashboard's HTTP surface (Batch 3 plan §2 切片二): TWO routes, mounted
 * ONLY when the server is bound to a loopback address.
 *
 *   GET  /                          → the SSR page (3s meta refresh, no JS)
 *   POST /dashboard/loops/:id/run   → Run Now, behind URL-encoded-form + CSRF
 *
 * Threat model — this is a LOCAL page, and the whole design assumes a hostile
 * web page may be talking to it:
 *  - DNS rebinding: after a rebind the browser still believes it is on the
 *    attacker's origin, so responses are READABLE. `hostGate` therefore
 *    rejects any request whose effective host is not loopback, and the caller
 *    registers it GLOBALLY (a dashboard-only gate would leave `/api/loops`
 *    readable and its ids usable for a blind trigger).
 *  - CSRF: a cross-origin form POST carries no token; the token is minted per
 *    bootstrap, never leaves this instance's memory, and is verified before
 *    the coordinator is called.
 *  - Response headers: no-store (the page holds a token), no-referrer (the URL
 *    carries loop ids), nosniff, and a CSP whose only allowance is the hash of
 *    the one inline stylesheet.
 *
 * Every response here is built through `securityHeaders()` — deliberately NOT
 * via Hono's prepared headers, which are dropped whenever a handler or
 * middleware returns a bare `new Response(...)` (verified on 4.12.32; that is
 * exactly the path `bodyLimit`'s onError takes).
 */
import { createHash } from "node:crypto";

import type { Context, Handler, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { EnqueueExecRunResult } from "../store/runs.js";
import { isLoopbackHost } from "../config.js";
import { jsonError } from "../http/json-error.js";
import { checkCsrfForm } from "./csrf.js";
import type { DashboardRead } from "./index.js";
import { DASHBOARD_CSS, renderDashboardPage } from "./page.js";
import { buildDashboardPageModel } from "./view.js";

/** The dashboard form body cap — a single token field needs ~50 bytes. */
export const DASHBOARD_FORM_CAP_BYTES = 4096;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** The CSP's only allowance: the SHA-256 of the one inline <style>, in
 *  standard base64 (NOT base64url), derived from the constant so the header
 *  and the stylesheet can never drift. */
export function dashboardStyleHash(css: string = DASHBOARD_CSS): string {
  return createHash("sha256").update(css).digest("base64");
}

export function dashboardCsp(css: string = DASHBOARD_CSS): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    `style-src 'sha256-${dashboardStyleHash(css)}'`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The security headers EVERY dashboard response carries (see the module
 *  header for why they are applied explicitly rather than prepared). */
export function securityHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": dashboardCsp(),
  });
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function dashboardJson(status: 400 | 403 | 413 | 415 | 500, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: securityHeaders({ "content-type": "application/json" }),
  });
}

/**
 * The request's effective host must be loopback, from BOTH sources that can
 * carry one:
 *  - the `Host` header, when present — an unparseable or userinfo-bearing
 *    value is REJECTED, never treated as "absent" (that conflation would let
 *    `evil.com@127.0.0.1` through: `new URL()` reads its hostname as
 *    127.0.0.1);
 *  - the request URL's host (production node-server builds that URL from the
 *    Host header; Hono's app.request defaults to `http://localhost`).
 * They differ only for an absolute-form request line, which no browser sends —
 * checking both is hardening, and it keeps the gate provable in unit tests.
 */
function hostIsLoopback(c: Context): boolean {
  const rawHeader = c.req.header("host");
  if (rawHeader !== undefined) {
    const header = normalizeHost(rawHeader);
    if (header === null || !isLoopbackHost(header)) return false;
  }

  let url: string | null;
  try {
    url = normalizeHost(new URL(c.req.url).host);
  } catch {
    url = null;
  }
  return url !== null && isLoopbackHost(url);
}

/** `host[:port]` → the bare host, lowercased; `null` for anything malformed or
 *  carrying userinfo. Never throws: a throw here would surface as a 500 and
 *  that would itself be a signal. */
export function normalizeHost(authority: string): string | null {
  if (authority === "" || authority.includes("@")) return null;
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

export interface DashboardRouteDeps {
  /** The read seam — narrow on purpose (see dashboard/index.ts). */
  read: DashboardRead;
  /** The manual trigger, narrowed to its call shape. Slice 3 swaps the body
   *  for `enqueueExecRun(loopId, { kind: "manual", pendingPolicy: "skip" })`
   *  and nothing else in this module changes. */
  enqueue: (loopId: string) => Promise<EnqueueExecRunResult>;
  /** Minted once per bootstrap; test-only injectable (see start.ts). */
  csrfToken: string;
}

export interface DashboardRoutes {
  /** Registered GLOBALLY by the caller, before any route: on a loopback-bound
   *  server every request — dashboard AND JSON API — must address a loopback
   *  host, or it is answered with the ordinary 404. Registering it late, or
   *  per-route, would leave a bypass. */
  hostGate: MiddlewareHandler;
  /** Rejects anything that is not an URL-encoded form (415). Sits before the
   *  body cap so the media type is judged before the body is read. */
  formContentType: MiddlewareHandler;
  bodyCap: MiddlewareHandler;
  index: Handler;
  run: Handler;
}

export function createDashboardRoutes(deps: DashboardRouteDeps): DashboardRoutes {
  const hostGate: MiddlewareHandler = async (c, next) => {
    if (!hostIsLoopback(c)) {
      // Deliberately the SAME response app.notFound produces, with no
      // dashboard headers: "not mounted", "hostile host" and "unknown path"
      // must be indistinguishable.
      return jsonError(c, 404, "not found");
    }
    return next();
  };

  const formContentType: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header("content-type");
    const mediaType = raw?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== FORM_CONTENT_TYPE) {
      return dashboardJson(415, "unsupported media type");
    }
    return next();
  };

  const bodyCap = bodyLimit({
    maxSize: DASHBOARD_FORM_CAP_BYTES,
    // Runs before the handler, so these headers must be built here — a bare
    // Response would otherwise be the one dashboard response without a CSP.
    onError: () => dashboardJson(413, "request body too large"),
  });

  const index: Handler = async () => {
    try {
      const model = buildDashboardPageModel(await deps.read.snapshot());
      return new Response(renderDashboardPage(model, { csrfToken: deps.csrfToken }), {
        status: 200,
        headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
      });
    } catch (err) {
      console.error("[dashboard] unhandled error", err);
      return dashboardJson(500, "internal server error");
    }
  };

  const run: Handler = async (c) => {
    try {
      const verdict = checkCsrfForm(await c.req.text(), deps.csrfToken);
      switch (verdict) {
        case "bad_form":
          return dashboardJson(400, "invalid request");
        case "token_missing":
        case "token_duplicate":
        case "token_mismatch":
          return dashboardJson(403, "forbidden");
        case "ok":
          break;
      }

      // Always present for this route pattern; the fallback folds the
      // impossible case into the ordinary "unknown loop" outcome.
      const loopId = c.req.param("id") ?? "";
      // T7 lives in the coordinator; every business outcome — created, loop
      // gone, completed, already active — is the same redirect, so the page
      // never reports a result it cannot verify. A throw is NOT swallowed into
      // a redirect: 500 must not be disguised as success.
      await deps.enqueue(loopId);
      return new Response(null, {
        status: 303,
        headers: securityHeaders({ location: "/" }),
      });
    } catch (err) {
      console.error("[dashboard] unhandled error", err);
      return dashboardJson(500, "internal server error");
    }
  };

  return { hostGate, formContentType, bodyCap, index, run };
}

/** Re-exported so the composition root has ONE dashboard import for both the
 *  routes object and the path it must register. The constant itself is defined
 *  in view.ts, next to the action builder it has to agree with. */
export { DASHBOARD_RUN_PATH } from "./view.js";
