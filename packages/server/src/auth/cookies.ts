/**
 * Cookie primitives for the auth module (Batch 3 slice 2, ADR-011 决策 4 and
 * its slice-2 addendum). Pure string builders + a minimal Cookie-header
 * parser — no Hono imports, no I/O, so every attribute is pinned by direct
 * string assertions.
 *
 * The attribute matrix is frozen: HttpOnly, SameSite=Lax, explicit Path,
 * explicit Max-Age, NO Domain; `Secure` iff the configured origin is https
 * (derived from AuthConfig at module construction — NEVER from the request).
 * The session cookie's Max-Age=604800 mirrors the absolute 7-day server-side
 * expiry (user-confirmed 2026-10-07); the OAuth-transaction cookie's 600s
 * mirrors OAUTH_TX_TTL_MS.
 *
 * `hono/cookie` is deliberately not used: the dashboard's lesson (Hono drops
 * prepared headers on a returned bare Response) means this module builds
 * Set-Cookie values itself and the routes attach them to explicit Headers.
 */
export const SESSION_COOKIE = "loopzhb_session";
export const OAUTH_TX_COOKIE = "loopzhb_oauth_tx";

/** Mirrors the absolute 7-day session TTL (ADR-011 决策 4 addendum). */
export const SESSION_COOKIE_MAX_AGE_S = 7 * 24 * 3600; // 604800
/** Mirrors OAUTH_TX_TTL_MS (10-minute pending-transaction lifetime). */
export const OAUTH_TX_COOKIE_MAX_AGE_S = 10 * 60; // 600

export interface CookieOptions {
  /** True iff the configured origin is https. */
  secure: boolean;
}

function attributes(opts: CookieOptions, path: string, maxAgeS: number): string {
  return `HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeS}${opts.secure ? "; Secure" : ""}`;
}

export function buildSessionCookie(value: string, opts: CookieOptions): string {
  return `${SESSION_COOKIE}=${value}; ${attributes(opts, "/", SESSION_COOKIE_MAX_AGE_S)}`;
}

export function buildSessionCookieClear(opts: CookieOptions): string {
  return `${SESSION_COOKIE}=; ${attributes(opts, "/", 0)}`;
}

/** Path=/auth/github prefix-matches the callback; the browser never presents
 *  this cookie to any other route. */
export function buildOAuthTxCookie(value: string, opts: CookieOptions): string {
  return `${OAUTH_TX_COOKIE}=${value}; ${attributes(opts, "/auth/github", OAUTH_TX_COOKIE_MAX_AGE_S)}`;
}

export function buildOAuthTxCookieClear(opts: CookieOptions): string {
  return `${OAUTH_TX_COOKIE}=; ${attributes(opts, "/auth/github", 0)}`;
}

/** Minimal Cookie-header parser: `;`-separated pairs, split on the FIRST
 *  `=` (values may legally contain `=`), whitespace trimmed, entries without
 *  `=` or with an empty name dropped, FIRST occurrence of a duplicate name
 *  wins. Cookie values set by this module are base64url/hex, so no quoting
 *  or decoding is needed or attempted. */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "" || out.has(name)) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}
