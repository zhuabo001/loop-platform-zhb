/**
 * Argument grammar for `claim:legacy` (ADR-011 决策 22). Pure: no I/O, no env,
 * no clock — the whole surface is unit-testable without a data dir.
 *
 * House style is the daemon's hand-rolled strict parser (`wrapper-main.ts`):
 * every token is a known flag in a known slot; unknown flags, positionals,
 * duplicates and missing values all reject. One difference is deliberate — a
 * value that LOOKS like a flag is refused (see `parseClaimArgs`), because this
 * grammar mixes value flags with a bare boolean and `--data-dir --dry-run`
 * must not silently become a real run against a directory named "--dry-run".
 */
import path from "node:path";

import { GITHUB_USER_ID_RE } from "../db/schema.js";

/** The program name as the operator types it. */
export const CLAIM_COMMAND = "claim:legacy";

export interface ParsedClaimArgs {
  /** Absolute, resolved against the invocation cwd. */
  dataDir: string;
  githubUserId: string;
  /** Repeatable, order-preserving, duplicate-free. */
  machineIds: string[];
  dryRun: boolean;
}

export type ParseClaimArgsResult =
  | { ok: true; args: ParsedClaimArgs }
  /** An explicit `--help` probe: print USAGE, exit 0, touch nothing. */
  | { ok: false; failure: "help" }
  | { ok: false; failure: "usage_invalid"; message: string };

const VALUE_FLAGS = ["--data-dir", "--github-user-id", "--machine-id"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const HELP_TOKENS: ReadonlySet<string> = new Set(["help", "--help", "-h", "--version"]);

export const USAGE = `Usage: pnpm --filter @loopzhb/server ${CLAIM_COMMAND} -- --data-dir <dir> --github-user-id <id> --machine-id <id> [--machine-id <id> ...] [--dry-run]

Claim legacy (unclaimed) machines and their Artifact history for the personal
team of an existing GitHub account. This is an OFFLINE operation.

  --data-dir <dir>       Server data directory (required, no env fallback).
  --github-user-id <id>  GitHub numeric user id of the ALREADY LOGGED IN target
                         account (required). The command never creates accounts.
  --machine-id <id>      Machine to claim. Repeat for several machines. At least
                         one is required; the selection is explicit — there is
                         no "claim everything" default.
  --dry-run              Report what would change and exit without copying
                         blobs or writing any business data.
  --help, -h             Print this text and exit.

The Server and the Daemon must be STOPPED first. This command and the Server
share an exclusive lock on the data directory (<dir>/data-dir.lock), taken
before the database is opened. The lock is never taken over automatically: if
the holder crashed, confirm that no process is using the data directory and
then remove the lock file:
  rm <dir>/data-dir.lock

Exit codes:
  0  done (claimed, dry-run report, or an idempotent no-op)
  1  refused or failed (unknown target, wrong machine, active run, inconsistent
     history, blob verification failure, transaction rollback)
  2  invalid invocation
  3  the data directory is locked by another process

Claiming rewrites the Artifact namespace of the selected machines. An
application-only rollback is NOT enough to undo it — restore the complete
pre-upgrade data directory backup.
`;

/** Positional help scan (Issue #58 reasoning): a help token only counts in a
 *  FLAG slot, never in a value slot, so a path or id that happens to be
 *  "--help" stays data. A help token in flag position cannot belong to any
 *  valid invocation. */
function isHelpInvocation(argv: readonly string[]): boolean {
  let inValueSlot = false;
  for (const token of argv) {
    if (inValueSlot) {
      inValueSlot = false;
      continue;
    }
    if (HELP_TOKENS.has(token)) return true;
    if ((VALUE_FLAGS as readonly string[]).includes(token)) inValueSlot = true;
  }
  return false;
}

export function parseClaimArgs(argv: readonly string[], cwd: string): ParseClaimArgsResult {
  // A single leading "--" is the separator pnpm documents in the usage line;
  // a shell that already consumed it just passes it straight through.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;

  if (isHelpInvocation(tokens)) return { ok: false, failure: "help" };

  let dataDir: string | undefined;
  let githubUserId: string | undefined;
  const machineIds: string[] = [];
  const seenMachineIds = new Set<string>();
  let dryRun = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token === "--dry-run") {
      if (dryRun) return invalid("--dry-run may only be given once");
      dryRun = true;
      continue;
    }

    if (!(VALUE_FLAGS as readonly string[]).includes(token)) {
      return invalid(`unknown flag or positional argument: ${JSON.stringify(token)}`);
    }
    const flag = token as ValueFlag;

    const value = tokens[i + 1];
    if (value === undefined) return invalid(`${flag} requires a value`);
    // Refuse anything flag-shaped: in this grammar a bare boolean follows value
    // flags, so `--data-dir --dry-run` is a typo, not a directory name.
    if (value === "" || value.startsWith("--")) return invalid(`${flag} requires a value`);
    i += 1;

    switch (flag) {
      case "--data-dir":
        if (dataDir !== undefined) return invalid("--data-dir may only be given once");
        dataDir = path.resolve(cwd, value);
        break;
      case "--github-user-id":
        if (githubUserId !== undefined) return invalid("--github-user-id may only be given once");
        if (!GITHUB_USER_ID_RE.test(value)) {
          return invalid(`--github-user-id must be a decimal GitHub user id, got ${JSON.stringify(value)}`);
        }
        githubUserId = value;
        break;
      case "--machine-id":
        // A repeated VALUE is almost always a copy-paste slip; silently
        // de-duplicating would hide it (the same machine appears once anyway).
        if (seenMachineIds.has(value)) return invalid(`--machine-id repeated: ${JSON.stringify(value)}`);
        seenMachineIds.add(value);
        machineIds.push(value);
        break;
    }
  }

  if (dataDir === undefined) return invalid("--data-dir is required");
  if (githubUserId === undefined) return invalid("--github-user-id is required");
  if (machineIds.length === 0) return invalid("--machine-id is required at least once");

  return { ok: true, args: { dataDir, githubUserId, machineIds, dryRun } };
}

function invalid(message: string): ParseClaimArgsResult {
  return { ok: false, failure: "usage_invalid", message };
}
