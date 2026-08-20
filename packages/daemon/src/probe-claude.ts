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
 */
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
  const runProbe = async (args: string[]): Promise<string> => {
    const result = await spawnWithTimeout({
      command: claudeBin,
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

  return { version: version.join(".") };
}
