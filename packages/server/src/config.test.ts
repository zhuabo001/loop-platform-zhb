/**
 * Startup config (A-12): defaults, overrides, blank handling, the strict port
 * matrix and the loopback warning policy — all pure, no resources opened.
 *
 * Phase 5 Batch 3 (ADR-011 决策 5): the GitHub OAuth triple
 * (LOOPZHB_ORIGIN / LOOPZHB_GITHUB_CLIENT_ID / LOOPZHB_GITHUB_CLIENT_SECRET)
 * is validated here, BEFORE any resource opens; missing or malformed values
 * fail the boot — there is no anonymous fallback.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  GITHUB_CALLBACK_PATH,
  isLoopbackHost,
  loadServerConfig,
  parsePort,
  unauthenticatedExposureWarning,
} from "./config.js";

const HOME = "/home/tester";
const CWD = "/srv/app";

/** A minimal valid OAuth env — the zero-config loopback boot needs exactly
 *  these two (origin derives from the loopback bind). */
const OAUTH_ENV = {
  LOOPZHB_GITHUB_CLIENT_ID: "gh-client-id",
  LOOPZHB_GITHUB_CLIENT_SECRET: "gh-client-secret",
} as const;

describe("loadServerConfig", () => {
  it("zero-config boots to 127.0.0.1:3000 with ~/.loopzhb (never in-memory) and a derived loopback origin", () => {
    expect(loadServerConfig({ ...OAUTH_ENV }, HOME, CWD)).toEqual({
      host: "127.0.0.1",
      port: 3000,
      dataDir: "/home/tester/.loopzhb",
      auth: {
        origin: "http://127.0.0.1:3000",
        githubCallbackUrl: `http://127.0.0.1:3000${GITHUB_CALLBACK_PATH}`,
        githubClientId: "gh-client-id",
        githubClientSecret: "gh-client-secret",
      },
    });
  });

  it("honors explicit overrides, including an explicit origin", () => {
    expect(
      loadServerConfig(
        {
          LOOPZHB_HOST: "0.0.0.0",
          LOOPZHB_PORT: "8787",
          LOOPZHB_DATA_DIR: "/data/loop",
          LOOPZHB_ORIGIN: "https://loop.example.com",
          ...OAUTH_ENV,
        },
        HOME,
        CWD,
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 8787,
      dataDir: "/data/loop",
      auth: {
        origin: "https://loop.example.com",
        githubCallbackUrl: `https://loop.example.com${GITHUB_CALLBACK_PATH}`,
        githubClientId: "gh-client-id",
        githubClientSecret: "gh-client-secret",
      },
    });
  });

  it("treats unset and all-whitespace host/port/dataDir identically (defaults)", () => {
    for (const blank of [undefined, "", "   \n\t  "]) {
      expect(
        loadServerConfig({ LOOPZHB_HOST: blank, LOOPZHB_PORT: blank, LOOPZHB_DATA_DIR: blank, ...OAUTH_ENV }, HOME, CWD),
      ).toEqual({
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        dataDir: `${HOME}/.loopzhb`,
        auth: {
          origin: "http://127.0.0.1:3000",
          githubCallbackUrl: `http://127.0.0.1:3000${GITHUB_CALLBACK_PATH}`,
          githubClientId: "gh-client-id",
          githubClientSecret: "gh-client-secret",
        },
      });
    }
  });

  it("resolves a relative DATA_DIR against the boot cwd to an absolute path", () => {
    expect(loadServerConfig({ LOOPZHB_DATA_DIR: "data/pg", ...OAUTH_ENV }, HOME, CWD).dataDir).toBe("/srv/app/data/pg");
    expect(loadServerConfig({ LOOPZHB_DATA_DIR: "./x", ...OAUTH_ENV }, HOME, CWD).dataDir).toBe("/srv/app/x");
  });
});

describe("parsePort: the strict 1–65535 decimal matrix", () => {
  it("accepts the boundaries and ordinary values", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("3000")).toBe(3000);
  });

  it.each(["0", "-1", "65536", "99999", "3.5", "1e3", "abc", "0x10", "12 34", "3_000"])(
    "rejects %j at boot (fail fast, never a silent fallback)",
    (bad) => {
      expect(() => parsePort(bad)).toThrow(/LOOPZHB_PORT/);
    },
  );
});

describe("loopback policy", () => {
  it("loopback hosts produce NO warning", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(unauthenticatedExposureWarning(host)).toBeNull();
    }
  });

  it("a non-loopback host produces the unauthenticated-exposure warning naming the host", () => {
    const warning = unauthenticatedExposureWarning("0.0.0.0");
    expect(warning).toContain("0.0.0.0");
    expect(warning).toMatch(/NO authentication/);
    // The Day 8–10 cancel route is part of the unauthenticated surface.
    expect(warning).toContain("/api/runs*");
    expect(unauthenticatedExposureWarning("192.168.1.10")).not.toBeNull();
  });
});

describe("auth config (ADR-011 决策 5): no anonymous fallback", () => {
  it("missing OAuth credentials fail the boot, one error naming BOTH missing variables", () => {
    expect(() => loadServerConfig({}, HOME, CWD)).toThrow(/LOOPZHB_GITHUB_CLIENT_ID/);
    expect(() => loadServerConfig({}, HOME, CWD)).toThrow(/LOOPZHB_GITHUB_CLIENT_SECRET/);
    expect(() => loadServerConfig({}, HOME, CWD)).toThrow(/required/);
  });

  it.each([
    [{ LOOPZHB_GITHUB_CLIENT_SECRET: "s" }, /LOOPZHB_GITHUB_CLIENT_ID/],
    [{ LOOPZHB_GITHUB_CLIENT_ID: "i" }, /LOOPZHB_GITHUB_CLIENT_SECRET/],
    [{ LOOPZHB_GITHUB_CLIENT_ID: "   ", LOOPZHB_GITHUB_CLIENT_SECRET: "s" }, /LOOPZHB_GITHUB_CLIENT_ID/],
    [{ LOOPZHB_GITHUB_CLIENT_ID: "i", LOOPZHB_GITHUB_CLIENT_SECRET: "  \n " }, /LOOPZHB_GITHUB_CLIENT_SECRET/],
  ] as const)("a missing or all-whitespace credential fails naming its variable: %j", (env, pattern) => {
    expect(() => loadServerConfig(env, HOME, CWD)).toThrow(pattern);
  });

  it("the callback URL is origin + the fixed path, frozen at parse time", () => {
    const config = loadServerConfig(
      { LOOPZHB_ORIGIN: "https://loop.example.com", ...OAUTH_ENV },
      HOME,
      CWD,
    );
    expect(config.auth.githubCallbackUrl).toBe("https://loop.example.com/auth/github/callback");
  });
});

describe("origin policy (ADR-011 决策 5)", () => {
  it("an unset origin derives from a loopback bind only", () => {
    expect(loadServerConfig({ ...OAUTH_ENV }, HOME, CWD).auth.origin).toBe("http://127.0.0.1:3000");
    expect(
      loadServerConfig({ LOOPZHB_HOST: "localhost", LOOPZHB_PORT: "8080", ...OAUTH_ENV }, HOME, CWD).auth.origin,
    ).toBe("http://localhost:8080");
    expect(loadServerConfig({ LOOPZHB_HOST: "::1", ...OAUTH_ENV }, HOME, CWD).auth.origin).toBe("http://[::1]:3000");
  });

  it("a non-loopback bind WITHOUT an explicit origin fails — the callback URL never derives from request headers", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "loop.internal"]) {
      expect(() => loadServerConfig({ LOOPZHB_HOST: host, ...OAUTH_ENV }, HOME, CWD), host).toThrow(/LOOPZHB_ORIGIN/);
    }
  });

  it.each([
    "https://loop.example.com",
    "https://loop.example.com:8443",
    "https://loop.example.com/", // trailing slash normalizes away
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://[::1]:3000",
  ])("accepts %j", (origin) => {
    const config = loadServerConfig({ LOOPZHB_ORIGIN: origin, ...OAUTH_ENV }, HOME, CWD);
    expect(config.auth.origin).toBe(new URL(origin).origin);
  });

  it.each([
    "http://loop.example.com", // http is loopback-only
    "http://192.168.1.10",
    "http://example.com:8080/",
  ])("rejects the non-loopback http origin %j", (origin) => {
    expect(() => loadServerConfig({ LOOPZHB_ORIGIN: origin, ...OAUTH_ENV }, HOME, CWD)).toThrow(/LOOPZHB_ORIGIN/);
  });

  it.each([
    "not-a-url",
    "ftp://loop.example.com",
    "file:///etc/passwd",
    "https://user:pass@loop.example.com",
    "https://loop.example.com/app",
    "https://loop.example.com/?x=1",
    "https://loop.example.com/#frag",
  ])("rejects the malformed origin %j", (origin) => {
    expect(() => loadServerConfig({ LOOPZHB_ORIGIN: origin, ...OAUTH_ENV }, HOME, CWD)).toThrow(/LOOPZHB_ORIGIN/);
  });

  it("an explicit origin wins over the bind for callback derivation (https origin on a loopback bind)", () => {
    const config = loadServerConfig(
      { LOOPZHB_ORIGIN: "https://loop.example.com", ...OAUTH_ENV },
      HOME,
      CWD,
    );
    expect(config.auth.origin).toBe("https://loop.example.com");
    expect(config.auth.githubCallbackUrl).toBe("https://loop.example.com/auth/github/callback");
  });
});
