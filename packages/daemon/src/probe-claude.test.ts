/**
 * Startup probe pins (Phase 2 batch 3, plan §2.2 — group PR): before the
 * daemon creates its HTTP client, it probes the configured claude binary with
 * `shell: false` — `claude --version` (parseable, ≥ 2.1.219) and
 * `claude --help` (every flag this batch depends on). ANY failure —
 * spawn error, non-zero exit, timeout, unparseable output, outdated version,
 * missing flags, unsupported platform — aborts the startup.
 *
 * The happy path uses the committed fake-claude fixture; failure variants use
 * inline scripted binaries with an absolute-path node shebang (no PATH
 * dependence). The 10s probe timeout is fixed in production; tests shrink it
 * through the documented test-only seam.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAUDE_PROBE_TIMEOUT_MS,
  ClaudeProbeError,
  MIN_CLAUDE_VERSION,
  REQUIRED_CLAUDE_FLAGS,
  probeClaudeBinary,
} from "./probe-claude.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/fake-claude.mjs", import.meta.url));

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-probe-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** An inline fake binary with an absolute node shebang — env-independent. */
function makeFakeBin(name: string, body: string): string {
  const bin = path.join(base, name);
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

const ENV = { PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` };

describe("probeClaudeBinary", () => {
  it("PR1: a healthy binary resolves with its parsed version", async () => {
    const result = await probeClaudeBinary(FIXTURE, ENV);
    expect(result.version).toBe("2.1.227");
  });

  it("PR2: an outdated version rejects, quoting both versions", async () => {
    const bin = makeFakeBin("old-claude", `process.stdout.write("2.0.5 (Claude Code)\\n");`);
    await expect(probeClaudeBinary(bin, {})).rejects.toThrow(/2\.0\.5.*2\.1\.219/s);
  });

  it("PR3: unparseable --version output rejects", async () => {
    const bin = makeFakeBin("garbage-claude", `process.stdout.write("not a version\\n");`);
    await expect(probeClaudeBinary(bin, {})).rejects.toThrow(ClaudeProbeError);
  });

  it("PR4: a missing binary rejects (spawn error surfaces as a probe failure)", async () => {
    await expect(probeClaudeBinary(path.join(base, "nonexistent-claude"), {})).rejects.toThrow(ClaudeProbeError);
  });

  it("PR5: --help missing a required flag rejects and names the missing flags", async () => {
    const bin = makeFakeBin(
      "flagless-claude",
      `if (process.argv.includes("--version")) { process.stdout.write("9.9.9\\n"); process.exit(0); }
       process.stdout.write("usage: fake\\n  --output-format\\n");`,
    );
    const err = await probeClaudeBinary(bin, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaudeProbeError);
    expect((err as Error).message).toContain("--safe-mode");
    expect((err as Error).message).toContain("--permission-mode");
    expect((err as Error).message).not.toContain("--output-format,"); // present flags are not listed
  });

  it("PR6: a non-zero --version exit rejects", async () => {
    const bin = makeFakeBin("dying-claude", `process.exitCode = 1;`);
    await expect(probeClaudeBinary(bin, {})).rejects.toThrow(ClaudeProbeError);
  });

  it("PR7: a hung probe rejects at the timeout (test seam shrinks the fixed 10s)", async () => {
    const bin = makeFakeBin(
      "hanging-claude",
      `if (process.argv.includes("--version")) { process.stdout.write("2.1.227\\n"); process.exit(0); }
       setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    await expect(probeClaudeBinary(bin, {}, 300)).rejects.toThrow(ClaudeProbeError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("PR8: the production constants are the pinned contract (10s, 2.1.219, the batch's flag set)", () => {
    expect(CLAUDE_PROBE_TIMEOUT_MS).toBe(10_000);
    expect(MIN_CLAUDE_VERSION).toBe("2.1.219");
    expect(REQUIRED_CLAUDE_FLAGS).toEqual([
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
    ]);
  });
});
