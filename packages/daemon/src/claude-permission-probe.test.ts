/**
 * The permission-layer probe (Issue #57) — OPT-IN, no model call, no cost.
 *
 * Under `--permission-mode dontAsk` a Bash call runs only if it is a built-in
 * read-only command, matches a `permissions.allow` rule, or the sandbox
 * auto-allows it — and the auto-allow DECLINES every command shape its
 * analyzer cannot reduce to a simple command. The v1 terminal command carries
 * agent-authored text (message/reason/state), so without the runner's grant
 * the run's DATA CONTENT decides whether it can finish at all. That is not a
 * theory: the 2026-09-26 real gate lost four paid runs to it, and ADR-006
 * records the same class refusing a `rc=$?` command in the sandbox smoke.
 *
 * The permission decision lives in the installed CLI, NOT in the model, so a
 * MOCK provider returning one canned Bash tool_use exercises the real layer:
 * same production argv (`buildClaudeArgs`), same production profile
 * (`buildSandboxSettings`), same control root / per-Run temp root / outbox.
 * What the CLI decides is read back from its own `permission_denials` and the
 * tool_result it sends; what happened is read back from the OUTBOX — a record
 * in there is proof the wrapper really ran inside the sandbox.
 *
 * Opt-in because it depends on the installed CLI version's internals (the
 * repo pins only a minimum version), so it never gates the offline suite:
 *
 *   LOOPZHB_CLAUDE_PERMISSION_PROBE=1 \
 *     pnpm --filter @loopzhb/daemon test src/claude-permission-probe.test.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Delivery } from "@loopzhb/protocol";

import { buildClaudeArgs, buildSandboxSettings } from "./claude-runner.js";
import { createControlRoot, releaseControlRoot } from "./control-root.js";
import { createWorkdirJail } from "./jail.js";
import { prepareRunControl, releaseRunControl } from "./run-control.js";
import { prepareClaudeRunTemp, releaseClaudeRunTemp } from "./run-temp.js";

const ENABLED = process.env.LOOPZHB_CLAUDE_PERMISSION_PROBE === "1";
const PROVIDER = fileURLToPath(new URL("../test-fixtures/mock-anthropic-provider.mjs", import.meta.url));
const CLI_TIMEOUT_MS = 90_000;

/** The two shapes that matter. The first is the one the real gate's Run 1
 *  used (and which always ran); the second is the one its Run 2 used (and
 *  which was refused four times) — a measured reason carrying `;` and `=`. */
const RECORDED = 'loopzhb report --status new --message "step 1 recorded the task file" --state \'{"step":1,"marker":"mk-a-probe"}\'';
const MEASURED = 'loopzhb finish --reason "goal met; state-marker=mk-a-probe; timeline-marker=mk-b-probe"';

const claudeBin = ENABLED ? realpathSync(spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim()) : "";

interface ProbeOutcome {
  denied: boolean;
  denialText: string;
  exitCode: number | null;
  /** The outbox records the wrapper actually wrote, parsed. */
  records: unknown[];
}

async function providerPort(logPath: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const entry = JSON.parse(line) as { ready?: boolean; port?: number };
        if (entry.ready === true && typeof entry.port === "number") return entry.port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("mock provider never reported its port");
}

/** One full production-shaped run of the CLI against the mock provider. */
async function probe(command: string, withRule: boolean): Promise<ProbeOutcome> {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-perm-probe-"));
  const root = path.join(base, "root");
  const workdir = path.join(root, "work");
  mkdirSync(workdir, { recursive: true });
  const jail = await createWorkdirJail({ allowedRoots: [root], scratchBase: path.join(base, "scratch") });
  const controlRoot = await createControlRoot(path.join(base, "control-base"));
  const resolved = await jail.resolve({ workdir, serverRoots: [], loopId: "loop-probe", runId: "run-probe" });
  const runControl = await prepareRunControl({ controlRoot, runId: "run-probe", prevState: null });
  const runTemp = await prepareClaudeRunTemp();
  const providerLog = path.join(base, "provider.jsonl");
  let provider: ReturnType<typeof spawn> | null = null;

  try {
    // The PRODUCTION profile, minus the grant for the control case.
    const built = buildSandboxSettings(
      resolved,
      {
        readOnly: [controlRoot.rootDir, runControl.contextDir, controlRoot.nodePath],
        writable: [runControl.outboxDir],
      },
      runTemp.tmpRoot,
    );
    let settings = built;
    if (!withRule) {
      const { permissions: _dropped, ...withoutRule } = built;
      settings = withoutRule;
    }

    const delivery: Delivery = {
      runId: "run-probe",
      runToken: "rk_probe_token",
      role: "exec",
      loop: { id: "loop-probe", name: "Probe", workdir, taskFile: null, workflow: null, model: null, allowControl: false },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "probe",
    };
    const argv = buildClaudeArgs(delivery, JSON.stringify(settings), "probe: perform the single requested command, then stop.");

    provider = spawn(
      process.execPath,
      [PROVIDER],
      {
        env: { PATH: process.env.PATH ?? "", PROBE_PORT: "0", PROBE_LOG: providerLog, PROBE_COMMAND: command },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    const port = await providerPort(providerLog);

    const claude = spawn(claudeBin, argv, {
      cwd: workdir,
      env: {
        PATH: [controlRoot.wrapperDir, controlRoot.nodeDir, process.env.PATH ?? ""].join(path.delimiter),
        HOME: path.join(base, "home"),
        CLAUDE_CONFIG_DIR: path.join(base, "home", ".claude"),
        CLAUDE_CODE_TMPDIR: runTemp.tmpRoot,
        TMPDIR: runTemp.tmpRoot,
        // The two journal injections the runner makes (claude-runner.ts): the
        // outbox location and the PATH prefix that puts the wrapper first.
        LOOPZHB_JOURNAL_OUTBOX: runControl.outboxDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "sk-ant-probe-not-a-real-key",
        LANG: process.env.LANG ?? "en_US.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    claude.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    claude.stderr.on("data", () => {});
    const timer = setTimeout(() => claude.kill("SIGKILL"), CLI_TIMEOUT_MS);
    const exitCode = await new Promise<number | null>((resolve) => claude.on("close", (code) => resolve(code)));
    clearTimeout(timer);

    const events = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const denials = events
      .filter((event) => event["type"] === "result")
      .flatMap((event) => (event["permission_denials"] as unknown[] | undefined) ?? []);
    const requests = existsSync(providerLog)
      ? readFileSync(providerLog, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { body?: { messages?: Array<{ content?: unknown }> } })
      : [];
    const denialText = requests
      .flatMap((request) => request.body?.messages ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block): block is { type: string; content: unknown } => (block as { type?: string }).type === "tool_result")
      .map((block) => (typeof block.content === "string" ? block.content : JSON.stringify(block.content)))
      .join("\n");

    const records = existsSync(runControl.outboxDir)
      ? readdirSync(runControl.outboxDir)
          .sort()
          .map((name) => JSON.parse(readFileSync(path.join(runControl.outboxDir, name), "utf8")) as unknown)
      : [];

    return { denied: denials.length > 0, denialText, exitCode, records };
  } finally {
    provider?.kill("SIGKILL");
    await releaseRunControl(runControl.controlDir);
    await releaseClaudeRunTemp(runTemp);
    await jail.release(resolved);
    await releaseControlRoot(controlRoot);
    rmSync(base, { recursive: true, force: true });
  }
}

describe.skipIf(!ENABLED)("Issue #57: the terminal command must not be judged by its DATA", () => {
  it(
    "the recorded report shape runs in both profiles (harness fidelity)",
    async () => {
      expect(existsSync(claudeBin)).toBe(true); // the probe needs a real CLI
      const withoutRule = await probe(RECORDED, false);
      expect(withoutRule.denied).toBe(false);
      expect(withoutRule.records).toEqual([
        { kind: "report", status: "new", message: "step 1 recorded the task file", state: { step: 1, marker: "mk-a-probe" } },
      ]);
    },
    CLI_TIMEOUT_MS + 30_000,
  );

  it(
    "a `;`+`=`-bearing reason is REFUSED without the grant, and RUNS with it",
    async () => {
      // Anti-vacuity: the same command, the same profile, one key apart.
      const withoutRule = await probe(MEASURED, false);
      expect(withoutRule.denied).toBe(true);
      expect(withoutRule.denialText).toContain("don't ask mode");
      expect(withoutRule.records).toEqual([]); // refused ⇒ nothing reached the outbox

      const withRule = await probe(MEASURED, true);
      expect(withRule.denied).toBe(false);
      expect(withRule.records).toEqual([
        { kind: "finish", reason: "goal met; state-marker=mk-a-probe; timeline-marker=mk-b-probe" },
      ]);
    },
    (CLI_TIMEOUT_MS + 30_000) * 2,
  );
});
