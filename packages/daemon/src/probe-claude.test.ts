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
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAUDE_BINARY_HASH_TIMEOUT_MS,
  CLAUDE_PROBE_TIMEOUT_MS,
  ClaudeProbeError,
  MIN_CLAUDE_VERSION,
  REQUIRED_CLAUDE_FLAGS,
  probeClaudeBinary,
  statClaudeBinary,
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

  it("PR9: flag detection is token-exact — lookalike names never satisfy the probe (review round-1 P2)", async () => {
    // Every required flag appears ONLY as a lookalike (--flag-removed).
    // Substring matching would wave this through; token matching must not.
    const lookalikes = REQUIRED_CLAUDE_FLAGS.map((flag) => `  ${flag}-removed`).join("\n");
    const bin = makeFakeBin(
      "lookalike-claude",
      `if (process.argv.includes("--version")) { process.stdout.write("2.1.227\\n"); process.exit(0); }
       process.stdout.write(${JSON.stringify(`usage: fake\n${lookalikes}\n`)});`,
    );
    const err = await probeClaudeBinary(bin, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaudeProbeError);
    expect((err as Error).message).toContain("--safe-mode");
    expect((err as Error).message).toContain("--settings");
  });

  it("PR10: real help typography still matches — `--flag=value`, comma-separated aliases, backticks", async () => {
    const help = [
      "usage: fake [options]",
      "  --output-format <format>",
      "  --verbose, -v",
      "  --safe-mode=true",
      "  --setting-sources <sources>",
      "  --disable-slash-commands",
      "  --no-chrome",
      "  --no-session-persistence",
      "  --tools <tools...>",
      "  --permission-mode <mode>",
      "  --prompt-suggestions [value]",
      "  `--settings` <file-or-json>",
      "  --model <model>",
      "  --append-system-prompt <prompt>",
      "",
    ].join("\n");
    const bin = makeFakeBin(
      "typographic-claude",
      `if (process.argv.includes("--version")) { process.stdout.write("2.1.227\\n"); process.exit(0); }
       process.stdout.write(${JSON.stringify(help)});`,
    );
    const result = await probeClaudeBinary(bin, ENV);
    expect(result.version).toBe("2.1.227");
  });

  it("PR11: the probe pins the resolved executable identity", async () => {
    const result = await probeClaudeBinary(FIXTURE, ENV);
    const st = statSync(FIXTURE);
    expect(result.binary.resolvedPath).toBe(realpathSync(FIXTURE));
    expect(result.binary.sha256).toBe(createHash("sha256").update(readFileSync(FIXTURE)).digest("hex"));
    expect(result.binary).toMatchObject({ dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
  });

  it("PR12: a bare binary name resolves through the AGENT env PATH (the same env the probes ran under)", async () => {
    const dir = path.join(base, "bin");
    mkdirSync(dir);
    const bin = path.join(dir, "path-claude");
    copyFileSync(FIXTURE, bin);
    chmodSync(bin, 0o755);
    const result = await probeClaudeBinary("path-claude", { PATH: `${dir}:${path.dirname(process.execPath)}` });
    expect(result.version).toBe("2.1.227");
    expect(result.binary.resolvedPath).toBe(realpathSync(bin));
  });

  it("PR12b: an explicit path containing spaces and shell metacharacters is executed literally", async () => {
    const completeHelp = `${REQUIRED_CLAUDE_FLAGS.join("\n")}\n`;
    const bin = makeFakeBin(
      "claude path; printf INJECTION_MUST_NOT_RUN",
      `process.stdout.write(process.argv.includes("--version") ? "2.1.227\\n" : ${JSON.stringify(completeHelp)});`,
    );

    const result = await probeClaudeBinary(bin, ENV);

    expect(result.version).toBe("2.1.227");
    expect(result.binary.resolvedPath).toBe(realpathSync(bin));
  });

  it("PR13: a bare name unresolvable on the agent PATH rejects", async () => {
    await expect(probeClaudeBinary("no-such-claude-anywhere", { PATH: base })).rejects.toThrow(ClaudeProbeError);
  });

  it("PR14: the identity carries a content hash, and a binary that changes DURING the probe is rejected (review round-2 P1)", async () => {
    // The hash pins the CONTENT: same-inode, same-size, restored-mtime
    // overwrites still differ.
    const result = await probeClaudeBinary(FIXTURE, ENV);
    const expected = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
    expect(result.binary.sha256).toBe(expected);

    // A binary that rewrites itself while --help is being probed must NOT be
    // pinned: the post-probe identity must match the pre-probe one.
    const body = [
      'const fs = require("node:fs");',
      'if (process.argv.includes("--version")) { process.stdout.write("2.1.227\\n"); process.exit(0); }',
      "if (process.argv.includes(\"--help\")) {",
      '  fs.appendFileSync(process.argv[1], "\\n// tampered mid-probe\\n");',
      '  process.stdout.write("--output-format\\n--verbose\\n--safe-mode\\n--setting-sources\\n--disable-slash-commands\\n--no-chrome\\n--no-session-persistence\\n--tools\\n--permission-mode\\n--prompt-suggestions\\n--settings\\n--model\\n--append-system-prompt\\n");',
      "  process.exit(0);",
      "}",
      "process.exitCode = 64;",
    ].join("\n");
    const bin = makeFakeBin("self-swapping-claude", body);
    const err = await probeClaudeBinary(bin, ENV).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaudeProbeError);
    expect((err as Error).message).toContain("changed");
  });

  it("PR15: identity is checked after each probe, so a version→help path swap is rejected", async () => {
    const target = path.join(base, "switching-claude");
    const backup = path.join(base, "original-claude");
    const substitute = path.join(base, "substitute-claude");
    const stampSeconds = 1_700_000_000;
    const completeHelp = `${REQUIRED_CLAUDE_FLAGS.join("\n")}\n`;

    // A proves only --version, then puts B at the configured path. B proves
    // --help and restores A (including mtime) before exiting. A path-based
    // before/after check sees A both times and incorrectly accepts the pair.
    writeFileSync(
      target,
      `#!${process.execPath}\n` +
        `const fs=require("node:fs");\n` +
        `if(process.argv.includes("--version")){fs.copyFileSync(${JSON.stringify(substitute)},${JSON.stringify(target)});fs.chmodSync(${JSON.stringify(target)},0o755);fs.utimesSync(${JSON.stringify(target)},${stampSeconds},${stampSeconds});process.stdout.write("2.1.227\\n");process.exit(0);}\n` +
        `process.stdout.write("--output-format\\n");\n`,
      { mode: 0o755 },
    );
    copyFileSync(target, backup);
    writeFileSync(
      substitute,
      `#!${process.execPath}\n` +
        `const fs=require("node:fs");\n` +
        `if(process.argv.includes("--help")){fs.copyFileSync(${JSON.stringify(backup)},${JSON.stringify(target)});fs.chmodSync(${JSON.stringify(target)},0o755);fs.utimesSync(${JSON.stringify(target)},${stampSeconds},${stampSeconds});process.stdout.write(${JSON.stringify(completeHelp)});process.exit(0);}\n` +
        `process.exitCode=64;\n`,
      { mode: 0o755 },
    );
    utimesSync(target, stampSeconds, stampSeconds);

    await expect(probeClaudeBinary(target, ENV)).rejects.toThrow(/changed during `--version`/);
  });

  it("PR16: probe children never receive provider, OAuth, or proxy credentials", async () => {
    const observed = path.join(base, "probe-env.json");
    const help = `${REQUIRED_CLAUDE_FLAGS.join("\n")}\n`;
    const bin = makeFakeBin(
      "env-claude",
      `const fs=require("node:fs");
       fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env));
       process.stdout.write(process.argv.includes("--version") ? "2.1.227\\n" : ${JSON.stringify(help)});`,
    );
    await probeClaudeBinary(bin, {
      PATH: ENV.PATH,
      HOME: "/home/test",
      CLAUDE_CONFIG_DIR: "/home/test/.claude",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      HTTPS_PROXY: "https://user:pass@proxy.example",
    });
    const childEnv = JSON.parse(readFileSync(observed, "utf8")) as Record<string, string>;
    expect(childEnv).toMatchObject({ PATH: ENV.PATH, HOME: "/home/test", CLAUDE_CONFIG_DIR: "/home/test/.claude" });
    expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(childEnv).not.toHaveProperty("HTTPS_PROXY");
  });

  it("PR17: identity hashing has an independent deadline", async () => {
    const large = path.join(base, "large-claude");
    writeFileSync(large, "", { mode: 0o755 });
    truncateSync(large, 256 * 1024 * 1024);
    await expect(statClaudeBinary(large, { timeoutMs: 1 })).rejects.toThrow();
  });

  it("PR18: identity hashing observes an already-aborted Run signal", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(statClaudeBinary(FIXTURE, { signal: ctl.signal })).rejects.toThrow();
  });

  it("PR8: the production constants are the pinned contract (10s deadlines, 2.1.219, flags)", () => {
    expect(CLAUDE_PROBE_TIMEOUT_MS).toBe(10_000);
    expect(CLAUDE_BINARY_HASH_TIMEOUT_MS).toBe(10_000);
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
