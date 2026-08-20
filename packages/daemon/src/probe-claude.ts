/**
 * The Claude CLI startup probe (Phase 2 batch 3, plan §2.2): BEFORE the
 * daemon creates its HTTP client (and therefore long before the first poll),
 * it proves the configured binary is a usable Claude Code:
 *
 *   1. `claude --version` — output must carry a semver ≥ MIN_CLAUDE_VERSION;
 *   2. `claude --help` — output must contain every flag this batch's fixed
 *      argv depends on (REQUIRED_CLAUDE_FLAGS).
 *
 * Both run with `shell: false` under a credential-free subset of the agent
 * allow-list: system/config/TLS variables remain for compatibility, while
 * provider, OAuth and proxy credentials are withheld. The probe has a fixed
 * 10s timeout per invocation. ANY failure
 * — spawn error, non-zero exit, signal, timeout, unparseable version,
 * outdated version, missing flags, unsupported platform — throws a
 * ClaudeProbeError and aborts the daemon startup (fail-closed; plan §2.2).
 *
 * Binary identity (round-1 review P1): the probe first RESOLVES the binary
 * (an explicit path is canonicalized; a bare name is searched on the agent
 * env PATH), pins its stat+sha256 identity, and verifies that identity before
 * and after EACH probe invocation. The runner re-checks the resolved path
 * before every real spawn and refuses drift. The residual stat→execve
 * window and same-UID trust boundary are documented in ADR-006. Every hash
 * has its own 10s deadline; real-Run checks also observe shutdown aborts.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { buildProbeEnv } from "./agent-env.js";
import { spawnWithTimeout } from "./subprocess.js";

export const CLAUDE_PROBE_TIMEOUT_MS = 10_000;
export const CLAUDE_BINARY_HASH_TIMEOUT_MS = 10_000;
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

/** The probe-pinned binary identity (round-1 review P1, round-2 hardened):
 *  the realpath-resolved absolute path, its inode-level fingerprint, and a
 *  sha256 of the CONTENT — a same-inode, same-size, restored-mtime in-place
 *  overwrite still differs by hash. The runner re-stats (and re-hashes) the
 *  resolved path before EVERY spawn and refuses any observed drift. The
 *  same-UID stat/hash→execve residual is accepted in ADR-006. */
export interface ClaudeBinaryIdentity {
  /** The realpath-resolved absolute path pinned at probe time. */
  resolvedPath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  sha256: string;
}

export function sameClaudeBinary(a: ClaudeBinaryIdentity, b: ClaudeBinaryIdentity): boolean {
  return (
    a.resolvedPath === b.resolvedPath &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.sha256 === b.sha256
  );
}

/** Stream a file's sha256 — the CLI binary can be hundreds of MiB. */
async function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { signal })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export interface ClaudeBinaryCheckOptions {
  /** Run shutdown cancels an identity check before spawn. */
  signal?: AbortSignal;
  /** Independent I/O deadline; defaults to ten seconds. */
  timeoutMs?: number;
}

async function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Stat AND hash the pinned binary NOW. Throws raw on any failure — the
 *  caller treats that as drift (probe) or as a run failure (runner). */
export async function statClaudeBinary(
  resolvedPath: string,
  options: ClaudeBinaryCheckOptions = {},
): Promise<ClaudeBinaryIdentity> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CLAUDE_BINARY_HASH_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  return await withAbort(
    async () => {
      const st = await stat(resolvedPath);
      if (!st.isFile()) throw new Error(`not a regular file: ${resolvedPath}`);
      const sha256 = await sha256File(resolvedPath, signal);
      return { resolvedPath, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, sha256 };
    },
    signal,
  );
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
  const env = buildProbeEnv(envSource);
  // Resolve first, then bind every individual probe to the same stat+hash
  // identity before AND after its spawn. Probe children deliberately receive
  // no credentials; the full agent env is reserved for a real Run after the
  // runner performs its own immediate identity check.
  let resolvedPath: string;
  try {
    resolvedPath = await resolveClaudeBin(claudeBin, env.PATH);
  } catch (err) {
    if (err instanceof ClaudeProbeError) throw err;
    throw new ClaudeProbeError(
      `cannot resolve claude binary \`${claudeBin}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let binary: ClaudeBinaryIdentity;
  try {
    binary = await statClaudeBinary(resolvedPath, { timeoutMs });
  } catch (err) {
    throw new ClaudeProbeError(
      `cannot stat the resolved claude binary \`${resolvedPath}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const assertIdentity = async (stage: string): Promise<void> => {
    let observed: ClaudeBinaryIdentity;
    try {
      observed = await statClaudeBinary(resolvedPath, { timeoutMs });
    } catch (err) {
      throw new ClaudeProbeError(
        `cannot stat the resolved claude binary \`${resolvedPath}\`: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!sameClaudeBinary(binary, observed)) {
      throw new ClaudeProbeError(`claude binary \`${resolvedPath}\` changed ${stage} — refusing to pin it`);
    }
  };
  const runProbe = async (args: string[]): Promise<string> => {
    const invocation = `\`${args.join(" ")}\``;
    await assertIdentity(`before ${invocation}`);
    const result = await spawnWithTimeout({
      command: resolvedPath,
      args,
      cwd: "/",
      env,
      timeoutMs,
      signal: new AbortController().signal,
    });
    await assertIdentity(`during ${invocation}`);
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

  return { version: version.join("."), binary };
}
