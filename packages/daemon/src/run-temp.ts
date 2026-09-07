/**
 * The per-Run Claude temp root (Issue #50, sandbox-compat plan §3 每 Run
 * 的临时文件能力 — validated by the variant-B/D experiment matrix on
 * Claude Code 2.1.236): the CLI's sandboxed Bash runs every command from a
 * per-command `cwd-*` directory under its temp root. The default root
 * (`/tmp/claude-<uid>`) is NOT covered by the daemon's seatbelt profile,
 * which poisons every command's exit status (`zsh: operation not
 * permitted`) and kills wrapper Node startup (getcwd on a denied cwd).
 * Minting a private, profile-covered root per Run and pointing
 * `CLAUDE_CODE_TMPDIR` at it restores accurate command status and wrapper
 * execution.
 *
 * Discipline:
 *  - minted per Run, 0700, on the CANONICAL temp base (`/private/tmp` on
 *    macOS — never the `/tmp` symlink; the realpath of the system temp dir
 *    elsewhere), with a short credential-free prefix; separate from the
 *    wrapper, context and outbox directories;
 *  - the runner grants exactly THIS root read+write in the sandbox profile
 *    — never the shared-UID temp dir — and sets CLAUDE_CODE_TMPDIR itself
 *    after user-env filtering (a user/settings value can neither override
 *    it nor widen the profile);
 *  - release is fail-closed like run-control's: a swapped (symlink /
 *    non-directory / wrong-parent) root is refused, and a failed release
 *    fails the Run without ever masking an in-flight ProcessControlError.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_TEMP_PREFIX = "lzc-";

export interface PreparedRunTemp {
  /** The canonical per-Run temp root (0700) the runner grants and exports. */
  tmpRoot: string;
  /** The canonical base the root was minted under — release re-verifies the
   *  root's identity against it before deleting anything. */
  baseDir: string;
}

type RunTempIo = Pick<typeof fs, "realpath" | "mkdtemp" | "chmod" | "rm">;

export async function prepareClaudeRunTemp(io: RunTempIo = fs): Promise<PreparedRunTemp> {
  // macOS: mint directly under canonical /private/tmp (short path — the
  // sandbox profile and kernel shebang both prefer it). Elsewhere the
  // canonical system temp dir: realpath collapses the /tmp → /private/tmp
  // style symlink before any path is computed.
  const baseDir = process.platform === "darwin" ? "/private/tmp" : await io.realpath(os.tmpdir());
  const tmpRoot = await io.mkdtemp(path.join(baseDir, RUN_TEMP_PREFIX));
  try {
    await io.chmod(tmpRoot, 0o700);
  } catch (err) {
    await io.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { tmpRoot, baseDir };
}

/** Fail-closed release, same discipline as run-control's: pure
 *  path-identity checks BEFORE touching the filesystem, refuse a swapped
 *  (symlink / non-directory) root — never follow it — and NO force flag:
 *  an already-missing root (an agent could have deleted it) is a release
 *  failure, not silent success. */
export async function releaseClaudeRunTemp(prepared: PreparedRunTemp): Promise<void> {
  if (
    path.dirname(prepared.tmpRoot) !== prepared.baseDir ||
    !path.basename(prepared.tmpRoot).startsWith(RUN_TEMP_PREFIX)
  ) {
    throw new Error(`run temp identity mismatch: ${prepared.tmpRoot}`);
  }
  const stat = await fs.lstat(prepared.tmpRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`run temp root was replaced before release: ${prepared.tmpRoot}`);
  }
  await fs.rm(prepared.tmpRoot, { recursive: true });
}
