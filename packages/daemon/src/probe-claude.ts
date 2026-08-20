/**
 * The Claude CLI startup probe (Phase 2 batch 3, plan §2.2): BEFORE the
 * daemon creates its HTTP client (and therefore long before the first poll),
 * it proves the configured binary is a usable Claude Code:
 *
 *   1. `claude --version` — output must carry a semver ≥ MIN_CLAUDE_VERSION;
 *   2. `claude --help` — output must contain every flag this batch's fixed
 *      argv depends on (REQUIRED_CLAUDE_FLAGS).
 *
 * Both run with `shell: false` under the SAME whitelisted agent env the real
 * runs will use (a binary that cannot start under that env would fail every
 * run anyway). The probe has a fixed 10s timeout per invocation. ANY failure
 * — spawn error, non-zero exit, signal, timeout, unparseable version,
 * outdated version, missing flags, unsupported platform — throws a
 * ClaudeProbeError and aborts the daemon startup (fail-closed; plan §2.2).
 *
 * Binary identity (round-1 review P1): the probe first RESOLVES the binary
 * (an explicit path is canonicalized; a bare name is searched on the agent
 * env PATH), runs both probes against the RESOLVED path, and finally pins
 * its inode-level identity (dev/ino/mtimeMs/size). The runner re-stats the
 * resolved path before every spawn and refuses a drifted binary, so a
 * post-probe replacement never receives the agent credentials. The residual
 * stat→execve window is userspace-irreducible and documented in ADR-006.
 */
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { buildAgentEnv } from "./agent-env.js";
import { spawnWithTimeout } from "./subprocess.js";

export const CLAUDE_PROBE_TIMEOUT_MS = 10_000;
export const MIN_CLAUDE_VERSION = "2.1.219";

/** Every flag the batch-3 fixed argv depends on (plan §2.3). */
export const REQUIRED_CLAUDE_FLAGS = [
  "--output-format",
  "--verbose",
  "--safe-mode",
  "--setting-sources",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
  "--tools",
  "--permission-mode",
  "--prompt-suggestions",
  "--settings",
  "--model",
  "--append-system-prompt",
] as const;

export class ClaudeProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeProbeError";
  }
}

export interface ClaudeProbeResult {
  /** The parsed semver, e.g. "2.1.227". */
  version: string;
  /** The pinned binary the probes actually ran against. */
  binary: ClaudeBinaryIdentity;
}

/** The probe-pinned binary identity (round-1 review P1): the realpath-
 *  resolved absolute path plus its inode-level fingerprint. The runner
 *  re-stats the resolved path before EVERY spawn and refuses a drifted
 *  binary — a post-probe replacement never receives the agent credentials. */
export interface ClaudeBinaryIdentity {
  /** The realpath-resolved absolute path pinned at probe time. */
  resolvedPath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

export function sameClaudeBinary(a: ClaudeBinaryIdentity, b: ClaudeBinaryIdentity): boolean {
  return (
    a.resolvedPath === b.resolvedPath &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size
  );
}

/** Stat the pinned binary NOW. Throws raw on any stat failure — the caller
 *  treats that as drift (probe) or as a run failure (runner). */
export async function statClaudeBinary(resolvedPath: string): Promise<ClaudeBinaryIdentity> {
  const st = await stat(resolvedPath);
  if (!st.isFile()) throw new Error(`not a regular file: ${resolvedPath}`);
  return { resolvedPath, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
}

/** Resolve the configured binary to its realpath: an explicit path is
 *  canonicalized directly; a bare name is searched on the AGENT env PATH —
 *  the same env the probes and every real run execute under. */
async function resolveClaudeBin(claudeBin: string, envPath: string | undefined): Promise<string> {
  if (claudeBin.includes("/")) {
    return await realpath(claudeBin);
  }
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, claudeBin);
    try {
      await access(candidate, fsConstants.X_OK);
      const st = await stat(candidate);
      if (!st.isFile()) continue;
      return await realpath(candidate);
    } catch {
      // Not here / not executable — keep searching, like execvp.
    }
  }
  throw new ClaudeProbeError(`cannot resolve claude binary \`${claudeBin}\` on the agent PATH`);
}

/** Parse the first x.y.z triple in the output; null when absent. */
function parseVersion(stdout: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isAtLeast(version: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i]! > min[i]!) return true;
    if (version[i]! < min[i]!) return false;
  }
  return true;
}

/** Token-exact flag detection (round-1 review P2): a lookalike like
 *  `--safe-mode-removed` must NOT satisfy the probe, while real help
 *  typography — `--flag=value`, `--flag, -f`, backtick-quoted — still does.
 *  The flag is therefore matched with non-word/non-hyphen boundaries on both
 *  sides. */
function helpHasFlag(helpOut: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(helpOut);
}

/**
 * Probe the binary. `timeoutMs` is a TEST-ONLY seam (same standing as
 * SpawnOptions.graceMs): production call sites never set it — the fixed 10s
 * policy applies.
 */
export async function probeClaudeBinary(
  claudeBin: string,
  envSource: NodeJS.ProcessEnv,
  timeoutMs: number = CLAUDE_PROBE_TIMEOUT_MS,
): Promise<ClaudeProbeResult> {
  const { env } = buildAgentEnv(envSource);
  // Resolve FIRST, then probe the RESOLVED path: the identity pinned at the
  // end is exactly the file that just proved itself usable (round-1 P1).
  let resolvedPath: string;
  try {
    resolvedPath = await resolveClaudeBin(claudeBin, env.PATH);
  } catch (err) {
    if (err instanceof ClaudeProbeError) throw err;
    throw new ClaudeProbeError(
      `cannot resolve claude binary \`${claudeBin}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const runProbe = async (args: string[]): Promise<string> => {
    const result = await spawnWithTimeout({
      command: resolvedPath,
      args,
      cwd: "/",
      env,
      timeoutMs,
      signal: new AbortController().signal,
    });
    if (result.completion.kind !== "exited" || result.completion.exitCode !== 0) {
      const detail =
        result.completion.kind === "exited"
          ? `exited with code ${result.completion.exitCode}`
          : result.completion.kind === "spawn-error"
            ? `spawn error (${result.completion.code ?? "unknown"}): ${result.completion.message}`
            : result.completion.kind;
      throw new ClaudeProbeError(`probe \`${claudeBin} ${args.join(" ")}\` failed: ${detail}`);
    }
    return result.stdout;
  };

  const versionOut = await runProbe(["--version"]);
  const version = parseVersion(versionOut);
  if (version === null) {
    throw new ClaudeProbeError(`probe \`${claudeBin} --version\` output is unparseable (no semver found)`);
  }
  const min = parseVersion(MIN_CLAUDE_VERSION)!;
  if (!isAtLeast(version, min)) {
    throw new ClaudeProbeError(
      `claude version ${version.join(".")} is older than the required ${MIN_CLAUDE_VERSION}`,
    );
  }

  const helpOut = await runProbe(["--help"]);
  const missing = REQUIRED_CLAUDE_FLAGS.filter((flag) => !helpHasFlag(helpOut, flag));
  if (missing.length > 0) {
    throw new ClaudeProbeError(`probe \`${claudeBin} --help\` is missing required flags: ${missing.join(", ")}`);
  }

  // Pin LAST: the identity is taken from the file that just passed both
  // probes; the runner re-verifies it before every spawn.
  let binary: ClaudeBinaryIdentity;
  try {
    binary = await statClaudeBinary(resolvedPath);
  } catch (err) {
    throw new ClaudeProbeError(
      `cannot stat the resolved claude binary \`${resolvedPath}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { version: version.join("."), binary };
}
