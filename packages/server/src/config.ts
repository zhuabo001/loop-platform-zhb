/**
 * Startup configuration (A-12) — a PURE, package-internal function validated
 * ONCE before any resource opens. Zero-config production boots persist to
 * `~/.loopzhb` (NEVER in-memory; the no-dataDir DB factory is a test-only
 * fixture). Every value may be overridden by env, but a malformed explicit
 * value fails fast — silent fallback to a default would hide operator error.
 */
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR_BASENAME = ".loopzhb";

/** The OAuth callback path, fixed relative to the configured origin (ADR-011
 *  决策 5): the callback URL is origin + this path, frozen at parse time —
 *  never derived from request Host or forwarded headers. */
export const GITHUB_CALLBACK_PATH = "/auth/github/callback";

/** GitHub OAuth configuration (ADR-011 决策 5). REQUIRED — there is no
 *  anonymous fallback: a missing or malformed value fails the boot inside
 *  `loadServerConfig`, before any resource opens. */
export interface AuthConfig {
  /** The normalized public base URL (`URL.origin` form, no trailing slash). */
  origin: string;
  /** origin + GITHUB_CALLBACK_PATH, frozen at parse time. */
  githubCallbackUrl: string;
  githubClientId: string;
  githubClientSecret: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Always ABSOLUTE (relative env input resolves against the boot cwd). */
  dataDir: string;
  auth: AuthConfig;
}

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

export type ServerConfigEnv = {
  LOOPZHB_HOST?: string | undefined;
  LOOPZHB_PORT?: string | undefined;
  LOOPZHB_DATA_DIR?: string | undefined;
  LOOPZHB_ORIGIN?: string | undefined;
  LOOPZHB_GITHUB_CLIENT_ID?: string | undefined;
  LOOPZHB_GITHUB_CLIENT_SECRET?: string | undefined;
};

/** Strict decimal port: 1–65535, nothing else (no signs, fractions, exponent
 *  or whitespace-padded garbage — a bare trim is the only normalization). */
export function parsePort(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new ServerConfigError(`LOOPZHB_PORT must be a decimal integer, got ${JSON.stringify(raw)}`);
  const port = Number(trimmed);
  if (port < 1 || port > 65535) throw new ServerConfigError(`LOOPZHB_PORT out of range (1–65535): ${port}`);
  return port;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Parse and validate LOOPZHB_ORIGIN: a bare http(s) origin — no credentials,
 *  no path/query/fragment; http is accepted for loopback hosts only (ADR-011
 *  决策 5). Returns the normalized `URL.origin`. */
function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServerConfigError(`LOOPZHB_ORIGIN is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ServerConfigError(`LOOPZHB_ORIGIN must use the http or https protocol: ${JSON.stringify(raw)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ServerConfigError(`LOOPZHB_ORIGIN must not embed credentials: ${JSON.stringify(raw)}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ServerConfigError(`LOOPZHB_ORIGIN must be a bare origin without path, query or fragment: ${JSON.stringify(raw)}`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ServerConfigError(
      `LOOPZHB_ORIGIN with the http protocol is accepted for a loopback host only: ${JSON.stringify(raw)}`,
    );
  }
  return url.origin;
}

/** Resolve the GitHub OAuth triple (ADR-011 决策 5). An unset origin derives
 *  from the bind ONLY when the bind is loopback (zero-config local dev); a
 *  non-loopback bind without an explicit origin fails — the callback URL must
 *  come from configured state, never from request headers. The client id and
 *  secret are always required; there is no anonymous fallback. */
export function parseAuthConfig(env: ServerConfigEnv, host: string, port: number): AuthConfig {
  const originRaw = env.LOOPZHB_ORIGIN;
  let origin: string;
  if (originRaw == null || originRaw.trim() === "") {
    if (!isLoopbackHost(host)) {
      throw new ServerConfigError(
        `LOOPZHB_ORIGIN is required when LOOPZHB_HOST is not loopback (got ${JSON.stringify(host)})`,
      );
    }
    // Bracket the bare IPv6 loopback so the derived origin is a valid URL.
    origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
  } else {
    origin = parseOrigin(originRaw.trim());
  }

  const githubClientId = env.LOOPZHB_GITHUB_CLIENT_ID?.trim() ?? "";
  const githubClientSecret = env.LOOPZHB_GITHUB_CLIENT_SECRET?.trim() ?? "";
  const missing: string[] = [];
  if (githubClientId === "") missing.push("LOOPZHB_GITHUB_CLIENT_ID");
  if (githubClientSecret === "") missing.push("LOOPZHB_GITHUB_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new ServerConfigError(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required (GitHub OAuth)`);
  }

  return { origin, githubCallbackUrl: origin + GITHUB_CALLBACK_PATH, githubClientId, githubClientSecret };
}

/** The Phase 1 unauthenticated-exposure warning, or null on loopback. Pure so
 *  the policy is unit-testable without booting. */
export function unauthenticatedExposureWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null;
  return [
    `⚠️  LOOPZHB_HOST=${host}: listening on a NON-loopback address.`,
    "⚠️  Phase 1 has NO authentication on /api/machine/* or the management surface",
    "⚠️  (/api/machines, /api/loops*, /api/runs*) — any reachable client can enroll",
    "⚠️  machines, create loops, drive runs and CANCEL them.",
    "⚠️  Expose this only on a trusted network / inside a container until Phase 5 auth lands.",
  ].join("\n");
}

/** Resolve the effective startup config. Unset or all-whitespace values take
 *  the defaults; explicit malformed values throw ServerConfigError. */
export function loadServerConfig(env: ServerConfigEnv, homeDir: string, cwd: string): ServerConfig {
  const hostRaw = env.LOOPZHB_HOST;
  const host = hostRaw == null || hostRaw.trim() === "" ? DEFAULT_HOST : hostRaw.trim();

  const portRaw = env.LOOPZHB_PORT;
  const port = portRaw == null || portRaw.trim() === "" ? DEFAULT_PORT : parsePort(portRaw);

  const dataDirRaw = env.LOOPZHB_DATA_DIR;
  const dataDir =
    dataDirRaw == null || dataDirRaw.trim() === ""
      ? path.join(homeDir, DEFAULT_DATA_DIR_BASENAME)
      : path.resolve(cwd, dataDirRaw.trim());

  const auth = parseAuthConfig(env, host, port);

  return { host, port, dataDir, auth };
}
