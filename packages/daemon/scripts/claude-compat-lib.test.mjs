import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  VARIANT_PROFILES,
  analyzeStream,
  assessBudget,
  evaluateCompatVerdict,
} from "./claude-compat-lib.mjs";

function streamLine(value) {
  return `${JSON.stringify(value)}\n`;
}

describe("compat stream evidence", () => {
  it("pairs tool results by tool_use_id and counts only an exact terminal command", () => {
    const stdout =
      streamLine({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", id: "read", input: { command: "cat /work/loopzhb-compat-evidence/TASK.md" } },
            { type: "tool_use", name: "Bash", id: "terminal", input: { command: 'loopzhb report --status nothing-new --message "ok"' } },
          ],
        },
      }) +
      streamLine({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "terminal", is_error: false, content: "done" },
            { type: "tool_result", tool_use_id: "read", is_error: true, content: "denied" },
          ],
        },
      });

    const stream = analyzeStream(stdout);
    expect(stream.calls).toEqual([
      { id: "read", command: "cat /work/loopzhb-compat-evidence/TASK.md", result: { isError: true, preview: "denied" } },
      {
        id: "terminal",
        command: 'loopzhb report --status nothing-new --message "ok"',
        result: { isError: false, preview: "done" },
      },
    ]);
    expect(stream.terminalCalls).toHaveLength(1);
  });

  it("fails a production verdict when an asserted side effect or refusal is missing", () => {
    const commands = {
      taskRead: "cat '/work/TASK.md'",
      success: "echo compat-ok > compat-ok.txt",
      expectedFailure: "cat no-such-compat-file.txt",
      terminal: 'loopzhb report --status nothing-new --message "compat R done"',
      denials: ["echo denied > /private/tmp/other-run/file"],
    };
    const stream = {
      calls: [
        { id: "r", command: commands.taskRead, result: { isError: false, preview: "task" } },
        { id: "s", command: commands.success, result: { isError: false, preview: "" } },
        { id: "f", command: commands.expectedFailure, result: { isError: true, preview: "missing" } },
        { id: "d", command: commands.denials[0], result: { isError: false, preview: "wrongly allowed" } },
        { id: "t", command: commands.terminal, result: { isError: false, preview: "" } },
      ],
      terminalCalls: [{ id: "t", command: commands.terminal, result: { isError: false, preview: "" } }],
      terminal: { type: "result", total_cost_usd: 0.1 },
    };
    const verdict = evaluateCompatVerdict({
      variant: "R",
      reportOk: true,
      stream,
      markers: { opensslAbort: false, cwdEperm: false },
      sideEffectOk: false,
      commands,
      refusal: { allProbesAttempted: false, allProbesDenied: false, allTargetsIntact: false },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(
      expect.arrayContaining([
        "success side effect missing",
        "refusal probe did not reach the shell attempt",
        "refusal probe did not take the denied branch",
        "refusal target changed",
      ]),
    );
  });

  it("rejects duplicate and missing terminal calls even when the runner report is ok", () => {
    const terminal = 'loopzhb report --status nothing-new --message "compat P done"';
    const calls = [
      { id: "t1", command: terminal, result: { isError: false, preview: "" } },
      { id: "t2", command: terminal, result: { isError: false, preview: "" } },
    ];
    const verdict = evaluateCompatVerdict({
      variant: "P",
      reportOk: true,
      stream: { calls, terminalCalls: calls, terminal: { type: "result" } },
      markers: { opensslAbort: false, cwdEperm: false },
      sideEffectOk: true,
      commands: { taskRead: "cat '/work/TASK.md'", success: "success", expectedFailure: "failure", terminal, denials: [] },
      refusal: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toContain("terminal command count was 2, expected 1");
  });

  it("rejects an otherwise successful run that executes an extra Bash command", () => {
    const commands = {
      taskRead: "cat '/work/TASK.md'",
      success: "echo compat-ok > compat-ok.txt",
      expectedFailure: "cat no-such-compat-file.txt",
      terminal: 'loopzhb report --status nothing-new --message "compat P done"',
      denials: [],
    };
    const calls = [
      { id: "r", command: commands.taskRead, result: { isError: false, preview: "task" } },
      { id: "s", command: commands.success, result: { isError: false, preview: "" } },
      { id: "f", command: commands.expectedFailure, result: { isError: true, preview: "missing" } },
      { id: "x", command: "pwd", result: { isError: false, preview: "/work" } },
      { id: "t", command: commands.terminal, result: { isError: false, preview: "" } },
    ];
    const verdict = evaluateCompatVerdict({
      variant: "P",
      reportOk: true,
      stream: { calls, terminalCalls: [calls[4]], terminal: { type: "result" } },
      markers: { opensslAbort: false, cwdEperm: false },
      sideEffectOk: true,
      commands,
      refusal: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toContain("unexpected Bash command count was 1");
  });
});

describe("compat diagnostic budget", () => {
  const now = Date.parse("2026-09-08T00:30:00Z");
  const row = (overrides = {}) => ({ variant: "A", runId: "run-1", at: "2026-09-08T00:00:00Z", usd: 0.1, status: "complete", ...overrides });

  it("blocks persistently after any started or unknown-cost call", () => {
    expect(assessBudget([row({ usd: null, status: "cost-unknown" })], now).reason).toMatch(/unknown cost/);
    expect(assessBudget([row({ usd: null, status: "started" })], now).reason).toMatch(/unfinished call/);
  });

  it("enforces the call count, elapsed-time and dollar limits", () => {
    expect(assessBudget(Array.from({ length: 8 }, (_, i) => row({ runId: `run-${i}` })), now).reason).toMatch(/8 call/);
    expect(assessBudget([row({ at: "2026-09-07T22:59:59Z" })], now).reason).toMatch(/90 minute/);
    expect(assessBudget([row({ usd: 3 })], now).reason).toMatch(/\$3/);
  });

  it("rejects a malformed ledger instead of treating it as empty", () => {
    expect(() => assessBudget([{ nope: true }], now)).toThrow(/invalid spend ledger/);
  });
});

describe("compat experiment profiles", () => {
  it("keeps A/B/C/D as isolated legacy/fixed combinations and reserves P/R for production", () => {
    expect(VARIANT_PROFILES).toEqual({
      A: { wrapper: "legacy", runTemp: "legacy", purpose: "diagnostic" },
      B: { wrapper: "legacy", runTemp: "fixed", purpose: "diagnostic" },
      C: { wrapper: "fixed", runTemp: "legacy", purpose: "diagnostic" },
      D: { wrapper: "fixed", runTemp: "fixed", purpose: "diagnostic" },
      P: { wrapper: "fixed", runTemp: "fixed", purpose: "production" },
      R: { wrapper: "fixed", runTemp: "fixed", purpose: "refusal" },
    });
  });
});

describe("compat command entry", () => {
  const script = path.join(import.meta.dirname, "claude-compat.mjs");
  const fixture = path.resolve(import.meta.dirname, "../test-fixtures/fake-claude.mjs");
  const fixtureSha = createHash("sha256").update(readFileSync(fixture)).digest("hex");

  function run(variant, prepare, envOverrides = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), "loopzhb-compat-entry-"));
    const evidence = path.join(root, "evidence");
    const ledgerDir = path.join(root, "loopzhb-compat-evidence");
    prepare?.({ evidence, ledgerDir, root });
    const result = spawnSync(process.execPath, [script, "--variant", variant, "--evidence-dir", evidence], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
        LOOPZHB_CLAUDE_BIN: fixture,
        LOOPZHB_EXPECTED_CLAUDE_SHA256: fixtureSha,
        LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD: "1",
        ...envOverrides,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { root, evidence, ledgerDir, result };
  }

  function startRun(root, evidence, configName) {
    const child = spawn(process.execPath, [script, "--variant", "P", "--evidence-dir", evidence], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: path.join(root, configName),
        LOOPZHB_CLAUDE_BIN: fixture,
        LOOPZHB_EXPECTED_CLAUDE_SHA256: fixtureSha,
        LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { child, done };
  }

  async function waitForStartedLedger(ledgerPath) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const rows = JSON.parse(readFileSync(ledgerPath, "utf8"));
        if (rows.some((row) => row.status === "started")) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for started ledger reservation");
  }

  it("returns success for a complete production smoke and persists source/capability evidence", () => {
    const execution = run("P");
    try {
      expect(execution.result.status, execution.result.stderr).toBe(0);
      const evidenceName = readFileSync(path.join(execution.ledgerDir, "acceptance-spend-ledger.json"), "utf8");
      expect(evidenceName).toContain('"status": "complete"');
      const files = readdirSync(execution.evidence);
      const record = JSON.parse(readFileSync(path.join(execution.evidence, files.find((name) => /^compat-P-.+\.json$/.test(name))), "utf8"));
      expect(record.verdict).toEqual({ ok: true, failures: [] });
      expect(record.config.sourceIdentity).toMatchObject({
        head: expect.stringMatching(/^[a-f0-9]{40}$/),
        dirty: expect.any(Boolean),
        worktreeStatusSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        policySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(record.config.sourceIdentity.runtimeArtifactSha256["claude-runner.js"]).toMatch(/^[a-f0-9]{64}$/);
      expect(record.config.observedCapability.claudeCodeTmpdir).toMatch(/^\/private\/tmp\/lzc-/);
      expect(record.loopzhbCalls).toBe(1);
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  });

  it("requires an explicit independent budget before a P/R acceptance call", () => {
    const execution = run("P", undefined, { LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD: undefined });
    try {
      expect(execution.result.status).toBe(3);
      expect(execution.result.stderr).toContain("requires explicit LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD");
      expect(readdirSync(execution.evidence)).toEqual([]);
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  });

  it("returns failure when refusal commands are reported as allowed despite an ok runner report", () => {
    const execution = run("R", undefined, { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "allow-refusals") });
    try {
      expect(execution.result.status).toBe(1);
      expect(execution.result.stderr).toContain("refusal probe did not reach the shell attempt");
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  });

  it("returns success when every refusal reaches the shell, takes the denied branch, and leaves targets intact", () => {
    const execution = run("R");
    try {
      expect(execution.result.status, execution.result.stderr).toBe(0);
      const file = readdirSync(execution.evidence).find((name) => /^compat-R-.+\.json$/.test(name));
      const record = JSON.parse(readFileSync(path.join(execution.evidence, file), "utf8"));
      expect(record.markers.opensslAbort).toBe(false);
      expect(record.refusal).toMatchObject({
        allProbesAttempted: true,
        allProbesDenied: true,
        allTargetsIntact: true,
      });
      expect(record.verdict).toEqual({ ok: true, failures: [] });
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  });

  it("runs the final A/B/C/D matrix with the selected wrapper and temp capabilities", () => {
    const expected = {
      A: { legacyWrapper: true, hasRunTemp: false },
      B: { legacyWrapper: true, hasRunTemp: true },
      C: { legacyWrapper: false, hasRunTemp: false },
      D: { legacyWrapper: false, hasRunTemp: true },
    };
    for (const [variant, wanted] of Object.entries(expected)) {
      const execution = run(variant);
      try {
        // The fake does not reproduce macOS markers, so negative controls
        // A/B/C correctly fail their signature check; D is a green run.
        expect(execution.result.status).toBe(variant === "D" ? 0 : 1);
        const file = readdirSync(execution.evidence).find((name) => new RegExp(`^compat-${variant}-.+\\.json$`).test(name));
        const record = JSON.parse(readFileSync(path.join(execution.evidence, file), "utf8"));
        expect(record.config.wrapperConfigured).toBe(true);
        expect(record.config.runTempConfigured).toBe(true);
        expect(record.config.bundleSha256 === record.config.wrapperSha256).toBe(wanted.legacyWrapper);
        expect(record.config.observedCapability.claudeCodeTmpdir !== null).toBe(wanted.hasRunTemp);
      } finally {
        rmSync(execution.root, { recursive: true, force: true });
      }
    }
  });

  it("blocks before probing when an earlier call has unknown cost", () => {
    const execution = run("P", ({ ledgerDir }) => {
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(
        path.join(ledgerDir, "acceptance-spend-ledger.json"),
        JSON.stringify([{ variant: "A", runId: "old", at: new Date().toISOString(), usd: null, status: "cost-unknown" }]),
      );
    });
    try {
      expect(execution.result.status).toBe(3);
      expect(execution.result.stderr).toContain("unknown cost");
      expect(readdirSync(execution.evidence)).toEqual([]);
      expect(readdirSync(execution.ledgerDir)).toEqual(["acceptance-spend-ledger.json"]);
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent acceptance call and preserves its ledger row", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "loopzhb-compat-concurrent-"));
    const ledgerPath = path.join(root, "loopzhb-compat-evidence", "acceptance-spend-ledger.json");
    const first = startRun(root, path.join(root, "evidence-one"), "slow-compat");
    try {
      await waitForStartedLedger(ledgerPath);
      const second = startRun(root, path.join(root, "evidence-two"), "normal-compat");
      const [firstResult, secondResult] = await Promise.all([first.done, second.done]);
      expect(firstResult.status, firstResult.stderr).toBe(0);
      expect(secondResult.status).toBe(3);
      expect(secondResult.stderr).toContain("unfinished call");
      const rows = JSON.parse(readFileSync(ledgerPath, "utf8"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ variant: "P", status: "complete", usd: 0.001 });
      expect(readdirSync(path.join(root, "evidence-two")).some((name) => /^compat-P-.+\.json$/.test(name))).toBe(false);
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
