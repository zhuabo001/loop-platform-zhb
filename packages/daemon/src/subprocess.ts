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
  void opts;
  return {
    completion: { kind: "spawn-error", message: "spawnWithTimeout is not implemented yet" },
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
  };
}
