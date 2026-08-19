/**
 * Subprocess pins (plan S1–S17). Every spawn targets the Node fixture
 * executable (test-fixtures/spawn-fixture.mjs) with an EMPTY env — nothing
 * leaks from the test process into children. Timeouts stay small but real
 * (no fake timers: the lifecycle under test is a real process group).
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CappedStream, MAX_STREAM_BYTES, spawnWithTimeout, type SpawnOptions } from "./subprocess.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/spawn-fixture.mjs", import.meta.url));
const NODE = process.execPath;
const CWD = realpathSync(tmpdir());

function opts(partial: Partial<SpawnOptions> & { args: string[] }): SpawnOptions {
  return {
    command: NODE,
    cwd: CWD,
    env: {},
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    graceMs: 100,
    ...partial,
  };
}

describe("spawnWithTimeout — lifecycle basics", () => {
  it("S1: exit 0 → exited(0) with both streams captured", async () => {
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "exit", "0"] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    expect(result.stdout).toBe("stdout-from-exit-0\n");
    expect(result.stderr).toBe("stderr-from-exit-0\n");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("S2: non-zero exit → exited(n)", async () => {
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "exit", "3"] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 3 });
  });

  it("S3: command not found → spawn-error(ENOENT), no hang", async () => {
    const result = await spawnWithTimeout(opts({ command: "/nonexistent/loopzhb-binary", args: [] }));
    expect(result.completion.kind).toBe("spawn-error");
    expect((result.completion as { code?: string }).code).toBe("ENOENT");
  });
});

describe("spawnWithTimeout — stdio capture, caps and chunk callbacks", () => {
  const MIB = 1024 * 1024;
  const HALF = MIB / 2;
  const digitPattern = (n: number): string => "0123456789".repeat(Math.ceil(n / 10)).slice(0, n);

  it("S10: multi-chunk stdout/stderr are captured completely and in order", async () => {
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "drip", "10", "5"] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    expect(result.stdout).toBe(Array.from({ length: 10 }, (_, i) => `line-${i}\n`).join(""));
    expect(result.stdoutTruncated).toBe(false);
  });

  it("S11: stdout beyond 1 MiB keeps head+tail halves, marks truncated, and still drains to completion", async () => {
    const total = 2 * MIB;
    const expected = digitPattern(total);
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "big", "stdout", String(total)] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 }); // drain never stalls the writer
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stdout.length).toBe(MIB);
    expect(result.stdout.startsWith(expected.slice(0, HALF))).toBe(true);
    expect(result.stdout.endsWith(expected.slice(total - HALF))).toBe(true);
  });

  it("S12: stderr beyond 1 MiB is capped the same way", async () => {
    const total = 2 * MIB;
    const expected = digitPattern(total);
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "big", "stderr", String(total)] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBe(MIB);
    expect(result.stderr.startsWith(expected.slice(0, HALF))).toBe(true);
    expect(result.stderr.endsWith(expected.slice(total - HALF))).toBe(true);
  });

  it("S13: onStdout chunks arrive in original order and cover the whole stream", async () => {
    const chunks: Buffer[] = [];
    const result = await spawnWithTimeout(
      opts({ args: [FIXTURE, "drip", "10", "5"], onStdout: (c) => chunks.push(Buffer.from(c)) }),
    );
    const streamed = Buffer.concat(chunks).toString("utf8");
    expect(streamed).toBe(Array.from({ length: 10 }, (_, i) => `line-${i}\n`).join(""));
    expect(streamed).toBe(result.stdout);
  });

  it("S14: a throwing chunk callback → consumer-error and the process group is terminated", async () => {
    // The fixture would drip for ~5s left alone; a terminated group returns fast.
    const result = await spawnWithTimeout(
      opts({
        args: [FIXTURE, "drip", "100", "50"],
        onStdout: () => {
          throw new Error("consumer boom");
        },
      }),
    );
    expect(result.completion.kind).toBe("consumer-error");
    expect((result.completion as { message: string }).message).toContain("consumer boom");
    expect(result.durationMs).toBeLessThan(3000);
  });

  it("S20: a consumer cannot mutate the bytes retained for the final stdout snapshot", async () => {
    const result = await spawnWithTimeout(
      opts({
        args: [FIXTURE, "exit", "0"],
        onStdout: (chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).fill(0x58),
      }),
    );
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    expect(result.stdout).toBe("stdout-from-exit-0\n");
  });
});

describe("spawnWithTimeout — termination triggers", () => {
  it("S4: an already-aborted signal returns aborted WITHOUT spawning", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "exit", "0"], signal: ctl.signal }));
    expect(result.completion.kind).toBe("aborted");
    expect(result.durationMs).toBeLessThan(500);
  });

  it("S5: timeout SIGTERMs the group; a cooperative child dies by SIGTERM", async () => {
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "sleep", "3000"], timeoutMs: 150 }));
    expect(result.completion).toEqual({ kind: "timed-out", finalSignal: "SIGTERM" });
    expect(result.durationMs).toBeLessThan(2500);
  });

  it("S6: a SIGTERM-ignoring child is SIGKILLed after the grace window", async () => {
    const result = await spawnWithTimeout(
      opts({ args: [FIXTURE, "ignore-term", "30000"], timeoutMs: 150, graceMs: 100 }),
    );
    expect(result.completion).toEqual({ kind: "timed-out", finalSignal: "SIGKILL" });
    expect(result.durationMs).toBeLessThan(2500);
  });

  it("S7: aborting mid-execution returns aborted and reaps the group", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "sleep", "3000"], signal: ctl.signal }));
    expect(result.completion).toEqual({ kind: "aborted", finalSignal: "SIGTERM" });
    expect(result.durationMs).toBeLessThan(2500);
  });

  it("S8: a near-simultaneous timeout/abort race still settles promptly (arrival tolerance only — first-wins evidence is S5/S7/F1/F2)", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 80);
    const result = await spawnWithTimeout(
      opts({ args: [FIXTURE, "sleep", "3000"], timeoutMs: 80, signal: ctl.signal }),
    );
    expect(["timed-out", "aborted"]).toContain(result.completion.kind);
    expect(result.durationMs).toBeLessThan(2500);
  });

  it("S9: a surviving grandchild in the group is reaped after the child exits", async () => {
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "grandchild"] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    const grandchildPid = Number(result.stdout.trim());
    expect(grandchildPid).toBeGreaterThan(0);
    try {
      // The module must not return while the group lives; double-check the
      // orphan is really gone (poll briefly for the reaper to collect it).
      let alive = true;
      for (let i = 0; i < 100 && alive; i += 1) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      try {
        process.kill(grandchildPid, "SIGKILL"); // hygiene if the pin fails
      } catch {
        /* already dead */
      }
    }
  });
});

describe("spawnWithTimeout — completion kinds and return guarantees", () => {
  it("S15: a self-signalled child reports signaled with the killing signal", async () => {
    // SIGUSR2, not SIGUSR1: Node reserves USR1 for the debugger and swallows it.
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "self-signal", "SIGUSR2"] }));
    expect(result.completion).toEqual({ kind: "signaled", signal: "SIGUSR2" });
  });

  it("S16: an already-gone process group (ESRCH) is treated as ended, never as an error", async () => {
    // Any fast clean exit exercises the settle-time group liveness check:
    // kill(-pgid, 0) → ESRCH → done. A misread here would reject or hang.
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "exit", "0"] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
  });

  it("S17: return implies close fired, stdio fully drained, and the group is gone", async () => {
    // 200 KiB (under the cap): if 'close' settled before the streams drained,
    // the tail would be missing; if the group lingered, return would stall.
    const total = 200 * 1024;
    const expected = "0123456789".repeat(Math.ceil(total / 10)).slice(0, total);
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "big", "stdout", String(total)] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    expect(result.stdout).toBe(expected);
    expect(result.stdoutTruncated).toBe(false);
  });
});

describe("spawnWithTimeout — first-trigger-wins (round-1 fixes)", () => {
  it("F1: timeout wins, and a would-be late consumer throw is never even delivered", async () => {
    // drip-ignore-term survives the timeout's SIGTERM and keeps producing
    // chunks through the grace window. Chunks land at ~0/200/400ms; the
    // timeout fires at 300ms. Round-1's repro (a consumer throw during grace
    // flipping the kind) is shut TWICE: the winner field is single-write,
    // AND callbacks stop once a winner exists — the 3rd chunk is never
    // delivered to the consumer at all.
    let chunks = 0;
    const result = await spawnWithTimeout(
      opts({
        args: [FIXTURE, "drip-ignore-term", "30", "200"],
        timeoutMs: 300,
        graceMs: 500,
        onStdout: () => {
          chunks += 1;
          if (chunks >= 3) throw new Error("late consumer boom");
        },
      }),
    );
    expect(chunks).toBe(2); // chunks at 0/200ms delivered; 400ms+ suppressed
    expect(result.completion.kind).toBe("timed-out");
  });

  it("F2: an EARLY consumer throw wins over a much later timeout/abort", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 5000); // far in the future — must never decide
    const result = await spawnWithTimeout(
      opts({
        args: [FIXTURE, "drip", "30", "50"],
        timeoutMs: 5000,
        signal: ctl.signal,
        onStdout: () => {
          throw new Error("early consumer boom");
        },
      }),
    );
    expect(result.completion.kind).toBe("consumer-error");
    expect((result.completion as { message: string }).message).toContain("early consumer boom");
    expect(result.durationMs).toBeLessThan(2500);
  });
});

describe("spawnWithTimeout — UTF-8 safe truncation (round-1 fix)", () => {
  it("S18: multibyte output truncates on char boundaries — no U+FFFD, re-encode stays within the cap", async () => {
    const chars = 400_000; // 1.2 MB of 3-byte CJK
    const result = await spawnWithTimeout(opts({ args: [FIXTURE, "big-utf8", String(chars)] }));
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("�");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(result.stdout.startsWith("界界界")).toBe(true);
    expect(result.stdout.endsWith("界界界")).toBe(true);
  });
});

describe("CappedStream — byte-level determinism (round-2)", () => {
  const MIB = MAX_STREAM_BYTES;

  /** Feed `payload` in slices whose boundaries split multibyte chars — pipe
   *  reads deliver arbitrary byte chunks (65536 % 3 ≠ 0 for CJK), and
   *  correctness must not depend on where they fall (round-2 P1: S18 flaked
   *  4/5 because the old cut logic only realigned WITHIN one chunk). */
  const pushSliced = (stream: CappedStream, payload: Buffer, slice: number): void => {
    for (let off = 0; off < payload.length; off += slice) {
      stream.push(payload.subarray(off, Math.min(off + slice, payload.length)));
    }
  };

  it("CS1: a char straddling the head cut is dropped whole — no U+FFFD, re-encode stays within the cap", () => {
    const stream = new CappedStream();
    const payload = Buffer.from("界".repeat(400_000), "utf8"); // 1.2 MB of 3-byte CJK
    pushSliced(stream, payload, 4096);
    expect(stream.truncated).toBe(true);
    const text = stream.text();
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MIB);
    expect(text.startsWith("界界界")).toBe(true);
    expect(text.endsWith("界界界")).toBe(true);
  });

  it("CS2: exactly 1 MiB is NOT marked truncated and loses no byte", () => {
    const stream = new CappedStream();
    const payload = Buffer.from("0123456789".repeat(MIB / 10), "utf8"); // exactly the cap
    pushSliced(stream, payload, 4096);
    expect(stream.truncated).toBe(false);
    expect(stream.text()).toBe(payload.toString("utf8"));
  });

  it("CS3: a long multibyte flood rolls the tail window on char boundaries", () => {
    const stream = new CappedStream();
    const payload = Buffer.from("界".repeat(MIB), "utf8"); // 3 MiB
    pushSliced(stream, payload, 4096);
    expect(stream.truncated).toBe(true);
    const text = stream.text();
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MIB);
    expect(text.startsWith("界界界")).toBe(true);
    expect(text.endsWith("界界界")).toBe(true);
  });

  it("CS4: push snapshots caller-owned buffers before they can be mutated", () => {
    const stream = new CappedStream();
    const chunk = Buffer.from("original", "utf8");
    stream.push(chunk);
    chunk.fill(0x58);
    expect(stream.text()).toBe("original");
  });

  it.each([
    { name: "C0", byte: 0xc0 },
    { name: "F5", byte: 0xf5 },
  ])(
    "CS5: invalid UTF-8 lead 0x$name at the head boundary is preserved as U+FFFD",
    ({ byte }) => {
      const stream = new CappedStream();
      const payload = Buffer.alloc(MIB + 1, 0x61);
      payload[MIB / 2 - 1] = byte;
      pushSliced(stream, payload, 4096);
      expect(stream.truncated).toBe(true);
      expect(stream.text()).toContain("�");
    },
  );

  it("CS6: an independent invalid continuation byte at the tail boundary is preserved as U+FFFD", () => {
    const stream = new CappedStream();
    const payload = Buffer.alloc(MIB + 1, 0x61);
    const tailStart = payload.length - MIB / 2;
    payload[tailStart] = 0x80;
    pushSliced(stream, payload, 4096);
    expect(stream.truncated).toBe(true);
    expect(stream.text()).toContain("�");
  });
});

describe("spawnWithTimeout — first-wins determinism gap (round-2)", () => {
  it("F3: a timeout clearly EARLIER than a later abort keeps kind timed-out (S8's missing deterministic half)", async () => {
    // S8 only proves near-simultaneous arrival tolerance; this half pins the
    // ordering: timeout at 80ms decides, the 400ms abort lands on a settled
    // winner and must not flip the kind. (Pin: the single-write winner
    // already behaves this way — the gap was evidence, not behavior.)
    const ctl = new AbortController();
    const abortTimer = setTimeout(() => ctl.abort(), 400);
    try {
      const result = await spawnWithTimeout(
        opts({ args: [FIXTURE, "sleep", "3000"], timeoutMs: 80, signal: ctl.signal }),
      );
      expect(result.completion).toEqual({ kind: "timed-out", finalSignal: "SIGTERM" });
      expect(result.durationMs).toBeLessThan(2500);
    } finally {
      clearTimeout(abortTimer);
    }
  });
});

describe("spawnWithTimeout — kill failure propagation (round-2 P1)", () => {
  it("S19: a non-ESRCH kill failure rejects PROMPTLY instead of hanging until the child exits", async () => {
    // Round-2 reproduction: EPERM injected at the group probe/signal used to
    // be captured yet only surfaced at 'close' — this sleeper outlives the
    // failure by ~30s, so a close-waiter hangs. The module must reject at
    // once and detach; we then kill the orphan ourselves for hygiene.
    let attackedGroup = 0;
    const killImpl: typeof process.kill = (pid, signal) => {
      if (pid < 0) {
        attackedGroup = -pid;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return process.kill(pid, signal);
    };
    try {
      const startedAt = Date.now();
      await expect(
        spawnWithTimeout(opts({ args: [FIXTURE, "sleep", "30000"], timeoutMs: 150, killImpl })),
      ).rejects.toThrow(/EPERM/);
      // The child would hold a close-waiter ~30s; anything near that is the
      // old hang. 5s gives absurd headroom for CI scheduling.
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      if (attackedGroup > 0) {
        try {
          process.kill(-attackedGroup, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });

  it("S21: a transient EPERM from signal-0 probing does not override successful group signals", async () => {
    let groupPid = 0;
    let injectedProbeFailure = false;
    const killImpl: typeof process.kill = (pid, signal) => {
      if (pid < 0) groupPid = -pid;
      if (pid < 0 && signal === 0 && !injectedProbeFailure) {
        injectedProbeFailure = true;
        throw Object.assign(new Error("transient probe EPERM"), { code: "EPERM" });
      }
      return process.kill(pid, signal);
    };
    try {
      const result = await spawnWithTimeout(
        opts({ args: [FIXTURE, "sleep", "3000"], timeoutMs: 150, killImpl }),
      );
      expect(injectedProbeFailure).toBe(true);
      expect(result.completion).toEqual({ kind: "timed-out", finalSignal: "SIGTERM" });
    } finally {
      if (groupPid > 0) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });
});
