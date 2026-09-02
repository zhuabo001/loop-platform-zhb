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
 *   split-progress-secret  base64 credential split across two progress events
 *   error-result     is_error terminal (text embeds the key), exit 1
 *   big-error        is_error terminal with a 10KB result text (error cap pin)
 *   exit3            no output at all, exit code 3
 *   garbage          non-JSON stdout, exit 0
 *   no-result        init + text, clean exit 0, NO terminal result
 *   hang             write the sidecar, then hang forever (timeout/abort pins)
 *   self-swap-scratch replace our OWN cwd with a symlink mid-run (release
 *                    fail-closed pin — the post-run release must refuse it)
 *   session-conflict init session_id ≠ result session_id (identity pin)
 *   secret-session   success result whose session_id embeds $ANTHROPIC_API_KEY
 *   probe            handled by the probe pins: `--version` / `--help` output
 *
 * Phase 4 Batch 2 (terminal-protocol v1): a `-p` value NOT starting with
 * `fake-claude://` is the daemon-built v1 prompt. The fixture then reads its
 * scenario from `<cwd>/.fake-claude-v1-scenario` (default: `journal-none`),
 * records the full prompt in the sidecar, and — per scenario — writes a
 * journal record directly into $LOOPZHB_JOURNAL_OUTBOX (simulating the Bash
 * child invoking the wrapper):
 *   journal-none        no record; success result (→ journal_missing)
 *   report-resolved     {"kind":"report","status":"resolved","message":"done"} + success
 *   report-with-state   report/resolved + {"cursor":2} state + success
 *   finish              {"kind":"finish","reason":"goal met"} + success
 *   journal-two         two valid records + success (→ journal_multiple)
 *   journal-symlink     a symlink entry in the outbox + success (→ journal_multiple)
 *   journal-corrupt     one non-JSON record + success (→ journal_corrupt)
 *   journal-invalid     {"kind":"invalid"} marker + success (→ journal_invalid)
 *   journal-policy      report/new WITHOUT message + success (→ journal_invalid)
 *   report-secret-text  report message embeds $ANTHROPIC_API_KEY (redaction pin)
 *   journal-then-exit1  valid record, is_error terminal, exit 1 (claude failure wins)
 *   report-delete-task  valid record, then <cwd>/TASK.md is deleted (sync → missing)
 *   finish-observe-prev-state  reads the run's prev-state.json (derived as the
 *                    sibling of $LOOPZHB_JOURNAL_OUTBOX) and embeds its raw
 *                    content in the finish reason — the cross-run state
 *                    promotion pin of the Batch-2 E2E
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const isV1 = !task.startsWith(PREFIX);
let scenario = isV1 ? "journal-none" : task.slice(PREFIX.length);
if (isV1) {
  const scenarioFile = path.join(process.cwd(), ".fake-claude-v1-scenario");
  if (existsSync(scenarioFile)) scenario = readFileSync(scenarioFile, "utf8").trim();
}

writeFileSync(
  path.join(process.cwd(), ".fake-claude-session.json"),
  JSON.stringify({
    argv,
    prompt: task,
    env: {
      PATH: process.env.PATH ?? null,
      HOME: process.env.HOME ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      LOOPZHB_MACHINE_CREDENTIAL: process.env.LOOPZHB_MACHINE_CREDENTIAL ?? null,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
      LOOPZHB_JOURNAL_OUTBOX: process.env.LOOPZHB_JOURNAL_OUTBOX ?? null,
    },
  }),
);

const line = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const key = process.env.ANTHROPIC_API_KEY ?? "none";

/** Write one journal record the way the wrapper would: random name, JSON. */
const writeJournal = (record) => {
  const outbox = process.env.LOOPZHB_JOURNAL_OUTBOX;
  if (!outbox) throw new Error("v1 scenario without LOOPZHB_JOURNAL_OUTBOX");
  writeFileSync(path.join(outbox, `${randomBytes(12).toString("hex")}.json`), JSON.stringify(record), { mode: 0o600 });
};

const successResult = (overrides = {}) =>
  line({ type: "result", subtype: "success", is_error: false, result: "fake final text", session_id: "fake-sess-1", ...overrides });

if (isV1) {
  switch (scenario) {
    case "journal-none":
      successResult();
      break;
    case "report-resolved":
      writeJournal({ kind: "report", status: "resolved", message: "done" });
      successResult();
      break;
    case "report-with-state":
      writeJournal({ kind: "report", status: "resolved", message: "done", state: { cursor: 2 } });
      successResult();
      break;
    case "finish":
      writeJournal({ kind: "finish", reason: "goal met" });
      successResult();
      break;
    case "journal-two":
      writeJournal({ kind: "report", status: "resolved", message: "one" });
      writeJournal({ kind: "report", status: "resolved", message: "two" });
      successResult();
      break;
    case "journal-symlink": {
      const outbox = process.env.LOOPZHB_JOURNAL_OUTBOX;
      symlinkSync(path.join(outbox, "target.json"), path.join(outbox, "link.json"));
      successResult();
      break;
    }
    case "journal-corrupt": {
      const outbox = process.env.LOOPZHB_JOURNAL_OUTBOX;
      writeFileSync(path.join(outbox, `${randomBytes(12).toString("hex")}.json`), "this is not json{", { mode: 0o600 });
      successResult();
      break;
    }
    case "journal-invalid":
      writeJournal({ kind: "invalid" });
      successResult();
      break;
    case "journal-policy":
      writeJournal({ kind: "report", status: "new" }); // new without message
      successResult();
      break;
    case "report-secret-text":
      writeJournal({ kind: "report", status: "resolved", message: `token is ${key}` });
      successResult();
      break;
    case "journal-then-exit1":
      writeJournal({ kind: "report", status: "resolved", message: "done" });
      line({ type: "result", subtype: "error_during_execution", is_error: true, result: "blew up" });
      process.exitCode = 1;
      break;
    case "report-delete-task":
      // The sync-failure-never-rolls-back pin: a legal journal record, but
      // the task file (conventionally <cwd>/TASK.md in the runner tests) is
      // gone by the time the daemon re-reads it.
      writeJournal({ kind: "report", status: "resolved", message: "done" });
      rmSync(path.join(process.cwd(), "TASK.md"), { force: true });
      successResult();
      break;
    case "finish-observe-prev-state": {
      // The cross-run state pin: the run control dir holds context/ and
      // outbox/ as siblings, so the prev-state path derives from the ONE
      // journal env var. The observed content rides the finish reason —
      // black-box observable on the server's run message.
      const outbox = process.env.LOOPZHB_JOURNAL_OUTBOX;
      const prevStatePath = path.join(path.dirname(outbox), "context", "prev-state.json");
      let observed;
      try {
        observed = readFileSync(prevStatePath, "utf8");
      } catch {
        observed = "<unreadable>";
      }
      writeJournal({ kind: "finish", reason: `goal met; observed prev-state ${observed}` });
      successResult();
      break;
    }
    default:
      process.stderr.write(`unknown v1 scenario: ${scenario}\n`);
      process.exitCode = 64;
  }
  process.exit();
}

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
  case "split-progress-secret": {
    const encoded = Buffer.from(key, "utf8").toString("base64");
    const cut = Math.floor(encoded.length / 2);
    line({ type: "assistant", message: { content: [{ type: "text", text: encoded.slice(0, cut) }] } });
    line({ type: "assistant", message: { content: [{ type: "text", text: encoded.slice(cut) }] } });
    line({ type: "result", subtype: "success", is_error: false, result: "done" });
    break;
  }
  case "api-retry":
    line({ type: "system", subtype: "api_retry", attempt: 999999, delay_ms: 123456 });
    line({ type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } });
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] } });
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
  case "session-conflict":
    // init and result disagree on the session identity — the parser must
    // refuse the stream (a Report must never point at the wrong transcript).
    line({ type: "system", subtype: "init", session_id: "fake-sess-init" });
    line({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "fake-sess-result" });
    break;
  case "secret-session":
    line({ type: "result", subtype: "success", is_error: false, result: "done", session_id: `sess-${key}` });
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
