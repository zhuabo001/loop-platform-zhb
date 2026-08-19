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
 *  - terminate() NEVER rejects: a real TERM/KILL failure is captured —
 *    there is no floating-rejection window between trigger and 'close' —
 *    and surfaced by ONE settle path; signal-0 probe EPERM is conservatively
 *    retried and only becomes fatal if the bounded reap cannot finish: a
 *    mid-termination failure rejects IMMEDIATELY and detaches (failFatally,
 *    round-2 P1: a child we cannot signal must not hang the caller waiting
 *    for a 'close' we may never bring about); a close-time failure rejects
 *    at settle;
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
  /** Replaces `process.kill` for the group probe/signals. TEST-ONLY seam
   *  (round-2 P1, same standing as graceMs): POSIX offers no portable way to
   *  make kill(2) fail with EPERM on demand, so deterministic kill-failure
   *  tests inject it here. Production call sites never set this. */
  killImpl?: typeof process.kill;
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
const TAIL_CAPTURE_BYTES = HALF_CAP + 3;

/** True for UTF-8 continuation bytes (10xxxxxx). */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Bytes a UTF-8 sequence needs, from its lead byte; continuation bytes and
 *  out-of-range leads report 1 (each decodes as its own U+FFFD). */
function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

function isValidUtf8SecondByte(lead: number, second: number): boolean {
  if (!isContinuationByte(second)) return false;
  if (lead === 0xe0) return second >= 0xa0;
  if (lead === 0xed) return second <= 0x9f;
  if (lead === 0xf0) return second >= 0x90;
  if (lead === 0xf4) return second <= 0x8f;
  return true;
}

/** Whether the bytes already present after a valid lead can still become a
 *  valid UTF-8 scalar. Invalid/overlong/surrogate prefixes must be retained
 *  so the decoder reports their honest U+FFFD instead of our cut hiding
 *  them. */
function isCompletableUtf8Prefix(buf: Buffer, lead: number, needed: number): boolean {
  const present = buf.length - lead;
  if (present >= needed) return false;
  if (present === 1) return true;

  const leadByte = buf[lead]!;
  const second = buf[lead + 1]!;
  if (!isValidUtf8SecondByte(leadByte, second)) return false;
  for (let index = lead + 2; index < buf.length; index += 1) {
    if (!isContinuationByte(buf[index]!)) return false;
  }
  return true;
}

/** Head cut on RAW BYTES: if the buffer ends mid-sequence, drop the whole
 *  partial character (back off ≤3 bytes to its lead) so a split char never
 *  decodes to U+FFFD. Genuinely invalid bytes are kept — their U+FFFD is
 *  the honest decode of bad input, not an artifact of our cut. */
function dropTrailingPartialSequence(buf: Buffer): Buffer {
  let lead = buf.length - 1;
  let continuationBytes = 0;
  while (lead >= 0 && continuationBytes < 3 && isContinuationByte(buf[lead]!)) {
    lead -= 1;
    continuationBytes += 1;
  }
  if (lead < 0) return buf.subarray(0, 0);
  const needed = utf8SequenceLength(buf[lead]!);
  return needed > 1 && isCompletableUtf8Prefix(buf, lead, needed) ? buf.subarray(0, lead) : buf;
}

/** Tail cut on RAW BYTES with ≤3 bytes of preceding context. Skip leading
 *  continuation bytes only when that context proves the cut split a complete
 *  valid scalar. An independent invalid continuation byte must remain so the
 *  decoder reports its honest U+FFFD (CS6). */
function alignTailToUtf8Scalar(buf: Buffer, tailStart: number): Buffer {
  if (!isContinuationByte(buf[tailStart]!)) return buf.subarray(tailStart);

  let lead = tailStart - 1;
  while (lead >= 0 && tailStart - lead <= 3 && isContinuationByte(buf[lead]!)) lead -= 1;
  if (lead < 0) return buf.subarray(tailStart);

  const needed = utf8SequenceLength(buf[lead]!);
  const end = lead + needed;
  if (needed === 1 || end <= tailStart || end > buf.length) return buf.subarray(tailStart);
  if (!isValidUtf8SecondByte(buf[lead]!, buf[lead + 1]!)) return buf.subarray(tailStart);
  for (let index = lead + 2; index < end; index += 1) {
    if (!isContinuationByte(buf[index]!)) return buf.subarray(tailStart);
  }
  return buf.subarray(end);
}

/** Rolling head+tail capture that keeps RAW BYTES until the very end
 *  (round-2 P1 rewrite). While the total fits the cap the whole stream is
 *  retained (text() is byte-exact and never marked truncated — CS2); the
 *  first byte past the cap flips `truncated` forever, freezing head at the
 *  first half and rolling tail as the last half, so memory stays bounded no
 *  matter how much the child writes. Decoding happens ONCE in text():
 *  multibyte chars split across pipe chunks reassemble losslessly because
 *  every kept byte is still contiguous, and both cut points are aligned on
 *  the raw bytes — OS chunk boundaries are irrelevant to correctness
 *  (CS1/CS3: no synthesized U+FFFD, re-encoding never exceeds the cap). */
export class CappedStream {
  /** Every byte, while total ≤ cap; null once truncated. */
  private wholeParts: Buffer[] | null = [];
  private wholeBytes = 0;
  /** First HALF_CAP bytes, frozen at truncation. */
  private head: Buffer | null = null;
  /** Rolling last HALF_CAP bytes plus ≤3 bytes of cut context. */
  private tailParts: Buffer[] = [];
  private tailBytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    // Streams and consumers own their input buffers. Capture an immutable
    // byte snapshot so later reuse/mutation cannot rewrite subprocess output.
    const ownedChunk = Buffer.from(chunk);
    if (this.wholeParts !== null) {
      this.wholeParts.push(ownedChunk);
      this.wholeBytes += ownedChunk.length;
      if (this.wholeBytes <= MAX_STREAM_BYTES) return;
      // First byte past the cap: split the over-cap whole into the frozen
      // head and the rolling tail window — disjoint, since the whole is
      // longer than 2 × HALF_CAP at this point.
      const whole = Buffer.concat(this.wholeParts, this.wholeBytes);
      this.wholeParts = null;
      this.truncated = true;
      this.head = whole.subarray(0, HALF_CAP);
      this.tailParts = [whole.subarray(Math.max(0, whole.length - TAIL_CAPTURE_BYTES))];
      this.tailBytes = this.tailParts[0]!.length;
      return;
    }
    this.tailParts.push(ownedChunk);
    this.tailBytes += ownedChunk.length;
    while (this.tailBytes > TAIL_CAPTURE_BYTES) {
      const excess = this.tailBytes - TAIL_CAPTURE_BYTES;
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
    if (!this.truncated) {
      return Buffer.concat(this.wholeParts ?? [], this.wholeBytes).toString("utf8");
    }
    const head = dropTrailingPartialSequence(this.head ?? Buffer.alloc(0));
    const tailWithContext = Buffer.concat(this.tailParts, this.tailBytes);
    const tail = alignTailToUtf8Scalar(tailWithContext, tailWithContext.length - HALF_CAP);
    return head.toString("utf8") + tail.toString("utf8");
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
    let lastProbeError: Error | null = null;
    /** Single-settle guard: exactly one of resolve/reject ever fires — the
     *  normal close settle, or failFatally on an unrecoverable kill error. */
    let settled = false;
    /** Test-only seam (never set by production): see SpawnOptions.killImpl. */
    const kill = opts.killImpl ?? process.kill;

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    /** Group liveness via kill(-pgid, 0): ESRCH ⇒ gone (NOT an error —
     *  S16). EPERM from this null-signal probe is conservative evidence that
     *  the group may still exist, not proof that an actual TERM/KILL failed;
     *  macOS can report it transiently while a signalled child is exiting.
     *  We therefore keep reaping and let the next real signal be definitive.
     *  Persistent probe errors are surfaced after the bounded KILL reap. */
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        kill(-child.pid, 0);
        lastProbeError = null;
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          lastProbeError = null;
          return false;
        }
        if (code === "EPERM") {
          lastProbeError = err instanceof Error ? err : new Error(String(err));
          return true;
        }
        throw err;
      }
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        kill(-child.pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };

    const waitForGroupExit = async (deadline: number): Promise<boolean> => {
      while (Date.now() < deadline) {
        if (!groupAlive()) return true;
        await sleep(10);
      }
      return !groupAlive();
    };

    /** Idempotent TERM → grace → KILL against the WHOLE group. NEVER rejects:
     *  a kill failure is captured into killError and surfaced by failFatally
     *  (immediate reject + detach) — attaching a handler only at 'close'
     *  would leave a floating-rejection window that can crash the daemon
     *  under strict unhandled-rejection settings (round-1 P1), and waiting
     *  for 'close' can hang forever when every kill fails (round-2 P1). */
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      terminationDone = (async () => {
        try {
          signalGroup("SIGTERM");
          const graceMs = opts.graceMs ?? SIGTERM_GRACE_MS;
          const deadline = Date.now() + graceMs;
          if (await waitForGroupExit(deadline)) {
            terminatedBy = "SIGTERM";
            return;
          }
          signalGroup("SIGKILL");
          if (!(await waitForGroupExit(Date.now() + graceMs))) {
            if (lastProbeError !== null) throw lastProbeError;
            throw Object.assign(new Error("process group did not exit after SIGKILL"), {
              code: "ETIMEDOUT",
            });
          }
          terminatedBy = "SIGKILL";
        } catch (err) {
          killError = err instanceof Error ? err : new Error(String(err));
          failFatally(killError);
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

    /** Fatal termination failure (round-2 P1): we can no longer manage the
     *  process group (e.g. EPERM on every kill), so awaiting 'close' could
     *  hang forever — reject NOW and detach: timer and abort listener
     *  dropped, stdio destroyed, child unref'd (the daemon's event loop must
     *  not be held by a process we cannot control). The late 'close' handler
     *  and every other settle path no-op via `settled`. */
    const failFatally = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      rejectPromise(err);
    };

    const onChunk =
      (cap: CappedStream, callback: ((chunk: Uint8Array) => void) | undefined) =>
      (chunk: Buffer): void => {
        // Callbacks stop once ANY winner exists: the stream is doomed and
        // the consumer's output will be discarded (round-1: this also keeps
        // a repeatedly-throwing consumer from firing during grace). They
        // also stop once settled — a fatal reject has detached us and the
        // consumer's result is gone (belt-and-braces: failFatally destroys
        // the streams anyway).
        if (settled) return;
        if (winner === null && callback !== undefined) {
          try {
            // The consumer gets its own view: callbacks run before capture by
            // contract, but mutating that view must not alter the child bytes
            // retained below (synchronously or after this handler returns).
            callback(Buffer.from(chunk));
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
          killError = err instanceof Error ? err : new Error(String(err));
        }
        // A mid-termination kill failure already rejected and detached via
        // failFatally — possibly while we were awaiting terminationDone.
        if (settled) return;
        settled = true;
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
