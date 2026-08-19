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

const HALF_CAP = MAX_STREAM_BYTES / 2;

/** Rolling head+tail capture. While the total fits the cap, head and tail
 *  stay CONTIGUOUS (text() is the exact stream); the first byte that must be
 *  dropped flips `truncated` for good. */
class CappedStream {
  private headParts: Buffer[] = [];
  private headBytes = 0;
  private tailParts: Buffer[] = [];
  private tailBytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < HALF_CAP) {
      const take = Math.min(HALF_CAP - this.headBytes, rest.length);
      this.headParts.push(Buffer.from(rest.subarray(0, take)));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tailParts.push(Buffer.from(rest));
    this.tailBytes += rest.length;
    while (this.tailBytes > HALF_CAP) {
      this.truncated = true;
      const excess = this.tailBytes - HALF_CAP;
      const first = this.tailParts[0]!;
      if (first.length <= excess) {
        this.tailParts.shift();
        this.tailBytes -= first.length;
      } else {
        this.tailParts[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat([...this.headParts, ...this.tailParts]).toString("utf8");
  }
}

export async function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  const startedAt = Date.now();

  if (process.platform === "win32") {
    return {
      completion: {
        kind: "spawn-error",
        code: "UNSUPPORTED_PLATFORM",
        message: "native Windows is not supported (process-group semantics are POSIX) — use WSL2",
      },
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
    };
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

    const stdoutCap = new CappedStream();
    const stderrCap = new CappedStream();
    let spawnError: { code?: string; message: string } | null = null;
    let consumerError: string | null = null;
    let terminationStarted = false;

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    /** Group liveness via kill(-pgid, 0): ESRCH ⇒ gone (NOT an error —
     *  S16); any other kill failure must propagate, never be swallowed. */
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw err;
      }
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };

    /** Idempotent TERM → grace → KILL against the WHOLE process group. The
     *  timeout/abort triggers (pair 3) and the group reap on normal exit
     *  (S9) reuse this same routine. */
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      void (async () => {
        try {
          signalGroup("SIGTERM");
          const graceMs = opts.graceMs ?? SIGTERM_GRACE_MS;
          const deadline = Date.now() + graceMs;
          while (groupAlive() && Date.now() < deadline) await sleep(10);
          if (groupAlive()) {
            signalGroup("SIGKILL");
            while (groupAlive()) await sleep(10);
          }
        } catch {
          // kill-error propagation is pinned with the pair-3 termination kinds
        }
      })();
    };

    const onChunk =
      (cap: CappedStream, callback: ((chunk: Uint8Array) => void) | undefined) =>
      (chunk: Buffer): void => {
        if (consumerError === null && callback !== undefined) {
          try {
            callback(chunk);
          } catch (err) {
            consumerError = err instanceof Error ? err.message : String(err);
            terminate();
          }
        }
        cap.push(chunk);
      };
    child.stdout.on("data", onChunk(stdoutCap, opts.onStdout));
    child.stderr.on("data", onChunk(stderrCap, opts.onStderr));

    child.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT & friends surface here; 'close' still fires and settles below.
      spawnError = { ...(err.code !== undefined ? { code: err.code } : {}), message: err.message };
    });

    // 'close' (not 'exit'): stdio is drained by the time it fires, so the
    // captured text is complete.
    child.on("close", (code, signal) => {
      const completion: SpawnCompletion =
        spawnError !== null
          ? { kind: "spawn-error", ...spawnError }
          : consumerError !== null
            ? { kind: "consumer-error", message: consumerError }
            : code !== null
              ? { kind: "exited", exitCode: code }
              : { kind: "signaled", signal: signal ?? "SIGTERM" };
      resolvePromise({
        completion,
        stdout: stdoutCap.text(),
        stderr: stderrCap.text(),
        stdoutTruncated: stdoutCap.truncated,
        stderrTruncated: stderrCap.truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
