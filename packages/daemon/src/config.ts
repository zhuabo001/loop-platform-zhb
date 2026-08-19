/**
 * Daemon startup configuration — a PURE function validated ONCE before any
 * resource opens (mirrors the server's config.ts discipline). Unset or
 * all-whitespace optional values take the defaults; a malformed explicit
 * value fails fast — silent fallback would hide operator error.
 *
 * Phase 2 batch 2 adds the execution-isolation knobs. Parsing stays SYNTAX
 * ONLY with zero filesystem side effects: allowedRoots existence,
 * directory-ness and realpath canonicalization are the jail factory's job
 * (jail.ts), and claudeBin executability is probed by the batch-3
 * composition root — never here.
 *
 * Secret hygiene: the Machine Credential is NEVER echoed into an error
 * message (the server URL is not a secret and may be quoted).
 */
import path from "node:path";

import { isDeviceTokenShape } from "@loopzhb/protocol";

export const DEFAULT_POLL_MS = 3000;
export const MIN_POLL_MS = 250;
export const MAX_POLL_MS = 60000;

export const DEFAULT_CLAUDE_BIN = "claude";
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;
/** 2^31 - 1: the value rides setTimeout, whose delay is a signed 32-bit int. */
export const MAX_AGENT_TIMEOUT_MS = 2_147_483_647;

export interface DaemonConfig {
  /** Absolute http/https URL without credentials, query, fragment or trailing `/`. */
  serverUrl: string;
  /** `dk_…` device token (shape-checked only — the server is the auth boundary). */
  machineCredential: string;
  pollMs: number;
  /** Absolute, `..`-free root directories, exact-deduped, first-seen order.
   *  Syntax-validated ONLY — the jail factory canonicalizes them at startup. */
  allowedRoots: string[];
  /** Claude Code binary name/path; executability is NOT probed here. */
  claudeBin: string;
  agentTimeoutMs: number;
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
  LOOPZHB_ALLOWED_ROOTS?: string | undefined;
  LOOPZHB_CLAUDE_BIN?: string | undefined;
  LOOPZHB_AGENT_TIMEOUT_MS?: string | undefined;
};

export function loadDaemonConfig(env: DaemonConfigEnv): DaemonConfig {
  return {
    serverUrl: parseServerUrl(env.LOOPZHB_SERVER_URL),
    machineCredential: parseMachineCredential(env.LOOPZHB_MACHINE_CREDENTIAL),
    pollMs: parsePollMs(env.LOOPZHB_POLL_MS),
    allowedRoots: parseAllowedRoots(env.LOOPZHB_ALLOWED_ROOTS),
    claudeBin: parseClaudeBin(env.LOOPZHB_CLAUDE_BIN),
    agentTimeoutMs: parseAgentTimeoutMs(env.LOOPZHB_AGENT_TIMEOUT_MS),
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

/** REQUIRED JSON array of absolute, `..`-free path strings; exact duplicates
 *  collapse (first-seen order). SYNTAX ONLY — no stat/realpath here: a root
 *  that is missing, a file, or symlink-aliased is the jail factory's
 *  rejection, not this layer's. Members are kept verbatim (no trimming —
 *  whitespace can be a legitimate path character). */
function parseAllowedRoots(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === "") throw new DaemonConfigError("LOOPZHB_ALLOWED_ROOTS is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DaemonConfigError("LOOPZHB_ALLOWED_ROOTS must be a JSON array of absolute path strings");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new DaemonConfigError("LOOPZHB_ALLOWED_ROOTS must be a non-empty JSON array of absolute path strings");
  }
  const roots: string[] = [];
  for (const member of parsed) {
    if (typeof member !== "string" || !path.isAbsolute(member) || member.split(path.sep).includes("..")) {
      throw new DaemonConfigError("LOOPZHB_ALLOWED_ROOTS members must be absolute paths without .. segments");
    }
    if (!roots.includes(member)) roots.push(member);
  }
  return roots;
}

/** Unset/blank → "claude"; an explicit value is only trimmed — executability
 *  is probed with `shell: false` by the batch-3 composition root. */
function parseClaudeBin(raw: string | undefined): string {
  if (raw == null || raw.trim() === "") return DEFAULT_CLAUDE_BIN;
  return raw.trim();
}

/** Strict decimal milliseconds in [1, 2^31-1]; unset/blank → 1800000 (30min). */
function parseAgentTimeoutMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_AGENT_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new DaemonConfigError(`LOOPZHB_AGENT_TIMEOUT_MS must be a decimal integer, got ${JSON.stringify(raw)}`);
  }
  const ms = Number(trimmed);
  if (ms < 1 || ms > MAX_AGENT_TIMEOUT_MS) {
    throw new DaemonConfigError(`LOOPZHB_AGENT_TIMEOUT_MS out of range (1–${MAX_AGENT_TIMEOUT_MS}): ${ms}`);
  }
  return ms;
}
