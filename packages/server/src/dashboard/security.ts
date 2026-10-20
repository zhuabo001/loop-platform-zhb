/**
 * The Dashboard's response-security primitives, extracted from `routes.ts` so
 * the access gates (`access.ts`) and the route handlers can share them without
 * a module cycle.
 *
 * Every Dashboard response is built through `securityHeaders()` — deliberately
 * NOT via Hono's prepared headers, which are dropped whenever a handler or
 * middleware returns a bare `new Response(...)` (verified on 4.12.32; that is
 * exactly the path `bodyLimit`'s onError takes).
 */
import { createHash } from "node:crypto";

import { DASHBOARD_CSS } from "./page.js";

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

/** A fixed JSON refusal. 401 belongs here since slice 6: an anonymous
 *  dashboard FORM post must say "not authenticated" before any body parsing. */
export function dashboardJson(status: 400 | 401 | 403 | 413 | 415 | 500, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: securityHeaders({ "content-type": "application/json" }),
  });
}
