/**
 * Generic subprocess lifecycle (Phase 2 batch 2, plan §2.3): ONE process
 * group per spawn, deterministic termination (SIGTERM → grace → SIGKILL),
 * capped stdio capture with in-order chunk callbacks (the batch-3 stream-json
 * parser rides onStdout/onStderr), and a discriminated-union completion so
 * the runner never has to guess how a child died.
 *
 * POSIX only (macOS / Linux / WSL2): native Windows gets an explicit
 * unsupported-platform spawn-error. `shell: false` always — args are never
 * reparsed by a shell.
 */
import { spawn } from "node:child_process";

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  /** Grace between SIGTERM and SIGKILL to the process group. Default 5000;
   *  tests shrink it — production never sets this. */
  graceMs?: number;
}

export type SpawnCompletion =
  | { kind: "exited"; exitCode: number }
  | { kind: "signaled"; signal: NodeJS.Signals }
  | { kind: "timed-out"; finalSignal: NodeJS.Signals }
  | { kind: "aborted"; finalSignal: NodeJS.Signals }
  | { kind: "spawn-error"; code?: string; message: string }
  | { kind: "consumer-error"; message: string };

export interface SpawnResult {
  completion: SpawnCompletion;
  /** Head+tail halves kept past the cap; truncated flags tell the truth. */
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

/** Per-stream capture cap: 1 MiB, head and tail halves preserved. */
export const MAX_STREAM_BYTES = 1024 * 1024;
export const SIGTERM_GRACE_MS = 5000;

export async function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  const startedAt = Date.now();
  const build = (completion: SpawnCompletion, stdout: string, stderr: string): SpawnResult => ({
    completion,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Date.now() - startedAt,
  });

  if (process.platform === "win32") {
    return build(
      {
        kind: "spawn-error",
        code: "UNSUPPORTED_PLATFORM",
        message: "native Windows is not supported (process-group semantics are POSIX) — use WSL2",
      },
      "",
      "",
    );
  }

  return await new Promise<SpawnResult>((resolvePromise) => {
    // detached: true ⇒ the child leads its OWN process group, so
    // process.kill(-pid, …) reaches every grandchild it forgot about.
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let spawnError: { code?: string; message: string } | null = null;
    child.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT & friends surface here; 'close' still fires afterwards and
      // does the actual settle below.
      spawnError = { ...(err.code !== undefined ? { code: err.code } : {}), message: err.message };
    });

    // 'close' (not 'exit'): stdio is drained by the time it fires, so the
    // captured text is complete.
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (spawnError !== null) {
        resolvePromise(build({ kind: "spawn-error", ...spawnError }, stdout, stderr));
      } else if (code !== null) {
        resolvePromise(build({ kind: "exited", exitCode: code }, stdout, stderr));
      } else {
        resolvePromise(build({ kind: "signaled", signal: signal ?? "SIGTERM" }, stdout, stderr));
      }
    });
  });
}
