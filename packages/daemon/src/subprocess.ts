/**
 * Generic subprocess lifecycle (Phase 2 batch 2, plan §2.3): ONE process
 * group per spawn, deterministic termination (SIGTERM → grace → SIGKILL),
 * capped stdio capture with in-order chunk callbacks (the batch-3 stream-json
 * parser rides onStdout/onStderr), and a discriminated-union completion so
 * the runner never has to guess how a child died.
 *
 * Termination contract (ADR-005 决策 6, round-1 hardened):
 *  - triggers: timeout, AbortSignal, or a throwing chunk consumer — the
 *    FIRST one writes the single `winner` field and alone decides the
 *    completion kind; later triggers still terminate but never re-decide;
 *  - terminate() NEVER rejects: a kill failure (e.g. EPERM from the group
 *    liveness probe) is captured and surfaced by the unified settle path —
 *    there is no floating-rejection window between trigger and 'close';
 *  - the routine is idempotent: SIGTERM to the process GROUP, grace, then
 *    SIGKILL; ESRCH means "already gone" and is never an error;
 *  - after the direct child's 'close' the group is checked once more —
 *    orphaned grandchildren get the same TERM → KILL before we return;
 *  - chunk callbacks stop firing once any winner exists (the stream is
 *    doomed; the consumer's result will be discarded anyway).
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
  /** Grace between SIGTERM and SIGKILL to the process group. TEST-ONLY seam
   *  (ADR-005 决策 6/修订): production call sites never set this — the fixed
   *  5000ms policy applies; tests shrink it to keep the suite fast. */
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

/** True for UTF-8 continuation bytes (10xxxxxx). */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Rolling head+tail capture. While the total fits the cap, head and tail
 *  stay CONTIGUOUS (text() is the exact stream); the first byte that must be
 *  dropped flips `truncated` for good. Both cut points align to UTF-8 LEAD
 *  bytes (round-1 P2): the head cut backs off ≤3 bytes (the straddling char
 *  flows into the tail), the tail front advances past continuation bytes —
 *  so text() never synthesizes U+FFFD and re-encoding never exceeds the cap. */
export class CappedStream {
  private headParts: Buffer[] = [];
  private headBytes = 0;
  private tailParts: Buffer[] = [];
  private tailBytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < HALF_CAP) {
      let take = Math.min(HALF_CAP - this.headBytes, rest.length);
      if (take < rest.length) {
        // Cutting mid-chunk: back off to the straddling char's lead byte.
        while (take > 0 && isContinuationByte(rest[take]!)) take -= 1;
      }
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
    if (this.truncated) {
      // The rollover cut can leave the front mid-sequence: advance to the
      // next lead byte (bounded by UTF-8's 4-byte max).
      while (this.tailParts.length > 0) {
        const first = this.tailParts[0]!;
        if (first.length === 0) {
          this.tailParts.shift();
          continue;
        }
        if (!isContinuationByte(first[0]!)) break;
        this.tailParts[0] = first.subarray(1);
        this.tailBytes -= 1;
      }
    }
  }

  text(): string {
    return Buffer.concat([...this.headParts, ...this.tailParts]).toString("utf8");
  }
}

export async function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  const startedAt = Date.now();
  const empty = (completion: SpawnCompletion): SpawnResult => ({
    completion,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Date.now() - startedAt,
  });

  if (process.platform === "win32") {
    return empty({
      kind: "spawn-error",
      code: "UNSUPPORTED_PLATFORM",
      message: "native Windows is not supported (process-group semantics are POSIX) — use WSL2",
    });
  }

  // S4: abort-before-spawn never creates a process. The finalSignal is
  // NOMINAL — nothing was signalled because nothing exists.
  if (opts.signal.aborted) {
    return empty({ kind: "aborted", finalSignal: "SIGTERM" });
  }

  return await new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
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
    /** THE trigger state: the FIRST of timeout / abort / consumer-throw wins
     *  and alone decides the completion kind. Later triggers still join the
     *  (idempotent) termination but never re-decide the outcome. */
    let winner: "timed-out" | "aborted" | "consumer-error" | null = null;
    let consumerErrorMessage: string | null = null;
    let terminationStarted = false;
    let terminationDone: Promise<void> | null = null;
    let terminatedBy: NodeJS.Signals | null = null;
    let killError: Error | null = null;

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    /** Group liveness via kill(-pgid, 0): ESRCH ⇒ gone (NOT an error —
     *  S16); any other kill failure propagates via the settle path. */
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

    /** Idempotent TERM → grace → KILL against the WHOLE group. NEVER rejects:
     *  a kill failure is captured into killError and surfaced by settle —
     *  attaching a handler only at 'close' would leave a floating-rejection
     *  window that can crash the daemon under strict unhandled-rejection
     *  settings (round-1 P1). */
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      terminationDone = (async () => {
        try {
          signalGroup("SIGTERM");
          const graceMs = opts.graceMs ?? SIGTERM_GRACE_MS;
          const deadline = Date.now() + graceMs;
          while (groupAlive() && Date.now() < deadline) await sleep(10);
          if (!groupAlive()) {
            terminatedBy = "SIGTERM";
            return;
          }
          signalGroup("SIGKILL");
          while (groupAlive()) await sleep(10);
          terminatedBy = "SIGKILL";
        } catch (err) {
          killError = err instanceof Error ? err : new Error(String(err));
        }
      })();
    };

    const onTimeout = (): void => {
      if (winner !== null) return;
      winner = "timed-out";
      terminate();
    };
    const onAbort = (): void => {
      if (winner !== null) return;
      winner = "aborted";
      terminate();
    };
    const timer = setTimeout(onTimeout, opts.timeoutMs);
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const onChunk =
      (cap: CappedStream, callback: ((chunk: Uint8Array) => void) | undefined) =>
      (chunk: Buffer): void => {
        // Callbacks stop once ANY winner exists: the stream is doomed and
        // the consumer's output will be discarded (round-1: this also keeps
        // a repeatedly-throwing consumer from firing during grace).
        if (winner === null && callback !== undefined) {
          try {
            callback(chunk);
          } catch (err) {
            winner = "consumer-error";
            consumerErrorMessage = err instanceof Error ? err.message : String(err);
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

    // 'close' (not 'exit'): stdio is drained by the time it fires. settle()
    // runs synchronously up to the reap, so the winner is FROZEN by
    // clearTimeout/removeEventListener before any await — a timer landing
    // mid-reap can never flip an already-exited child to timed-out.
    child.on("close", (code, signal) => {
      const settle = async (): Promise<void> => {
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        try {
          // S9: the direct child is done, but its group may hold orphaned
          // grandchildren — they get the same TERM → grace → KILL.
          if (groupAlive()) terminate();
          if (terminationDone !== null) await terminationDone;
        } catch (err) {
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (killError !== null) {
          rejectPromise(killError);
          return;
        }
        const completion: SpawnCompletion =
          spawnError !== null
            ? { kind: "spawn-error", ...spawnError }
            : winner === "consumer-error"
              ? { kind: "consumer-error", message: consumerErrorMessage ?? "chunk consumer failed" }
              : winner === "timed-out"
                ? { kind: "timed-out", finalSignal: terminatedBy ?? signal ?? "SIGTERM" }
                : winner === "aborted"
                  ? { kind: "aborted", finalSignal: terminatedBy ?? signal ?? "SIGTERM" }
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
      };
      void settle();
    });
  });
}
