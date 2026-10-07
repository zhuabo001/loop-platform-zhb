/**
 * The GitHub OAuth adapter (AU5/AU8/AU12 at the adapter layer): authorize-URL
 * pins (S256 challenge, CONFIG-FROZEN redirect_uri), the exchange→identity
 * sequence, and the full fixed-classification failure taxonomy — all through
 * a scripted recording `fetchImpl`; no real socket.
 *
 * Leak discipline (#118 sentinel precedent): fixture secrets carry SENTINEL
 * substrings; a console spy proves they never reach a log line, and the
 * recorded calls prove the client secret rides ONLY the exchange body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGitHubOAuthAdapter, type GitHubOAuthAdapterDeps } from "./github.js";
import { pkceS256Challenge } from "./pending-tx.js";

const DEPS: GitHubOAuthAdapterDeps = {
  clientId: "test-client-id",
  clientSecret: "test-secret-SENTINEL",
  callbackUrl: "https://loop.example.com/auth/github/callback",
  timeoutMs: 50,
};

const CODE = "oauth-code-SENTINEL";
const TOKEN = "gho_token-SENTINEL";
const VERIFIER = "test-verifier-SENTINEL";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A scripted transport: each queued step answers the next call. */
function scriptedFetch(steps: ((call: RecordedCall) => Promise<Response> | Response)[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error(`unexpected fetch #${calls.length} to ${call.url}`);
    return step(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A call that never answers until the request's own signal aborts it. */
function neverAnswers(call: RecordedCall): Promise<Response> {
  return new Promise((_, reject) => {
    call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("authorizeUrl (AU5/AU12)", () => {
  it("carries client_id, the CONFIG-FROZEN redirect_uri, state, and the S256 challenge — no scope", () => {
    const adapter = createGitHubOAuthAdapter(DEPS);
    const url = new URL(adapter.authorizeUrl({ state: "state-1", codeChallenge: "challenge-1" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://loop.example.com/auth/github/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("pkceS256Challenge (AU5)", () => {
  it("is base64url of the RAW sha256 digest — the RFC 7636 test vector", () => {
    // RFC 7636 Appendix B vector.
    expect(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("resolveIdentity — success", () => {
  it("exchanges the code then fetches the identity; the token never escapes the result", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(200, { access_token: TOKEN, token_type: "bearer" }),
      () => jsonResponse(200, { id: 424242, login: "tester" }),
    ]);
    const adapter = createGitHubOAuthAdapter({ ...DEPS, fetchImpl });
    const result = await adapter.resolveIdentity(CODE, VERIFIER);

    expect(result).toEqual({ ok: true, id: "424242", username: "tester" });
    // The wire shape of both requests.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[0]!.init.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-secret-SENTINEL");
    expect(body.get("code")).toBe(CODE);
    expect(body.get("code_verifier")).toBe(VERIFIER);
    expect(body.get("redirect_uri")).toBe("https://loop.example.com/auth/github/callback");
    expect(calls[1]!.url).toBe("https://api.github.com/user");
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["user-agent"]).toBeTruthy();

    // Leak pin: the result contains neither the token nor any secret.
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });
});

describe("resolveIdentity — fixed failure taxonomy (AU8)", () => {
  async function classify(steps: ((call: RecordedCall) => Promise<Response> | Response)[]): Promise<unknown> {
    const { fetchImpl } = scriptedFetch(steps);
    const adapter = createGitHubOAuthAdapter({ ...DEPS, fetchImpl });
    return adapter.resolveIdentity(CODE, VERIFIER);
  }

  it("exchange non-2xx → exchange_failed", async () => {
    expect(await classify([() => jsonResponse(500, { blame: "SENTINEL upstream body" })])).toEqual({
      ok: false,
      classification: "exchange_failed",
    });
  });

  it("exchange 2xx carrying GitHub's error field → exchange_failed", async () => {
    expect(await classify([() => jsonResponse(200, { error: "bad_verification_code" })])).toEqual({
      ok: false,
      classification: "exchange_failed",
    });
  });

  it("exchange transport throw → network_error", async () => {
    expect(
      await classify([
        () => {
          throw new Error("socket hangup SENTINEL");
        },
      ]),
    ).toEqual({ ok: false, classification: "network_error" });
  });

  it("exchange timeout → network_error (the request's own signal aborts it)", async () => {
    expect(await classify([neverAnswers])).toEqual({ ok: false, classification: "network_error" });
  });

  it("exchange malformed JSON / missing access_token → response_invalid", async () => {
    expect(await classify([() => new Response("not json", { status: 200 })])).toEqual({
      ok: false,
      classification: "response_invalid",
    });
    expect(await classify([() => jsonResponse(200, { token_type: "bearer" })])).toEqual({
      ok: false,
      classification: "response_invalid",
    });
  });

  it("exchange body read fails after 2xx headers (timeout/reset mid-body) → network_error", async () => {
    // Headers arrive, THEN the body stream dies — a transport failure under
    // the frozen taxonomy, not a malformed body. A real Response over an
    // erroring stream, so res.json() rejects the way undici does.
    const bodyBreaks = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new DOMException("The operation timed out.", "TimeoutError"));
          },
        }),
        { status: 200 },
      );
    expect(await classify([bodyBreaks])).toEqual({ ok: false, classification: "network_error" });
    expect(warnings).toEqual(["[auth] oauth network error"]);
  });

  it("identity query non-2xx → exchange_failed; transport throw → network_error", async () => {
    const ok = () => jsonResponse(200, { access_token: TOKEN });
    expect(await classify([ok, () => jsonResponse(401, { message: "bad credentials SENTINEL" })])).toEqual({
      ok: false,
      classification: "exchange_failed",
    });
    expect(
      await classify([
        ok,
        () => {
          throw new Error("reset");
        },
      ]),
    ).toEqual({ ok: false, classification: "network_error" });
    expect(await classify([ok, neverAnswers])).toEqual({ ok: false, classification: "network_error" });
  });

  it("identity malformed / non-numeric id / missing login → response_invalid", async () => {
    const ok = () => jsonResponse(200, { access_token: TOKEN });
    expect(await classify([ok, () => new Response("garbage", { status: 200 })])).toEqual({
      ok: false,
      classification: "response_invalid",
    });
    expect(await classify([ok, () => jsonResponse(200, { id: "12a34", login: "tester" })])).toEqual({
      ok: false,
      classification: "response_invalid",
    });
    expect(await classify([ok, () => jsonResponse(200, { id: 424242 })])).toEqual({
      ok: false,
      classification: "response_invalid",
    });
  });

  it("identity body read fails after 2xx headers → network_error", async () => {
    const ok = () => jsonResponse(200, { access_token: TOKEN });
    const bodyBreaks = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("reset mid-body"));
          },
        }),
        { status: 200 },
      );
    expect(await classify([ok, bodyBreaks])).toEqual({ ok: false, classification: "network_error" });
    expect(warnings).toEqual(["[auth] oauth network error"]);
  });
});

describe("leak discipline across the whole taxonomy", () => {
  it("no log line carries the code, the token, the secret, or an upstream body", async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(500, { blame: "SENTINEL upstream body" }),
      () => jsonResponse(200, { access_token: TOKEN }),
      () => jsonResponse(401, { message: "SENTINEL again" }),
    ]);
    const adapter = createGitHubOAuthAdapter({ ...DEPS, fetchImpl });
    await adapter.resolveIdentity(CODE, VERIFIER);
    await adapter.resolveIdentity(CODE, VERIFIER);
    expect(warnings.length).toBeGreaterThan(0);
    for (const line of warnings) {
      expect(line).not.toContain("SENTINEL");
      expect(line).not.toContain(CODE);
      expect(line).toMatch(/^\[auth\] oauth /);
    }
  });
});
