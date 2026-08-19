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
