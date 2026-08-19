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

import { spawnWithTimeout, type SpawnOptions } from "./subprocess.js";

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
});
