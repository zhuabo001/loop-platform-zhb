/**
 * The journal collector (Phase 4 Batch 2, plan §2.1, ADR-009 修订 8/9):
 * after a successful Claude exit the daemon reads the run's outbox and
 * demands EXACTLY ONE regular-file record — the agent's terminal command.
 *
 * Stable, content-free failure classification (surfaced as the run's error
 * text, never entering the wire schema):
 *  - journal_missing   zero records;
 *  - journal_multiple  more than one record, ANY non-regular entry (a
 *                      symlink included — it could point anywhere), an
 *                      entry swapped between listing and read, or an outbox
 *                      holding beyond JOURNAL_OUTBOX_MAX_ENTRIES entries;
 *  - journal_too_large the single record exceeds JOURNAL_RECORD_MAX_BYTES
 *                      (the read is bounded — a huge or sparse agent-written
 *                      record must never be allocated whole, review ADV-4);
 *  - journal_corrupt   the record is not parseable JSON or not an object;
 *  - journal_invalid   an invalid marker (the wrapper rejected the
 *                      invocation) or a well-formed record that violates
 *                      the protocol's terminal-command shape/policy;
 *  - journal_io        the outbox or record could not be read.
 *
 * Accepted commands pass the SAME terminal policy the server re-executes
 * (single source: @loopzhb/protocol); message/reason are redacted with the
 * daemon's full secret list before they enter the report, and a state whose
 * ANY key/value contains a known secret fails closed as journal_invalid
 * (never silently rewritten) — the second layer of the journal's secret
 * boundary (the wrapper's env-derived redaction is the first). The second
 * layer cannot be skipped: the agent holds write access to its outbox and
 * can place a record there without ever invoking the wrapper (review
 * ADV-1), so the collector re-runs the shared state scan (secret-scan.ts)
 * itself.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES,
  terminalCommandSchema,
  validateFinishReason,
  validateTerminalMessage,
  validateTerminalState,
  type TerminalCommand,
} from "@loopzhb/protocol";

import { redactSecrets } from "./agent-env.js";
import { readRegularFileNoFollow } from "./bounded-read.js";
import { stateContainsSecret } from "./secret-scan.js";

export const JOURNAL_MISSING = "journal_missing";
export const JOURNAL_MULTIPLE = "journal_multiple";
export const JOURNAL_TOO_LARGE = "journal_too_large";
export const JOURNAL_CORRUPT = "journal_corrupt";
export const JOURNAL_INVALID = "journal_invalid";
export const JOURNAL_IO = "journal_io";

/** Record byte ceiling (review ADV-4): the wrapper — the only legitimate
 *  writer — can produce at most a 64 KiB compact state plus message/reason
 *  of 2000 UTF-8 bytes each (≤ 6× JSON-escaped ≈ 24 KB) plus a <200 B
 *  envelope, ≈ 90 KB. Twice the state ceiling leaves ample headroom while
 *  bounding the daemon's allocation. Follows the protocol constant. */
export const JOURNAL_RECORD_MAX_BYTES = 2 * TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES;

/** A legitimate outbox holds EXACTLY ONE record; 16 is the generous cap.
 * Streaming enumeration stops when the 17th entry is observed. */
export const JOURNAL_OUTBOX_MAX_ENTRIES = 16;

export type JournalResult = { kind: "ok"; command: TerminalCommand } | { kind: "error"; error: string };

function invalid(detail: string): JournalResult {
  return { kind: "error", error: `${JOURNAL_INVALID}: ${detail}` };
}

export async function collectJournal(
  outboxDir: string,
  secretValues: readonly string[],
  io?: { open?: typeof fs.open; onOutboxEntryRead?(): void }, // TEST-ONLY seams
): Promise<JournalResult> {
  // Second redaction layer (ADR-009 修订 8): the daemon's full secret list,
  // beyond the wrapper's env-derived needles.
  const redact = (text: string): string => redactSecrets(text, [...secretValues]);
  const names: string[] = [];
  let dir: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {
    dir = await fs.opendir(outboxDir);
    for (;;) {
      const entry = await dir.read();
      if (entry === null) break;
      io?.onOutboxEntryRead?.();
      names.push(entry.name);
      if (names.length > JOURNAL_OUTBOX_MAX_ENTRIES) {
        return { kind: "error", error: JOURNAL_MULTIPLE };
      }
    }
  } catch {
    return { kind: "error", error: `${JOURNAL_IO}: outbox unreadable` };
  } finally {
    if (dir !== undefined) await dir.close().catch(() => {});
  }
  const records: Array<{ file: string; dev: number; ino: number }> = [];
  for (const name of names) {
    const file = path.join(outboxDir, name);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch {
      return { kind: "error", error: `${JOURNAL_IO}: outbox entry vanished` };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { kind: "error", error: `${JOURNAL_MULTIPLE}: outbox holds a non-record entry` };
    }
    records.push({ file, dev: stat.dev, ino: stat.ino });
  }
  if (records.length === 0) return { kind: "error", error: JOURNAL_MISSING };
  if (records.length > 1) return { kind: "error", error: JOURNAL_MULTIPLE };

  // Bounded no-follow read (review ADV-4): O_NOFOLLOW against a swapped
  // terminal symlink, fstat-guarded regular file + size ceiling, and a
  // fixed-size buffer — never a whole-file allocation.
  const record = records[0]!;
  const read = await readRegularFileNoFollow(record.file, JOURNAL_RECORD_MAX_BYTES, io?.open);
  if (read.kind === "too_large") return { kind: "error", error: JOURNAL_TOO_LARGE };
  if (read.kind === "symlink" || read.kind === "not_regular") {
    return { kind: "error", error: `${JOURNAL_MULTIPLE}: outbox holds a non-record entry` };
  }
  if (read.kind === "not_found") return { kind: "error", error: `${JOURNAL_IO}: outbox entry vanished` };
  if (read.kind === "unreadable") return { kind: "error", error: `${JOURNAL_IO}: record unreadable` };
  if (read.dev !== record.dev || read.ino !== record.ino) {
    return { kind: "error", error: `${JOURNAL_MULTIPLE}: outbox holds a non-record entry` };
  }
  const raw = read.bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "error", error: JOURNAL_CORRUPT };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "error", error: JOURNAL_CORRUPT };
  }
  if ((parsed as { kind?: unknown }).kind === "invalid") {
    return invalid("the wrapper rejected the terminal invocation");
  }
  const shape = terminalCommandSchema.safeParse(parsed);
  if (!shape.success) return invalid("malformed terminal command");
  const command = shape.data;

  // The value policy the server re-executes — a record the daemon accepts
  // here must never bounce off the server's defensive layer.
  if (command.kind === "report") {
    if (command.message !== undefined && !validateTerminalMessage(command.message).ok) {
      return invalid("message violates the terminal policy");
    }
  } else {
    if (!validateFinishReason(command.reason).ok) return invalid("reason violates the terminal policy");
    if (command.message !== undefined && !validateTerminalMessage(command.message).ok) {
      return invalid("message violates the terminal policy");
    }
  }
  if (command.state !== undefined) {
    const state = validateTerminalState(command.state);
    if (!state.ok) return invalid(`state violates the terminal policy (${state.failure})`);
    command.state = state.state; // persist the canonical clone, not the parsed original
    // Fail closed (review ADV-1): a state embedding a known secret is
    // rejected, never redacted-and-persisted — a silent rewrite would invent
    // state the agent never reported.
    if (stateContainsSecret(command.state, secretValues)) return invalid("state contains a known secret");
  }

  if (command.kind === "report") {
    if (command.message !== undefined) command.message = redact(command.message);
  } else {
    command.reason = redact(command.reason);
    if (command.message !== undefined) command.message = redact(command.message);
  }
  return { kind: "ok", command };
}
