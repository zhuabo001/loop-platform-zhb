/**
 * The `loopzhb` terminal-command wrapper (Phase 4 Batch 2, plan §2.1,
 * ADR-009 修订 8/9): the ONLY local channel through which an agent run
 * produces its terminal command. The agent's PATH points at a static,
 * read-only executable that re-enters THIS module; the daemon collects the
 * resulting record from the run's outbox after Claude exits.
 *
 * Wire grammar (strict — anything else is an invalid invocation):
 *
 *   loopzhb report --status <new|resolved|nothing-new>
 *     [--message <text> | --message-file <path>]
 *     [--state <json> | --state-file <path>]
 *
 *   loopzhb finish --reason <text>
 *     [--message <text> | --message-file <path>]
 *     [--state <json> | --state-file <path>]
 *
 * Contract:
 *  - unknown/duplicated/positional/mutually-exclusive/missing-required
 *    arguments, unreadable or oversized *-file inputs, invalid JSON, a
 *    non-object state, or a policy violation (NUL, unpaired surrogate, over
 *    the protocol byte ceilings) ALL fail the invocation;
 *  - every invocation writes EXACTLY ONE record into $LOOPZHB_JOURNAL_OUTBOX
 *    with a random name via open(wx, 0600) — a valid invocation writes the
 *    terminal command, an invalid one writes a stable `{kind:"invalid"}`
 *    marker carrying NO user-supplied value;
 *  - the wrapper itself holds NO secret: it derives redaction needles from
 *    the provider/proxy environment it inherits (ANTHROPIC_*,
 *    CLAUDE_CODE_OAUTH_TOKEN, proxy variables) and redacts message/reason
 *    BEFORE the record lands on disk; a state whose any key/value contains
 *    a known secret is never silently rewritten — the invocation fails and
 *    the secret-free marker is written instead (plan §2.6);
 *  - exit codes: 0 success, 1 invalid invocation (marker written),
 *    2 infrastructure failure (missing outbox / record write failed).
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES,
  TERMINAL_TEXT_MAX_UTF8_BYTES,
  validateFinishReason,
  validateTerminalMessage,
  validateTerminalState,
} from "@loopzhb/protocol";

import { collectSecretValues, redactSecrets } from "./agent-env.js";
import { readRegularFileNoFollow } from "./bounded-read.js";
import { stateContainsSecret } from "./secret-scan.js";

export const JOURNAL_OUTBOX_ENV = "LOOPZHB_JOURNAL_OUTBOX";

/** Write the invocation's ONE record: random name, create-exclusive, 0600. */
async function writeRecord(outboxDir: string, record: unknown): Promise<void> {
  const file = path.join(outboxDir, `${randomBytes(12).toString("hex")}.json`);
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600); // defend the mode beyond open(2)'s umask masking
}

/** A *-file argument (plan §2.1: "只接受普通可读文件"): resolved against the
 *  agent's cwd, then read with the SHARED no-follow bounded read
 *  (bounded-read.ts, review SPEC-4) — a symlink (even one pointing at a
 *  perfectly legal file), a non-regular entry, an over-ceiling file or any
 *  IO failure ALL reject the whole invocation (null) — never a partial
 *  read. */
async function readArgumentFile(cwd: string, file: string, maxBytes: number): Promise<string | null> {
  const resolved = path.resolve(cwd, file);
  const read = await readRegularFileNoFollow(resolved, maxBytes);
  if (read.kind !== "ok") return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch {
    return null;
  }
}

interface ParsedArgs {
  status?: string;
  reason?: string;
  message?: string;
  messageFile?: string;
  state?: string;
  stateFile?: string;
}

/** Strict flag parsing: every token must be a known `--flag` followed by a
 *  value; duplicates, positionals, unknown flags, mutually-exclusive pairs
 *  and missing values all reject. */
function parseArgs(argv: string[], command: "report" | "finish"): ParsedArgs | null {
  const allowed: ReadonlySet<string> =
    command === "report"
      ? new Set(["--status", "--message", "--message-file", "--state", "--state-file"])
      : new Set(["--reason", "--message", "--message-file", "--state", "--state-file"]);
  const FLAG_KEYS: Record<string, keyof ParsedArgs> = {
    "--status": "status",
    "--reason": "reason",
    "--message": "message",
    "--message-file": "messageFile",
    "--state": "state",
    "--state-file": "stateFile",
  };
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!allowed.has(token)) return null; // unknown flag or positional
    const key = FLAG_KEYS[token]!;
    if (out[key] !== undefined) return null; // duplicated flag
    const value = argv[++i];
    if (value === undefined) return null; // missing value
    out[key] = value;
  }
  if (out.message !== undefined && out.messageFile !== undefined) return null;
  if (out.state !== undefined && out.stateFile !== undefined) return null;
  return out;
}

/**
 * Run one wrapper invocation. Pure with respect to the daemon process: all
 * I/O goes through the inherited env/cwd and the outbox directory, so the
 * same function backs the spawned static executable AND direct unit tests.
 */
export async function runLoopzhbWrapper(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const outbox = env[JOURNAL_OUTBOX_ENV];
  if (outbox === undefined || outbox === "" || !path.isAbsolute(outbox)) return 2;
  const invalid = async (): Promise<number> => {
    try {
      await writeRecord(outbox, { kind: "invalid" });
      return 1;
    } catch {
      return 2;
    }
  };

  const [command, ...rest] = argv;
  if (command !== "report" && command !== "finish") return invalid();
  const args = parseArgs(rest, command);
  if (args === null) return invalid();

  // Needles come from the SHARED classifier (review STD-3): the env the
  // wrapper inherits IS the agent env, so these are the only credentials it
  // can know.
  const needles = collectSecretValues(env);
  const record: Record<string, unknown> = { kind: command };

  if (command === "report") {
    if (args.status === undefined || !["new", "resolved", "nothing-new"].includes(args.status)) return invalid();
    record.status = args.status;
  } else {
    if (args.reason === undefined) return invalid();
    const reason = validateFinishReason(args.reason);
    if (!reason.ok) return invalid();
    record.reason = redactSecrets(args.reason, needles);
  }

  let message: string | undefined = args.message;
  if (args.messageFile !== undefined) {
    const content = await readArgumentFile(cwd, args.messageFile, TERMINAL_TEXT_MAX_UTF8_BYTES);
    if (content === null) return invalid();
    message = content;
  }
  // new/resolved REQUIRE a message; nothing-new may omit it (the protocol's
  // terminal-command refinement, duplicated here so the failure is local).
  if (command === "report" && args.status !== "nothing-new" && message === undefined) return invalid();
  if (message !== undefined) {
    if (!validateTerminalMessage(message).ok) return invalid();
    record.message = redactSecrets(message, needles);
  }

  let stateRaw: string | undefined = args.state;
  if (args.stateFile !== undefined) {
    const content = await readArgumentFile(cwd, args.stateFile, TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES);
    if (content === null) return invalid();
    stateRaw = content;
  }
  if (stateRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stateRaw);
    } catch {
      return invalid();
    }
    const state = validateTerminalState(parsed);
    if (!state.ok) return invalid();
    if (stateContainsSecret(state.state, needles)) return invalid();
    record.state = state.state;
  }

  try {
    await writeRecord(outbox, record);
    return 0;
  } catch {
    return 2;
  }
}
