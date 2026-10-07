/**
 * The GitHub OAuth adapter (Batch 3 slice 2): ALL outbound HTTP to GitHub is
 * confined to this module, behind an injectable `fetchImpl` with a per-request
 * timeout (the daemon `createMachineClient` precedent) — tests never touch a
 * real socket.
 *
 * TOKEN CONFINEMENT: the single public operation `resolveIdentity` turns an
 * authorization code into a verified identity; the access token is born and
 * dies INSIDE that one function. It is never returned, never stored, never
 * logged — the type makes it unobtainable (Batch 3 plan §1: "GitHub access
 * token 仅用于本次身份查询，不持久化，也不写入日志").
 *
 * Error classification is fixed (errors.ts): upstream bodies, the code, the
 * token and the client secret never propagate. Log lines are fixed strings —
 * the only variable part ever logged is an HTTP status NUMBER.
 */
import { GITHUB_USER_ID_RE } from "../db/schema.js";
import type { GitHubIdentityFailure } from "./errors.js";

export type { GitHubIdentityFailure } from "./errors.js";

export type GitHubIdentityResult =
  | { ok: true; id: string; username: string }
  | { ok: false; classification: GitHubIdentityFailure };

export interface GitHubOAuthAdapter {
  /** The github.com authorization redirect: client_id, the CONFIG-FROZEN
   *  redirect_uri (never derived from the request Host), one-time state, and
   *  the PKCE S256 challenge. No `scope`: the default public-profile scope
   *  suffices for /user. */
  authorizeUrl(params: { state: string; codeChallenge: string }): string;
  /** Exchange the code and fetch the user identity, end to end. */
  resolveIdentity(code: string, codeVerifier: string): Promise<GitHubIdentityResult>;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_AGENT = "loopzhb-server";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GitHubOAuthAdapterDeps {
  clientId: string;
  clientSecret: string;
  /** authConfig.githubCallbackUrl — frozen at config parse. */
  callbackUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createGitHubOAuthAdapter(deps: GitHubOAuthAdapterDeps): GitHubOAuthAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** One request with the per-request timeout. Resolves with the Response or
   *  a credential-free failure classification. */
  async function request(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: true; res: Response } | { ok: false; classification: "network_error" }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: timeout });
      return { ok: true, res };
    } catch {
      console.warn(timeout.aborted ? `[auth] oauth request timeout after ${timeoutMs}ms` : "[auth] oauth network error");
      return { ok: false, classification: "network_error" };
    }
  }

  /** Read a response body as JSON, preserving the frozen taxonomy boundary:
   *  a SyntaxError means the body fully ARRIVED but is not JSON
   *  (`response_invalid`); ANY other rejection — the per-request signal
   *  aborting the body read (timeout) or a transport reset mid-body — is a
   *  `network_error`, exactly as a fetch-level throw is. Headers arriving
   *  first does not turn a body-read transport failure into a parse
   *  failure. */
  async function parseJson(
    res: Response,
  ): Promise<{ ok: true; body: unknown } | { ok: false; classification: "network_error" | "response_invalid" }> {
    try {
      return { ok: true, body: await res.json() };
    } catch (err) {
      return { ok: false, classification: err instanceof SyntaxError ? "response_invalid" : "network_error" };
    }
  }

  return {
    authorizeUrl({ state, codeChallenge }) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", deps.clientId);
      url.searchParams.set("redirect_uri", deps.callbackUrl);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async resolveIdentity(code, codeVerifier) {
      // Step 1 — exchange the code. The client secret exists ONLY in this
      // request body; the access token only in the parsed response below.
      const exchange = await request(TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          code,
          redirect_uri: deps.callbackUrl,
          code_verifier: codeVerifier,
        }).toString(),
      });
      if (!exchange.ok) return exchange;
      if (!exchange.res.ok) {
        console.warn(`[auth] oauth exchange failed (HTTP ${exchange.res.status})`);
        return { ok: false, classification: "exchange_failed" };
      }
      const tokenBody = await parseJson(exchange.res);
      if (!tokenBody.ok) {
        console.warn(
          tokenBody.classification === "network_error"
            ? "[auth] oauth network error"
            : "[auth] oauth exchange response invalid",
        );
        return tokenBody;
      }
      if (typeof tokenBody.body !== "object" || tokenBody.body === null) {
        console.warn("[auth] oauth exchange response invalid");
        return { ok: false, classification: "response_invalid" };
      }
      const tokenFields = tokenBody.body as Record<string, unknown>;
      if (typeof tokenFields.error === "string") {
        // GitHub reports a failed exchange as 200 + {error: …}. The error
        // VALUE stays out of the log.
        console.warn("[auth] oauth exchange failed (HTTP 200)");
        return { ok: false, classification: "exchange_failed" };
      }
      const accessToken = tokenFields.access_token;
      if (typeof accessToken !== "string" || accessToken === "") {
        console.warn("[auth] oauth exchange response invalid");
        return { ok: false, classification: "response_invalid" };
      }

      // Step 2 — the ONE identity query the token exists for.
      const user = await request(USER_URL, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": USER_AGENT,
        },
      });
      if (!user.ok) return user;
      if (!user.res.ok) {
        console.warn(`[auth] oauth identity query failed (HTTP ${user.res.status})`);
        return { ok: false, classification: "exchange_failed" };
      }
      const userBody = await parseJson(user.res);
      if (!userBody.ok) {
        console.warn(
          userBody.classification === "network_error"
            ? "[auth] oauth network error"
            : "[auth] oauth identity response invalid",
        );
        return userBody;
      }
      if (typeof userBody.body !== "object" || userBody.body === null) {
        console.warn("[auth] oauth identity response invalid");
        return { ok: false, classification: "response_invalid" };
      }
      const fields = userBody.body as Record<string, unknown>;
      const id = typeof fields.id === "number" ? String(fields.id) : fields.id;
      if (typeof id !== "string" || !GITHUB_USER_ID_RE.test(id) || typeof fields.login !== "string") {
        console.warn("[auth] oauth identity response invalid");
        return { ok: false, classification: "response_invalid" };
      }
      return { ok: true, id, username: fields.login };
    },
  };
}
