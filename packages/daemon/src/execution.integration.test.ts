/**
 * Execution-primitives integration pins (plan I1–I4): jail → env →
 * subprocess composed the way batch 3's Claude runner will compose them —
 * directly against the Node fixture executable, never through a Delivery or
 * the production runtime. Single pin commit: the modules under composition
 * are already green, so no red phase exists for these.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentEnv, redactSecrets } from "./agent-env.js";
import { createWorkdirJail, type WorkdirJail } from "./jail.js";
import { spawnWithTimeout } from "./subprocess.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/spawn-fixture.mjs", import.meta.url));
const NODE = process.execPath;

let base: string;
let root: string;
let jail: WorkdirJail;

beforeEach(async () => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-exec-int-"));
  root = path.join(base, "root");
  mkdirSync(root);
  jail = await createWorkdirJail({ allowedRoots: [root], scratchBase: path.join(base, "scratch") });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("jail → env → subprocess composition", () => {
  it("I1: resolve a scratch cwd, spawn the fixture in it, release cleanly", async () => {
    const resolved = await jail.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-1" });
    expect(resolved.scratchDir).not.toBeNull();
    const { env } = buildAgentEnv({ PATH: "/usr/bin", HOME: base });
    const result = await spawnWithTimeout({
      command: NODE,
      args: [FIXTURE, "exit", "0"],
      cwd: resolved.cwd,
      env,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      graceMs: 100,
    });
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    await jail.release(resolved);
    expect(existsSync(resolved.scratchDir!)).toBe(false);
  });

  it("I2: the child's environment contains EXACTLY the whitelist", async () => {
    const { env } = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: base,
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: base,
      HTTP_PROXY: "http://proxy:8080",
      https_proxy: "https://proxy:8443",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      ANTHROPIC_API_KEY: "sk-ant-int",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-int",
      CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
      LOOPZHB_MACHINE_CREDENTIAL: "dk_should_not_leak",
      GITHUB_TOKEN: "ghp_should_not_leak",
      OPENAI_API_KEY: "sk-should-not-leak",
    });
    const result = await spawnWithTimeout({
      command: NODE,
      args: [FIXTURE, "printenv"],
      cwd: root,
      env,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      graceMs: 100,
    });
    expect(result.completion).toEqual({ kind: "exited", exitCode: 0 });
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    const forwarded = {
      ANTHROPIC_API_KEY: "sk-ant-int",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-int",
      CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
      HOME: base,
      HTTP_PROXY: "http://proxy:8080",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      TMPDIR: base,
      https_proxy: "https://proxy:8443",
    };
    for (const [key, value] of Object.entries(forwarded)) expect(childEnv[key]).toBe(value);
    // macOS injects __CF_USER_TEXT_ENCODING into every process at the OS
    // level (below Node's env option) — an OS-injected allowance, NOT a leak.
    const OS_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);
    const unexpected = Object.keys(childEnv).filter((key) => !(key in forwarded) && !OS_INJECTED.has(key));
    expect(unexpected).toEqual([]);
    expect(childEnv.LOOPZHB_MACHINE_CREDENTIAL).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
    expect(Object.values(childEnv)).not.toContain("dk_should_not_leak");
  });

  it("I3: forwarded secrets reach the child by design and redact out of report-bound text", async () => {
    const source = { ANTHROPIC_API_KEY: "sk-ant-int-secret", HTTPS_PROXY: "https://u:proxy-secret@proxy:8443" };
    const { env, secretValues } = buildAgentEnv(source);
    const result = await spawnWithTimeout({
      command: NODE,
      args: [FIXTURE, "printenv"],
      cwd: root,
      env,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      graceMs: 100,
    });
    // The child legitimately receives the secrets (they are whitelisted)…
    expect(result.stdout).toContain("sk-ant-int-secret");
    // …but any text headed for a report or log is scrubbed first.
    const scrubbed = redactSecrets(result.stdout, secretValues);
    expect(scrubbed).not.toContain("sk-ant-int-secret");
    expect(scrubbed).not.toContain("proxy-secret");
    expect(Buffer.byteLength(scrubbed, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(result.stdout, "utf8"));
  });

  it("I4: a throwing consumer mid-stream reaps the group; scratch release still succeeds", async () => {
    const resolved = await jail.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-2" });
    const { env } = buildAgentEnv({ PATH: "/usr/bin" });
    const result = await spawnWithTimeout({
      command: NODE,
      args: [FIXTURE, "drip", "100", "50"],
      cwd: resolved.cwd,
      env,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      graceMs: 100,
      onStdout: () => {
        throw new Error("parser blew up");
      },
    });
    expect(result.completion.kind).toBe("consumer-error");
    expect(result.durationMs).toBeLessThan(3000); // group reaped, not a 5s drip
    await expect(jail.release(resolved)).resolves.toBeUndefined();
  });
});
