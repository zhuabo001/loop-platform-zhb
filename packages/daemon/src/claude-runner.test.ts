/**
 * Claude adapter pins (Phase 2 batch 3, plan §2.2–2.4 — group A): the real
 * Claude Code Runner, exercised against the fake-claude fixture executable
 * through REAL spawns (process group, timeout, abort — no subprocess mocks).
 *
 * Pinned contract:
 *  - the fixed argv shape and the dynamic fail-closed sandbox settings JSON;
 *    NO MCP/plugins/hooks/skills/network/non-Bash escape hatch anywhere;
 *  - agent gate: missing/"claude-code" executes; "codex"/"grok" return the
 *    fixed `unsupported agent` failure WITHOUT spawning;
 *  - outcome mapping: role=evolve → "evolve", every other successful role →
 *    "exec"; success requires exit 0 AND a success terminal;
 *  - every child-derived text (progress, finalText, error) is redacted with
 *    the env secrets AND the run token before it leaves the adapter;
 *  - the per-run scratch is released in a finally; a failed release fails the
 *    run (the success report is discarded);
 *  - spawn-time revalidation failure means NO spawn and a failed run.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Delivery } from "@loopzhb/protocol";

import { resolveClaudeProviderEnv } from "./claude-provider-env.js";
import { createClaudeRunner, type ClaudeRunnerDeps } from "./claude-runner.js";
import { createControlRoot, type ControlRoot } from "./control-root.js";
import { JailError, createWorkdirJail, type ResolvedWorkdir, type WorkdirJail } from "./jail.js";
import type { ClaudeBinaryIdentity } from "./probe-claude.js";
import { statClaudeBinary } from "./probe-claude.js";
import type { AgentRunner, RunnerReport } from "./runner.js";
import { ProcessControlError } from "./subprocess.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/fake-claude.mjs", import.meta.url));
const SIDECAR = ".fake-claude-session.json";

const ENV_SOURCE: NodeJS.ProcessEnv = {
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  HOME: "/tmp",
  ANTHROPIC_API_KEY: "sk-ant-fixture-secret",
  LOOPZHB_MACHINE_CREDENTIAL: "dk_should_not_leak",
  GITHUB_TOKEN: "ghp_should_not_leak",
};

let base: string;
let root: string;
let workdir: string;
let jail: WorkdirJail;
let controlRoot: ControlRoot;

beforeEach(async () => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-claude-test-"));
  root = path.join(base, "root");
  workdir = path.join(root, "work");
  mkdirSync(workdir, { recursive: true });
  jail = await createWorkdirJail({ allowedRoots: [root], scratchBase: path.join(base, "scratch") });
  controlRoot = await createControlRoot(path.join(base, "control-base"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    runId: "run-1",
    runToken: "rk_adapter_token",
    role: "exec",
    loop: {
      id: "loop-1",
      name: "Loop",
      workdir,
      taskFile: null,
      workflow: null,
      model: null,
      allowControl: false,
    },
    prevState: null,
    roots: [],
    systemPrompt: "",
    task: "fake-claude://ok",
    ...overrides,
  };
}

interface Harness {
  runner: AgentRunner;
  progress: string[];
  run(delivery: Delivery, signal?: AbortSignal): Promise<RunnerReport>;
}

function makeRunner(depOverrides: Partial<ClaudeRunnerDeps> = {}): Harness {
  const progress: string[] = [];
  const runner = createClaudeRunner({
    jail,
    claudeBin: FIXTURE,
    timeoutMs: 10_000,
    envSource: ENV_SOURCE,
    controlRoot,
    ...depOverrides,
  });
  return {
    runner,
    progress,
    run: (delivery, signal = new AbortController().signal) =>
      runner.run(delivery, { signal, onProgress: (label) => progress.push(label) }),
  };
}

function readSidecar(): { argv: string[]; env: Record<string, string | null>; prompt?: string } {
  return JSON.parse(readFileSync(path.join(workdir, SIDECAR), "utf8")) as {
    argv: string[];
    env: Record<string, string | null>;
    prompt?: string;
  };
}

describe("A1–A3: the fixed argv and the dynamic sandbox settings", () => {
  it("A1: the argv shape is exactly the pinned CLI form", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery());
    expect(report.ok).toBe(true);

    const sidecar = readSidecar();
    expect(sidecar.argv).toEqual([
      "-p",
      "fake-claude://ok",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--tools",
      "Bash",
      "--permission-mode",
      "dontAsk",
      "--prompt-suggestions",
      "false",
      "--settings",
      expect.any(String),
    ]);
  });

  it("A1b: forwards the exact Claude process-group lifecycle to the acceptance observer", async () => {
    const events: Array<{ kind: "started" | "closed"; pgid: number }> = [];
    const { run } = makeRunner({ onProcessGroup: (event) => events.push(event) });

    const report = await run(makeDelivery());

    expect(report.ok).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "started" });
    expect(events[1]).toEqual({ kind: "closed", pgid: events[0]!.pgid });
  });

  it("A1c: settings sources stay DISABLED — the provider bootstrap never reopens them", async () => {
    // The Issue #38 fix converges provider config into env vars; it must NOT
    // relax the runtime isolation. The A1 golden pins the exact argv; this
    // pin names the regression directly: --setting-sources is always the
    // empty string, never user/project/local.
    const configDir = path.join(base, "claude-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-a1c-settings" } }),
    );
    const envSource = resolveClaudeProviderEnv({ ...ENV_SOURCE, CLAUDE_CONFIG_DIR: configDir });
    const { run } = makeRunner({ envSource });
    const report = await run(makeDelivery());
    expect(report.ok).toBe(true);

    const argv = readSidecar().argv;
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--safe-mode");
    for (const forbidden of ["user", "project", "local"]) {
      expect(argv[argv.indexOf("--setting-sources") + 1]).not.toBe(forbidden);
    }
    // No credential or settings JSON rides argv either (plan §2 boundary 5).
    expect(argv.join("\n")).not.toContain("sk-ant-a1c-settings");
  });

  it("A1d: bootstrap-resolved provider env reaches the child — allowed settings fields in, refused fields out", async () => {
    // The deterministic integration of plan §6 step 5: temp CLAUDE_CONFIG_DIR
    // fixture → resolveClaudeProviderEnv → runner → fake-claude sidecar env.
    const configDir = path.join(base, "claude-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "sk-ant-a1d-settings-secret",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-a1d-settings",
          GITHUB_TOKEN: "ghp-a1d-settings-decoy",
          LOOPZHB_SERVER_URL: "http://a1d-evil.example",
        },
      }),
    );
    const envSource = resolveClaudeProviderEnv({
      PATH: ENV_SOURCE.PATH,
      HOME: ENV_SOURCE.HOME,
      CLAUDE_CONFIG_DIR: configDir,
      LOOPZHB_MACHINE_CREDENTIAL: ENV_SOURCE.LOOPZHB_MACHINE_CREDENTIAL,
    });
    const { run } = makeRunner({ envSource });
    const report = await run(makeDelivery());
    expect(report.ok).toBe(true);

    const sidecar = readSidecar();
    expect(sidecar.env.ANTHROPIC_API_KEY).toBe("sk-ant-a1d-settings-secret");
    expect(sidecar.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-a1d-settings");
    expect(sidecar.env.GITHUB_TOKEN).toBeNull();
    expect(sidecar.env.LOOPZHB_MACHINE_CREDENTIAL).toBeNull();
  });

  it("A1e: a settings-derived secret is redacted out of report-bound child text", async () => {
    // echo-secret embeds $ANTHROPIC_API_KEY in the terminal text: the value
    // came from the settings fixture, NOT the launch env — proof that
    // bootstrap-injected credentials are inside the secretValues net.
    const settingsSecret = "sk-ant-a1e-settings-secret";
    const configDir = path.join(base, "claude-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: settingsSecret } }));
    const envSource = resolveClaudeProviderEnv({
      PATH: ENV_SOURCE.PATH,
      HOME: ENV_SOURCE.HOME,
      CLAUDE_CONFIG_DIR: configDir,
    });
    const { run } = makeRunner({ envSource });
    const report = await run(makeDelivery({ task: "fake-claude://echo-secret" }));
    expect(report.ok).toBe(true);
    expect(report.finalText).not.toContain(settingsSecret);
  });

  it("A2: --model and --append-system-prompt append only when configured", async () => {
    const { run } = makeRunner();
    const d = makeDelivery();
    d.loop = { ...d.loop, model: "claude-fable-5" };
    d.systemPrompt = "be terse";
    d.task = "fake-claude://ok";
    await run(d);

    const argv = readSidecar().argv;
    expect(argv.slice(-4)).toEqual(["--model", "claude-fable-5", "--append-system-prompt", "be terse"]);
  });

  it("A3: the settings JSON is exactly the fail-closed sandbox profile — no MCP/plugins/hooks/skills/network/non-Bash escape", async () => {
    const { run } = makeRunner();
    await run(makeDelivery());

    const argv = readSidecar().argv;
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!) as Record<string, unknown>;
    expect(settings).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: {
          disabled: false,
          denyRead: ["/"],
          allowRead: [realpathSync(root), realpathSync(workdir)],
          allowWrite: [realpathSync(root), realpathSync(workdir)],
        },
        network: { strictAllowlist: true, allowedDomains: [] },
      },
      disableAllHooks: true,
      autoMemoryEnabled: false,
    });

    // The audit: no key ANYWHERE in the settings tree may open an escape
    // hatch, and the permission mode is never bypass.
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object" && v !== null) {
        for (const [k, inner] of Object.entries(v)) {
          keys.push(k);
          walk(inner);
        }
      }
    };
    walk(settings);
    expect(keys.filter((k) => /mcp|plugin|skill|hook(?!s$)|bypass/i.test(k) && k !== "disableAllHooks")).toEqual([]);
    expect(argv).not.toContain("bypassPermissions");
  });

  it("A3b: a workdir that IS an effective root dedupes the allow lists", async () => {
    const { run } = makeRunner();
    const d = makeDelivery();
    d.loop = { ...d.loop, workdir: root };
    await run(d);

    const argv = JSON.parse(readFileSync(path.join(root, SIDECAR), "utf8")).argv as string[];
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.sandbox.filesystem.allowRead).toEqual([realpathSync(root)]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([realpathSync(root)]);
  });
});

describe("A4: the agent gate", () => {
  it("missing agent and claude-code execute; codex/grok fail unsupported WITHOUT spawning", async () => {
    const h = makeRunner();

    const okReport = await h.run(makeDelivery());
    expect(okReport.ok).toBe(true);
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(true);
    rmSync(path.join(workdir, SIDECAR));

    const explicit = makeDelivery();
    explicit.loop = { ...explicit.loop, agent: "claude-code" };
    await expect(h.run(explicit)).resolves.toMatchObject({ ok: true });

    for (const agent of ["codex", "grok"] as const) {
      rmSync(path.join(workdir, SIDECAR), { force: true });
      const d = makeDelivery();
      d.loop = { ...d.loop, agent };
      const report = await h.run(d);
      expect(report).toEqual({ ok: false, error: `unsupported agent: ${agent}` });
      expect(existsSync(path.join(workdir, SIDECAR))).toBe(false); // never spawned
    }
  });
});

describe("A5–A6: outcome mapping and the success report", () => {
  it("A5: role=evolve reports outcome=evolve; exec and edit report exec", async () => {
    const h = makeRunner();
    for (const [role, outcome] of [
      ["exec", "exec"],
      ["edit", "exec"],
      ["evolve", "evolve"],
    ] as const) {
      const report = await h.run(makeDelivery({ role }));
      expect(report.ok).toBe(true);
      expect(report.outcome).toBe(outcome);
    }
  });

  it("A6: the success report carries finalText/sessionId/durationMs/cost — and never a runId", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery());
    expect(report).toEqual({
      ok: true,
      outcome: "exec",
      finalText: "fake final text",
      sessionId: "fake-sess-1",
      durationMs: expect.any(Number),
      cost: { usd: 0.0042, inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44, numTurns: 1 },
    });
    expect(report).not.toHaveProperty("runId");
  });
});

describe("A8/A24: child-derived output boundaries", () => {
  it("A24: production progress exposes semantic events, never child-controlled text", async () => {
    const { run, progress } = makeRunner();
    const d = makeDelivery({ task: "fake-claude://progress-secret" });
    await run(d);
    expect(progress).toEqual(["claude response"]);
    expect(progress.join("\n")).not.toContain("sk-ant-fixture-secret");

    // An encoded credential split across event boundaries is not recoverable:
    // neither fragment is forwarded at all. Per-event text redaction cannot
    // provide that guarantee because each half is harmless in isolation.
    const split = makeRunner();
    await split.run(makeDelivery({ task: "fake-claude://split-progress-secret" }));
    expect(split.progress).toEqual(["claude response", "claude response"]);

    const normal = makeRunner();
    await normal.run(makeDelivery({ task: "fake-claude://ok" }));
    expect(normal.progress).toEqual(["claude response", "running Bash"]);

    const retry = makeRunner();
    await retry.run(makeDelivery({ task: "fake-claude://api-retry" }));
    expect(retry.progress).toEqual(["provider api retry", "claude response", "running Bash"]);
  });

  it("A8: finalText and error text are redacted before entering the report", async () => {
    const { run } = makeRunner();
    const ok = await run(makeDelivery({ task: "fake-claude://echo-secret" }));
    expect(ok.finalText).not.toContain("sk-ant-fixture-secret");

    const bad = await run(makeDelivery({ task: "fake-claude://error-result" }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("blew up with ");
    expect(bad.error).not.toContain("sk-ant-fixture-secret");
  });
});

describe("A20: the session identity is verified and scrubbed", () => {
  it("a session_id embedding a secret is redacted in the success report", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://secret-session" }));
    expect(report.ok).toBe(true);
    expect(report.sessionId).toMatch(/^sess-./);
    expect(report.sessionId).not.toContain("sk-ant-fixture-secret");
  });

  it("an init/result session conflict fails the run with a stable, content-free stream error", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://session-conflict" }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("session-id-conflict");
    expect(report.error).not.toContain("fake-sess-init");
    expect(report.error).not.toContain("fake-sess-result");
  });
});

describe("A21: the probe-pinned binary identity (review round-1 P1)", () => {
  const identityOf = async (target: string): Promise<ClaudeBinaryIdentity> => await statClaudeBinary(target);

  it("spawns the probe-RESOLVED path, never a PATH lookup", async () => {
    const { run } = makeRunner({
      // Would ENOENT if spawned — proof the resolved path is what executes.
      claudeBin: "/nonexistent/definitely-not-claude",
      probedBinary: await identityOf(FIXTURE),
    });
    const report = await run(makeDelivery());
    expect(report.ok).toBe(true);
  });

  it("a drifted identity fails the run WITHOUT spawning", async () => {
    const { run } = makeRunner({
      probedBinary: { ...(await identityOf(FIXTURE)), size: statSync(FIXTURE).size + 1 },
    });
    const report = await run(makeDelivery());
    expect(report.ok).toBe(false);
    expect(report.error).toContain("binary");
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false); // never spawned
  });

  it("an in-place replacement (same path, new content) fails the run", async () => {
    const local = path.join(base, "claude-copy");
    copyFileSync(FIXTURE, local);
    chmodSync(local, 0o755);
    const { run } = makeRunner({ claudeBin: local, probedBinary: await identityOf(local) });
    writeFileSync(local, "#!/usr/bin/env node\n// tampered\n");
    const report = await run(makeDelivery());
    expect(report.ok).toBe(false);
    expect(report.error).toContain("binary");
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });

  it("A23: a same-size overwrite with ALL stat fields intact is still caught by the content hash (review round-2 P1)", async () => {
    const local = path.join(base, "claude-copy2");
    copyFileSync(FIXTURE, local);
    chmodSync(local, 0o755);
    const pinned = await identityOf(local);
    // Same-length in-place overwrite: the dev/ino/mtimeMs/size quadruple is
    // (re)stat-able to identical values — only the CONTENT differs. The pin
    // below keeps the post-tamper stat fields with the PRE-tamper hash, so
    // every stat field matches by construction and only the hash can catch it.
    const original = readFileSync(local, "utf8");
    const tampered = original.replace("fake final text", "FAKE FINAL TEXT");
    expect(tampered).not.toBe(original);
    expect(tampered.length).toBe(original.length);
    writeFileSync(local, tampered);
    const after = await statClaudeBinary(local);
    const { run } = makeRunner({ claudeBin: local, probedBinary: { ...after, sha256: pinned.sha256 } });
    const report = await run(makeDelivery());
    expect(report.ok).toBe(false);
    expect(report.error).toContain("binary");
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });

  it("a vanished binary fails the run", async () => {
    const gone = path.join(base, "gone-claude");
    const { run } = makeRunner({
      probedBinary: { resolvedPath: gone, dev: 1, ino: 1, mtimeMs: 1, size: 1, sha256: "0".repeat(64) },
    });
    const report = await run(makeDelivery());
    expect(report.ok).toBe(false);
    expect(report.error).toContain("binary");
  });
});

describe("A9–A12: failure mapping", () => {
  it("A9: an is_error terminal fails the run with the redacted CLI narrative and NO outcome", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://error-result" }));
    expect(report.ok).toBe(false);
    expect(report).not.toHaveProperty("outcome");
    expect(report.error).toContain("blew up with ");
    expect(report.error).not.toContain("sk-ant-fixture-secret");
  });

  it("A10: a non-zero exit without a terminal result reports the exit code", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://exit3" }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("code 3");
  });

  it("A11: malformed stdout fails with a stable, content-free stream error", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://garbage" }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("malformed-json");
    expect(report.error).not.toContain("not json at all"); // no untrusted transcript
  });

  it("A12: a clean exit without a terminal result is missing-result", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://no-result" }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("missing-result");
  });

  it("A12b: failure error text is capped at the report error cap", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery({ task: "fake-claude://big-error" }));
    expect(report.ok).toBe(false);
    expect(report.error!.length).toBeLessThanOrEqual(2000);
  });
});

describe("A13–A14: timeout and abort", () => {
  it("A13: a hung child is terminated at the timeout and reported as such", async () => {
    const { run } = makeRunner({ timeoutMs: 300 });
    const started = Date.now();
    const report = await run(makeDelivery({ task: "fake-claude://hang" }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000); // TERM sufficed — no 5s KILL grace
  });

  it("A14: aborting the run signal terminates the child and reports aborted", async () => {
    const { run } = makeRunner({ timeoutMs: 30_000 });
    const ctl = new AbortController();
    const pending = run(makeDelivery({ task: "fake-claude://hang" }), ctl.signal);
    const deadline = Date.now() + 5000;
    while (!existsSync(path.join(workdir, SIDECAR)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ctl.abort();
    const report = await pending;
    expect(report.ok).toBe(false);
    expect(report.error).toContain("aborted");
  });
});

describe("A15–A16: the scratch lifecycle", () => {
  const scratchRootOf = (): string => {
    const scratchBase = path.join(base, "scratch");
    const entries = readdirSync(scratchBase).filter((e) => e.startsWith("loopzhb-runs-"));
    expect(entries).toHaveLength(1);
    return path.join(scratchBase, entries[0]!);
  };

  it("A15: a null workdir mints a per-run scratch that is released after the run", async () => {
    const { run } = makeRunner();
    const d = makeDelivery();
    d.loop = { ...d.loop, workdir: null };
    const report = await run(d);
    expect(report.ok).toBe(true);
    expect(readdirSync(scratchRootOf())).toEqual([]); // the per-run dir is gone
  });

  it("A16: a failed release FAILS the run — the success report is discarded", async () => {
    const { run } = makeRunner();
    const d = makeDelivery({ task: "fake-claude://self-swap-scratch" });
    d.loop = { ...d.loop, workdir: null };
    await expect(run(d)).rejects.toThrow(JailError);
  });
});

describe("A22: a scratch-release failure never masks a process-control failure (review round-2 P1)", () => {
  it("the ProcessControlError survives a throwing release — the fatal signal reaches the runtime", async () => {
    const resolution: ResolvedWorkdir = { cwd: workdir, effectiveRoots: [realpathSync(root)], scratchDir: null };
    const stub: WorkdirJail = {
      daemonRoots: [realpathSync(root)],
      scratchRoot: path.join(base, "unused-test-scratch"),
      resolve: () => Promise.resolve(resolution),
      revalidate: () => Promise.resolve(),
      release: () => Promise.reject(new JailError("scratch identity broken")),
      dispose: () => Promise.resolve(),
    };
    const runner = createClaudeRunner({
      jail: stub,
      claudeBin: FIXTURE,
      timeoutMs: 10_000,
      envSource: ENV_SOURCE,
      // TEST-ONLY seam: a real child cannot fail its own kill on demand, so
      // the combined-failure path is driven through an injected spawn.
      spawnImpl: () => Promise.reject(new ProcessControlError("process control failed: kill EPERM")),
    });
    const err = await runner
      .run(makeDelivery(), { signal: new AbortController().signal, onProgress: () => {} })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProcessControlError);
    expect((err as Error).message).toContain("EPERM");
    expect((err as Error).message).toContain("release"); // the cleanup failure rides along, not over
  });
});

describe("A17–A19: jail wiring", () => {
  /** A spy/failing jail double for the adapter-level seam pins. */
  function stubJail(overrides: Partial<WorkdirJail> = {}) {
    const calls: { resolve?: Parameters<WorkdirJail["resolve"]>[0]; revalidated: number } = { revalidated: 0 };
    const resolution: ResolvedWorkdir = { cwd: workdir, effectiveRoots: [realpathSync(root)], scratchDir: null };
    const stub: WorkdirJail = {
      daemonRoots: [realpathSync(root)],
      scratchRoot: path.join(base, "unused-test-scratch"),
      resolve: (input) => {
        calls.resolve = input;
        return Promise.resolve(resolution);
      },
      revalidate: () => {
        calls.revalidated += 1;
        return Promise.resolve();
      },
      release: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
      ...overrides,
    };
    return { stub, calls };
  }

  it("A17: a revalidate failure rejects the run and NEVER spawns", async () => {
    const { stub } = stubJail({
      revalidate: () => Promise.reject(new JailError("cwd swapped for a symlink")),
    });
    const { run } = makeRunner({ jail: stub });
    await expect(run(makeDelivery())).rejects.toThrow(JailError);
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });

  it("A18: resolve receives the delivery's workdir/roots/loopId/runId verbatim", async () => {
    const { stub, calls } = stubJail();
    const { run } = makeRunner({ jail: stub });
    const d = makeDelivery({ roots: ["/server/root"] });
    await run(d);
    expect(calls.resolve).toEqual({
      workdir,
      serverRoots: ["/server/root"],
      loopId: "loop-1",
      runId: "run-1",
    });
    expect(calls.revalidated).toBe(1);
  });

  it("A19: the child env is exactly the whitelist — LOOPZHB_*/GITHUB_TOKEN stripped, ANTHROPIC_* forwarded", async () => {
    const { run } = makeRunner();
    await run(makeDelivery());
    const { env } = readSidecar();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fixture-secret");
    expect(env.LOOPZHB_MACHINE_CREDENTIAL).toBeNull();
    expect(env.GITHUB_TOKEN).toBeNull();
    expect(env.PATH).toContain(path.dirname(process.execPath));
  });
});

/**
 * V-group (Phase 4 Batch 2, plan §2.1/§2.2): the terminal-protocol v1
 * execution path — control directory, journal env injection, task-file
 * preflight, daemon-built prompt, journal collection and task-file sync.
 * The fixture's v1 scenarios are selected via <cwd>/.fake-claude-v1-scenario
 * (the -p value is the built prompt now, not the scenario selector).
 */
const V1_SCENARIO = ".fake-claude-v1-scenario";
const V1_TASK_CONTENT = "# Task\n\n## Spec\n\ndo the thing\n";

function makeV1Delivery(overrides: Partial<Delivery> = {}): Delivery {
  const taskFile = path.join(workdir, "TASK.md");
  writeFileSync(taskFile, V1_TASK_CONTENT);
  return makeDelivery({
    terminalProtocol: 1,
    task: "[loop run]\nwire task text the v1 daemon must ignore",
    loop: {
      id: "loop-1",
      name: "Loop",
      workdir,
      taskFile,
      workflow: null,
      model: null,
      allowControl: false,
      goal: "close the gap",
    },
    ...overrides,
  });
}

function writeScenario(name: string): void {
  writeFileSync(path.join(workdir, V1_SCENARIO), name);
}

function sidecarSettings(): { filesystem: { allowRead: string[]; allowWrite: string[] } } {
  const argv = readSidecar().argv;
  const raw = argv[argv.indexOf("--settings") + 1]!;
  return (JSON.parse(raw) as { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } } }).sandbox;
}

describe("V1–V4: v1 spawn shape — prompt, sandbox, journal env", () => {
  it("V1: -p is the daemon-built prompt, the sandbox opens wrapper/context read-only + outbox writable", async () => {
    const { run } = makeRunner();
    writeScenario("journal-none"); // success exit, no record → journal_missing
    const delivery = makeV1Delivery();
    const report = await run(delivery);
    expect(report).toEqual({ ok: false, error: "journal_missing" });

    const sidecar = readSidecar();
    // The prompt is built locally — the wire task text never reaches the CLI.
    expect(sidecar.prompt).not.toContain("wire task text");
    expect(sidecar.prompt).toContain('Goal: "close the gap"');
    expect(sidecar.prompt).toContain(JSON.stringify(realpathSync(delivery.loop.taskFile!)));
    expect(sidecar.prompt).toContain("prev-state.json");
    expect(sidecar.prompt).toContain("loopzhb finish --reason"); // Closed Loop
    expect(sidecar.argv[1]).toBe(sidecar.prompt);

    // The sandbox profile: control root (wrapper), context and the daemon's
    // exact Node executable read-only; outbox is the ONLY extra writable dir.
    const outbox = sidecar.env.LOOPZHB_JOURNAL_OUTBOX!;
    const settings = sidecarSettings();
    expect(settings.filesystem.allowRead).toContain(controlRoot.rootDir);
    expect(settings.filesystem.allowRead).toContain(path.join(path.dirname(outbox), "context"));
    expect(settings.filesystem.allowRead).toContain(controlRoot.nodePath);
    expect(settings.filesystem.allowWrite).toContain(outbox);
    expect(settings.filesystem.allowWrite).not.toContain(controlRoot.rootDir);
    expect(settings.filesystem.allowWrite).not.toContain(controlRoot.nodePath);

    // PATH binds env(1)'s node lookup to the runtime that started the daemon.
    expect(sidecar.env.PATH!.split(path.delimiter).slice(0, 2)).toEqual([
      controlRoot.wrapperDir,
      controlRoot.nodeDir,
    ]);
    expect(outbox.startsWith(`${controlRoot.rootDir}/`)).toBe(true);
    expect(sidecar.env.LOOPZHB_MACHINE_CREDENTIAL).toBeNull();
    expect(sidecar.env.GITHUB_TOKEN).toBeNull();
  });

  it("V2: an Open Loop's prompt NEVER shows the finish example", async () => {
    const { run } = makeRunner();
    writeScenario("journal-none");
    const delivery = makeV1Delivery();
    await run({ ...delivery, loop: { ...delivery.loop, goal: null } });
    expect(readSidecar().prompt).not.toContain("loopzhb finish");
  });

  it("V3: the prompt points at the run's OWN context/prev-state.json inside the control root", async () => {
    const { run } = makeRunner();
    writeScenario("journal-none");
    await run(makeV1Delivery({ prevState: { cursor: 7 } }));
    const outbox = readSidecar().env.LOOPZHB_JOURNAL_OUTBOX!;
    const prevStatePath = path.join(path.dirname(outbox), "context", "prev-state.json");
    expect(readSidecar().prompt).toContain(JSON.stringify(prevStatePath));
    expect(prevStatePath.startsWith(controlRoot.rootDir)).toBe(true);
  });

  it("V4: a v0 delivery gets NO journal surface even with a control root present", async () => {
    const { run } = makeRunner();
    const report = await run(makeDelivery()); // v0: fake-claude://ok
    expect(report.ok).toBe(true);
    const sidecar = readSidecar();
    expect(sidecar.env.LOOPZHB_JOURNAL_OUTBOX).toBeNull();
    expect(sidecar.env.PATH!.startsWith(`${controlRoot.wrapperDir}:`)).toBe(false);
    expect(sidecar.prompt).toBe("fake-claude://ok");
    expect(sidecarSettings().filesystem.allowRead).not.toContain(controlRoot.rootDir);
    expect(sidecarSettings().filesystem.allowRead).not.toContain(controlRoot.nodePath);
  });
});

describe("V5–V8: task-file preflight refuses WITHOUT spawning", () => {
  it("V5: no taskFile configured → stable refusal, no spawn", async () => {
    const { run } = makeRunner();
    const delivery = makeV1Delivery();
    const report = await run({ ...delivery, loop: { ...delivery.loop, taskFile: null } });
    expect(report).toEqual({ ok: false, error: "task file not configured (terminal-protocol v1 requires one)" });
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });

  it("V6: a missing task file → preflight missing, no spawn", async () => {
    const { run } = makeRunner();
    const delivery = makeV1Delivery();
    rmSync(delivery.loop.taskFile!);
    const report = await run(delivery);
    expect(report).toEqual({ ok: false, error: "task file preflight: missing" });
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });

  it("V7: a task file outside the roots → preflight outside_jail, no spawn", async () => {
    const { run } = makeRunner();
    const outside = path.join(base, "TASK.md");
    writeFileSync(outside, V1_TASK_CONTENT);
    const delivery = makeV1Delivery();
    const report = await run({ ...delivery, loop: { ...delivery.loop, taskFile: outside } });
    expect(report).toEqual({ ok: false, error: "task file preflight: outside_jail" });
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });

  it("V8: a v1 delivery without a control-root dep fails closed, no spawn", async () => {
    const progress: string[] = [];
    const runner = createClaudeRunner({ jail, claudeBin: FIXTURE, timeoutMs: 10_000, envSource: ENV_SOURCE });
    const report = await runner.run(makeV1Delivery(), {
      signal: new AbortController().signal,
      onProgress: (label) => progress.push(label),
    });
    expect(report).toEqual({ ok: false, error: "terminal-protocol v1 run refused: this daemon has no control root" });
    expect(existsSync(path.join(workdir, SIDECAR))).toBe(false);
  });
});

describe("V9–V14: the journal drives the terminal command", () => {
  it("V9: a legal report record → ok with the terminal command + the synced task-file content", async () => {
    const { run } = makeRunner();
    writeScenario("report-resolved");
    const report = await run(makeV1Delivery());
    expect(report.ok).toBe(true);
    expect(report.terminal).toEqual({ kind: "report", status: "resolved", message: "done" });
    expect(report.taskFileContent).toBe(V1_TASK_CONTENT);
    expect(report.taskFileSyncError).toBeUndefined();
  });

  it("V10: the record's state rides the terminal command", async () => {
    const { run } = makeRunner();
    writeScenario("report-with-state");
    const report = await run(makeV1Delivery());
    expect(report.ok).toBe(true);
    expect(report.terminal).toEqual({ kind: "report", status: "resolved", message: "done", state: { cursor: 2 } });
  });

  it("V11: a finish record → terminal finish", async () => {
    const { run } = makeRunner();
    writeScenario("finish");
    const report = await run(makeV1Delivery());
    expect(report.ok).toBe(true);
    expect(report.terminal).toEqual({ kind: "finish", reason: "goal met" });
  });

  it("V12: two records → journal_multiple; a symlink entry → journal_multiple", async () => {
    const two = makeRunner();
    writeScenario("journal-two");
    expect(await two.run(makeV1Delivery())).toEqual({ ok: false, error: "journal_multiple" });

    const link = makeRunner();
    writeScenario("journal-symlink");
    expect((await link.run(makeV1Delivery())).error).toBe("journal_multiple: outbox holds a non-record entry");
  });

  it("V13: corrupt / marker / policy-violating records → journal_corrupt / journal_invalid", async () => {
    const corrupt = makeRunner();
    writeScenario("journal-corrupt");
    expect(await corrupt.run(makeV1Delivery())).toEqual({ ok: false, error: "journal_corrupt" });

    const marker = makeRunner();
    writeScenario("journal-invalid");
    expect((await marker.run(makeV1Delivery())).error).toBe("journal_invalid: the wrapper rejected the terminal invocation");

    const policy = makeRunner();
    writeScenario("journal-policy");
    expect((await policy.run(makeV1Delivery())).error).toBe("journal_invalid: malformed terminal command");
  });

  it("V14: a Claude failure always wins — the journal content is ignored", async () => {
    const { run } = makeRunner();
    writeScenario("journal-then-exit1");
    const report = await run(makeV1Delivery());
    expect(report.ok).toBe(false);
    expect(report.error).toContain("blew up");
    expect(report.error).not.toContain("journal");
    expect(report.terminal).toBeUndefined();
  });
});

describe("V15–V18: sync, redaction and cleanup", () => {
  it("V15: a post-run task-file failure downgrades to the sync error — the run stays ok", async () => {
    const { run } = makeRunner();
    writeScenario("report-delete-task"); // deletes <cwd>/TASK.md mid-run
    const report = await run(makeV1Delivery());
    expect(report.ok).toBe(true);
    expect(report.terminal).toEqual({ kind: "report", status: "resolved", message: "done" });
    expect(report.taskFileContent).toBeUndefined();
    expect(report.taskFileSyncError).toBe("missing");
  });

  it("V16: the daemon's second redaction layer scrubs journal text", async () => {
    const { run } = makeRunner();
    writeScenario("report-secret-text");
    const report = await run(makeV1Delivery());
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain("sk-ant-fixture-secret");
    expect(report.terminal).toMatchObject({ kind: "report", status: "resolved" });
  });

  it("V17: the run's control directory is released after the run", async () => {
    const { run } = makeRunner();
    writeScenario("report-resolved");
    await run(makeV1Delivery());
    expect(readdirSync(controlRoot.rootDir)).toEqual(["bin"]);
  });

  it("V18: the journal outbox env points inside the run's OWN control dir (per-run isolation)", async () => {
    const { run } = makeRunner();
    writeScenario("journal-none");
    await run(makeV1Delivery({ runId: "run-A" }));
    const firstOutbox = readSidecar().env.LOOPZHB_JOURNAL_OUTBOX!;
    rmSync(path.join(workdir, SIDECAR));
    await run(makeV1Delivery({ runId: "run-B" }));
    const secondOutbox = readSidecar().env.LOOPZHB_JOURNAL_OUTBOX!;
    expect(firstOutbox).not.toBe(secondOutbox);
    for (const outbox of [firstOutbox, secondOutbox]) {
      expect(outbox.startsWith(controlRoot.rootDir)).toBe(true);
      expect(outbox.endsWith("/outbox")).toBe(true);
    }
  });
});
