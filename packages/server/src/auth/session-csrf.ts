/**
 * Session-level form CSRF (Batch 3 slice 2, ADR-011 决策 4 addendum —
 * user-confirmed 2026-10-07): each Login Session's form token is DERIVED
 * from the session credential, `sha256(credential + ":csrf")` — never minted
 * or stored separately.
 *
 * Why derivation instead of a stored token: the plaintext must be deliverable
 * on EVERY `/api/session` response (and later rendered into slice-6 dashboard
 * forms server-side), but a random token stored hash-only is unrecoverable
 * after minting, and storing it plaintext breaks the hash-only discipline of
 * ADR-011 决策 4. Derivation resolves the contradiction: the server recomputes
 * the token from the credential the browser's cookie presents; a database
 * leak (credential hashes only) yields nothing to derive from; and a CSRF
 * attacker — who rides the browser's automatic cookie send but cannot read
 * the HttpOnly cookie value — cannot compute the token. The token is exactly
 * as strong as the credential it guards, and survives restarts for free.
 *
 * The extraction rules are SHARED with the dashboard's boot-level token
 * (`extractSoleCsrfToken`) so the frozen well-formedness/duplicate verdicts
 * cannot drift; only the expected value differs (derived per session here,
 * one boot-level token there — slice 6 re-wires the dashboard forms).
 */
import { timingSafeEqual } from "node:crypto";

import { sha256 } from "@loopzhb/protocol/node";

import { extractSoleCsrfToken } from "../dashboard/csrf.js";

/** The session-level form CSRF token for a given session credential. */
export function deriveSessionCsrfToken(credential: string): string {
  return sha256(`${credential}:csrf`);
}

export type SessionCsrfVerdict = "ok" | "bad_form" | "token_missing" | "token_duplicate" | "token_mismatch";

/** Verify a token-only form against the session's derived token.
 *  Constant-time, with a length pre-check (timingSafeEqual throws on unequal
 *  lengths; an empty expected value must never match). */
export function checkSessionCsrfForm(body: string, expectedToken: string): SessionCsrfVerdict {
  const extracted = extractSoleCsrfToken(body);
  if (!extracted.ok) return extracted.verdict;
  return tokensEqual(extracted.token, expectedToken) ? "ok" : "token_mismatch";
}

function tokensEqual(submitted: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = Buffer.from(submitted, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
