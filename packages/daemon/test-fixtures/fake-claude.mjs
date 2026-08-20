#!/usr/bin/env node
/**
 * Fake Claude Code CLI fixture for the batch-3 adapter pins (A group) and the
 * startup-probe pins. Spawned DIRECTLY as the claude binary (shebang + exec
 * bit) because the adapter's argv shape is fixed — the only caller-controlled
 * input is the `-p <task>` value, so the task doubles as the scenario
 * selector: `fake-claude://<scenario>`.
 *
 * EVERY invocation first writes a `.fake-claude-session.json` sidecar into
 * its cwd recording { argv, env:{…} } — the tests assert the exact argv, the
 * dynamic settings JSON and the env whitelist from that file. (For scratch
 * runs the sidecar dies with the scratch dir; argv assertions use a workdir
 * run instead.)
 *
 * Scenarios:
 *   ok               init + text + tool_use + success result with full usage
 *   echo-secret      success result embedding $ANTHROPIC_API_KEY (redaction pin)
 *   progress-secret  an assistant text block embedding $ANTHROPIC_API_KEY
 *   error-result     is_error terminal (text embeds the key), exit 1
 *   big-error        is_error terminal with a 10KB result text (error cap pin)
 *   exit3            no output at all, exit code 3
 *   garbage          non-JSON stdout, exit 0
 *   no-result        init + text, clean exit 0, NO terminal result
 *   hang             write the sidecar, then hang forever (timeout/abort pins)
 *   self-swap-scratch replace our OWN cwd with a symlink mid-run (release
 *                    fail-closed pin — the post-run release must refuse it)
 *   probe            handled by the probe pins: `--version` / `--help` output
 */
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

// The probe paths short-circuit before any scenario handling.
if (argv.includes("--version")) {
  process.stdout.write("2.1.227 (Claude Code)\n");
  process.exit(0);
}
if (argv.includes("--help")) {
  process.stdout.write(
    [
      "fake claude help",
      "--output-format <format>",
      "--verbose",
      "--safe-mode",
      "--setting-sources <sources>",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--tools <tools...>",
      "--permission-mode <mode>",
      "--prompt-suggestions [value]",
      "--settings <file-or-json>",
      "--model <model>",
      "--append-system-prompt <prompt>",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const taskIdx = argv.indexOf("-p");
const task = taskIdx >= 0 ? (argv[taskIdx + 1] ?? "") : "";
const PREFIX = "fake-claude://";
const scenario = task.startsWith(PREFIX) ? task.slice(PREFIX.length) : "ok";

writeFileSync(
  path.join(process.cwd(), ".fake-claude-session.json"),
  JSON.stringify({
    argv,
    env: {
      PATH: process.env.PATH ?? null,
      HOME: process.env.HOME ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      LOOPZHB_MACHINE_CREDENTIAL: process.env.LOOPZHB_MACHINE_CREDENTIAL ?? null,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    },
  }),
);

const line = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const key = process.env.ANTHROPIC_API_KEY ?? "none";

switch (scenario) {
  case "ok":
    line({ type: "system", subtype: "init", session_id: "fake-sess-1", tools: ["Bash"] });
    line({ type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } });
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] } });
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake final text",
      session_id: "fake-sess-1",
      total_cost_usd: 0.0042,
      usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 },
      num_turns: 1,
      duration_ms: 5,
    });
    break;
  case "echo-secret":
    line({ type: "result", subtype: "success", is_error: false, result: `token is ${key}`, session_id: "fake-sess-1" });
    break;
  case "progress-secret":
    line({ type: "assistant", message: { content: [{ type: "text", text: `using ${key}` }] } });
    line({ type: "result", subtype: "success", is_error: false, result: "done" });
    break;
  case "error-result":
    line({ type: "system", subtype: "init", session_id: "fake-sess-1" });
    line({ type: "result", subtype: "error_during_execution", is_error: true, result: `blew up with ${key}` });
    process.exitCode = 1;
    break;
  case "big-error":
    line({ type: "result", subtype: "error_during_execution", is_error: true, result: `E${"x".repeat(10_000)}` });
    process.exitCode = 1;
    break;
  case "exit3":
    process.exitCode = 3;
    break;
  case "garbage":
    process.stdout.write("this is not json at all\n");
    break;
  case "no-result":
    line({ type: "system", subtype: "init", session_id: "fake-sess-1" });
    line({ type: "assistant", message: { content: [{ type: "text", text: "quiet" }] } });
    break;
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "self-swap-scratch": {
    // The run SUCCEEDS, but our cwd (the per-run scratch dir) is now a
    // symlink — the adapter's finally-release must refuse it and fail the run.
    const cwd = process.cwd();
    line({ type: "result", subtype: "success", is_error: false, result: "swapped", session_id: "fake-sess-1" });
    rmSync(cwd, { recursive: true, force: true });
    symlinkSync("/", cwd, "dir");
    break;
  }
  default:
    process.stderr.write(`unknown scenario: ${scenario}\n`);
    process.exitCode = 64;
}
