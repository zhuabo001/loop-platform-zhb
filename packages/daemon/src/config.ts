/**
 * Daemon startup configuration — a PURE function validated ONCE before any
 * resource opens (mirrors the server's config.ts discipline). Unset or
 * all-whitespace optional values take the defaults; a malformed explicit
 * value fails fast — silent fallback would hide operator error.
 *
 * Secret hygiene: the Machine Credential is NEVER echoed into an error
 * message (the server URL is not a secret and may be quoted).
 */
import { isDeviceTokenShape } from "@loopzhb/protocol";

export const DEFAULT_POLL_MS = 3000;
export const MIN_POLL_MS = 250;
export const MAX_POLL_MS = 60000;

export interface DaemonConfig {
  /** Absolute http/https URL without credentials, query, fragment or trailing `/`. */
  serverUrl: string;
  /** `dk_…` device token (shape-checked only — the server is the auth boundary). */
  machineCredential: string;
  pollMs: number;
}

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConfigError";
  }
}

export type DaemonConfigEnv = {
  LOOPZHB_SERVER_URL?: string | undefined;
  LOOPZHB_MACHINE_CREDENTIAL?: string | undefined;
  LOOPZHB_POLL_MS?: string | undefined;
};

export function loadDaemonConfig(env: DaemonConfigEnv): DaemonConfig {
  return {
    serverUrl: parseServerUrl(env.LOOPZHB_SERVER_URL),
    machineCredential: parseMachineCredential(env.LOOPZHB_MACHINE_CREDENTIAL),
    pollMs: parsePollMs(env.LOOPZHB_POLL_MS),
  };
}

/** Absolute http/https URL: no userinfo, no query, no fragment; trailing
 *  slashes removed so route join is `baseUrl + "/api/machine/…"` exactly. */
function parseServerUrl(raw: string | undefined): string {
  if (raw == null || raw.trim() === "") throw new DaemonConfigError("LOOPZHB_SERVER_URL is required");
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DaemonConfigError(`LOOPZHB_SERVER_URL is not a valid URL: ${JSON.stringify(trimmed)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DaemonConfigError(`LOOPZHB_SERVER_URL must be http or https: ${JSON.stringify(trimmed)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new DaemonConfigError("LOOPZHB_SERVER_URL must not contain userinfo");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new DaemonConfigError("LOOPZHB_SERVER_URL must not contain a query or fragment");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Shape check is a CHEAP startup input filter (ADR-002): a well-shaped but
 *  unknown token is still rejected by the server on first poll (→ poll 401
 *  fail-fast). The value itself never enters the error message. */
function parseMachineCredential(raw: string | undefined): string {
  if (raw == null || raw.trim() === "") throw new DaemonConfigError("LOOPZHB_MACHINE_CREDENTIAL is required");
  const credential = raw.trim();
  if (!isDeviceTokenShape(credential)) {
    throw new DaemonConfigError("LOOPZHB_MACHINE_CREDENTIAL must be a dk_-prefixed device token (shape check failed)");
  }
  return credential;
}

/** Strict decimal milliseconds in [250, 60000]; unset/blank → 3000. */
function parsePollMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_POLL_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new DaemonConfigError(`LOOPZHB_POLL_MS must be a decimal integer, got ${JSON.stringify(raw)}`);
  }
  const pollMs = Number(trimmed);
  if (pollMs < MIN_POLL_MS || pollMs > MAX_POLL_MS) {
    throw new DaemonConfigError(`LOOPZHB_POLL_MS out of range (${MIN_POLL_MS}–${MAX_POLL_MS}): ${pollMs}`);
  }
  return pollMs;
}
