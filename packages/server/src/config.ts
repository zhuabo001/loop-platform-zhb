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

export interface ServerConfig {
  host: string;
  port: number;
  /** Always ABSOLUTE (relative env input resolves against the boot cwd). */
  dataDir: string;
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

/** The Phase 1 unauthenticated-exposure warning, or null on loopback. Pure so
 *  the policy is unit-testable without booting. */
export function unauthenticatedExposureWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null;
  return [
    `⚠️  LOOPZHB_HOST=${host}: listening on a NON-loopback address.`,
    "⚠️  Phase 1 has NO authentication on /api/machine/* or the management surface",
    "⚠️  (/api/machines, /api/loops*) — any reachable client can enroll machines,",
    "⚠️  create loops and drive runs.",
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

  return { host, port, dataDir };
}
