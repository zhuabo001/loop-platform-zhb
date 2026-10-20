/**
 * The FROZEN public OAuth failure taxonomy (Batch 3 plan §1: "固定 OAuth
 * 错误分类，屏蔽 code、token、secret 和上游敏感错误正文"). These eight
 * values are the ONLY things the login surface can ever say about a failure:
 * the callback redirects to `/login?error=<classification>`, and the login
 * page maps each value to one fixed message. Upstream bodies, the `code`
 * param, access tokens and the client secret NEVER reach a response, a URL,
 * or a log line.
 */
export const OAUTH_FAILURES = [
  /** The user (or GitHub) denied the authorization — callback carried `error`. */
  "access_denied",
  /** No transaction cookie, or no `state` query param. */
  "state_missing",
  /** The transaction cookie names an unknown / consumed / expired transaction. */
  "state_unknown",
  /** The `state` query param does not match the transaction's server-side state. */
  "state_mismatch",
  /** A well-formed success callback without a `code`. */
  "code_missing",
  /** The token exchange or identity query was refused upstream (non-2xx, or a
   *  2xx body carrying GitHub's `error` field). */
  "exchange_failed",
  /** Transport failure or timeout reaching GitHub. */
  "network_error",
  /** A 2xx upstream response that is malformed or fails the identity shape
   *  (missing access_token / id / login, non-numeric id). */
  "response_invalid",
] as const;

export type OAuthFailure = (typeof OAUTH_FAILURES)[number];

/** The adapter-side subset: failures `resolveIdentity` can report (the state
 *  and code verdicts belong to the callback route, which owns the pending
 *  transaction). */
export type GitHubIdentityFailure = "exchange_failed" | "network_error" | "response_invalid";
