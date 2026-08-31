/**
 * Terminal policy — the Phase 4 VALUE rules daemon and server must execute
 * identically (ADR-009; ADR-002 决策 4 的窄例外).
 *
 * Why this module exists: a terminal command is validated TWICE — by the
 * daemon's local Journal (stable failure classification before the network is
 * involved) and again by the server as a defensive layer (it never trusts the
 * daemon). Two copies would drift, so the single source lives here in the
 * protocol package. Ordinary server-side clipping policy still does NOT enter
 * the protocol schema; this module is the recorded exception.
 *
 * Pure functions only: no I/O, no clock, no node builtins (TextEncoder is a
 * Web standard global, available in browsers and modern node alike).
 */
import { isStrictJsonValue, type JsonObject } from "./json.js";
import type { TaskFileSyncError } from "./report.js";

// ---- shared byte measurement ----

const encoder = new TextEncoder();

/** Exact UTF-8 byte length. Fast path: a string longer than `maxBytes` in
 *  UTF-16 code units is always over (UTF-8 never shrinks). */
function utf8BytesExceed(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true;
  return encoder.encode(value).length > maxBytes;
}

// ---- PostgreSQL writability (review A-2) ----

/** True when `value` contains an unpaired UTF-16 surrogate (lone high or low). */
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1); // NaN past the end — fails the pair test
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Can PostgreSQL store this string VERBATIM, as text or inside jsonb? PG text
 * rejects NUL (`0x00` is invalid UTF-8 there); jsonb additionally rejects
 * unpaired UTF-16 surrogates, and drivers silently mangle lone surrogates in
 * text into U+FFFD. The policy's legal domain must never exceed the writable
 * domain (review A-2): a policy-accepted value must round-trip bit-for-bit,
 * so a v1 write-plan can never fail at the database step.
 */
export function isPgRepresentableText(value: string): boolean {
  return !value.includes("\0") && !hasUnpairedSurrogate(value);
}

// ---- goal (ADR-009 决策 2) ----

export const GOAL_MAX_UTF8_BYTES = 2000;

export type GoalValidationFailure = "empty" | "contains_nul" | "not_single_line" | "malformed_unicode" | "too_long";

export type GoalValidation = { ok: true; goal: string } | { ok: false; failure: GoalValidationFailure };

/**
 * Normalize and validate a goal string: JavaScript `trim()`, then reject when
 * empty, containing NUL/CR/LF, containing an unpaired UTF-16 surrogate (not
 * storable verbatim — review A-2), or over 2000 UTF-8 bytes. The NORMALIZED
 * value is what gets persisted and compared — equal-after-trim updates are
 * no-ops. `null` (Open Loop) is handled by the domain layer, not here.
 */
export function normalizeGoal(raw: string): GoalValidation {
  const goal = raw.trim();
  if (goal === "") return { ok: false, failure: "empty" };
  if (goal.includes("\0")) return { ok: false, failure: "contains_nul" };
  if (goal.includes("\r") || goal.includes("\n")) return { ok: false, failure: "not_single_line" };
  if (hasUnpairedSurrogate(goal)) return { ok: false, failure: "malformed_unicode" };
  if (utf8BytesExceed(goal, GOAL_MAX_UTF8_BYTES)) return { ok: false, failure: "too_long" };
  return { ok: true, goal };
}

// ---- terminal message / finish reason (ADR-009 决策 6 的文本规则) ----

export const TERMINAL_TEXT_MAX_UTF8_BYTES = 2000;

export type TerminalTextFailure = "empty" | "contains_nul" | "malformed_unicode" | "too_long";

export type TerminalTextValidation = { ok: true } | { ok: false; failure: TerminalTextFailure };

/**
 * message/reason keep their original text and newlines — NO trim, NO
 * single-line rule (unlike goal). Only NUL, unpaired UTF-16 surrogates (not
 * PG-representable — review A-2) and the 2000 UTF-8 byte ceiling reject. The
 * finish reason must additionally be non-empty.
 */
function validateTerminalText(raw: string, requireNonEmpty: boolean): TerminalTextValidation {
  if (requireNonEmpty && raw === "") return { ok: false, failure: "empty" };
  if (raw.includes("\0")) return { ok: false, failure: "contains_nul" };
  if (hasUnpairedSurrogate(raw)) return { ok: false, failure: "malformed_unicode" };
  if (utf8BytesExceed(raw, TERMINAL_TEXT_MAX_UTF8_BYTES)) return { ok: false, failure: "too_long" };
  return { ok: true };
}

export function validateTerminalMessage(raw: string): TerminalTextValidation {
  return validateTerminalText(raw, false);
}

export function validateFinishReason(raw: string): TerminalTextValidation {
  return validateTerminalText(raw, true);
}

// ---- terminal state (ADR-009 决策 6) ----

/** 64 KiB over the COMPACT JSON representation (`JSON.stringify` output). */
export const TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES = 65_536;

export type TerminalStateFailure = "not_object" | "not_json" | "too_large";

export type TerminalStateValidation =
  | { ok: true; state: JsonObject }
  | { ok: false; failure: TerminalStateFailure };

/**
 * Iterative PG-writability check over PLAIN JSON data (keys + string values):
 * every string must be storable verbatim (no NUL, no unpaired surrogates —
 * review A-2). Runs on the canonical clone produced by JSON.parse, which is
 * provably plain strict data — no getter, Proxy or cycle can survive parsing,
 * so this walk needs no exception boundary and always terminates.
 */
function isPgWritableJsonData(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (!isPgRepresentableText(value)) return false;
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) {
        if (!isPgRepresentableText(key)) return false;
        stack.push((value as Record<string, unknown>)[key]);
      }
    }
  }
  return true;
}

/**
 * Validate a terminal-protocol state value: the top level must be a JSON
 * object (`{}` is legal and means "promote to an empty object"; absence is
 * handled by the caller and never reaches here), every nested value must be
 * strict JSON, the compact encoding must fit 64 KiB, and every string key and
 * value must be PostgreSQL-writable (NUL and unpaired surrogates reject as
 * `not_json` — the policy's legal domain never exceeds the DB's writable
 * domain, review A-2).
 *
 * TOTAL over any input (review A-3): the raw input is read only inside
 * exception boundaries (guarded stringify + the stack-safe strict walk), and
 * the returned `state` is the CANONICAL CLONE derived from that single
 * serialization — callers persist exactly the value that passed every check
 * and never re-read a possibly getter-/Proxy-backed input. Any depth,
 * traversal or serialization exception is a stable `not_json`, never an
 * uncategorized crash.
 */
export function validateTerminalState(value: unknown): TerminalStateValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: "not_object" };
  }
  if (!isStrictJsonValue(value)) return { ok: false, failure: "not_json" };
  let compact: string;
  try {
    // Provably a string: isStrictJsonValue just serialized this input. A
    // mutating getter could still make this second read throw — caught here.
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return { ok: false, failure: "not_json" };
    compact = serialized;
  } catch {
    return { ok: false, failure: "not_json" };
  }
  if (utf8BytesExceed(compact, TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES)) {
    return { ok: false, failure: "too_large" };
  }
  // JSON.parse of a stringify output cannot throw and yields plain data.
  const canonical = JSON.parse(compact) as JsonObject;
  if (!isPgWritableJsonData(canonical)) return { ok: false, failure: "not_json" };
  return { ok: true, state: canonical };
}

// ---- task file sync result (ADR-009 决策 6) ----

/** 256 KiB over the UTF-8 content bytes. */
export const TASK_FILE_CONTENT_MAX_UTF8_BYTES = 262_144;

export type TaskFileSyncFailure = "both_present" | "both_missing" | "content_not_representable" | "content_too_large";

export type TaskFileSyncValidation = { ok: true } | { ok: false; failure: TaskFileSyncFailure };

/**
 * A v1 SUCCESS report carries EXACTLY ONE task-file sync result: content
 * (empty string is legal) XOR a sync error. Both present or both missing is
 * invalid. Content must additionally be PostgreSQL-representable — NUL and
 * unpaired surrogates cannot be stored in the text column verbatim, so they
 * reject as `content_not_representable` rather than failing the Batch 2 write
 * step (review A-2; the daemon-side local classification of such a file is a
 * Batch 2 wiring decision).
 */
export function validateTaskFileSyncResult(input: {
  taskFileContent?: string | undefined;
  taskFileSyncError?: TaskFileSyncError | undefined;
}): TaskFileSyncValidation {
  const hasContent = input.taskFileContent !== undefined;
  const hasError = input.taskFileSyncError !== undefined;
  if (hasContent && hasError) return { ok: false, failure: "both_present" };
  if (!hasContent && !hasError) return { ok: false, failure: "both_missing" };
  if (hasContent && !isPgRepresentableText(input.taskFileContent!)) {
    return { ok: false, failure: "content_not_representable" };
  }
  if (hasContent && utf8BytesExceed(input.taskFileContent!, TASK_FILE_CONTENT_MAX_UTF8_BYTES)) {
    return { ok: false, failure: "content_too_large" };
  }
  return { ok: true };
}

// ---- capability snapshot (ADR-009 决策 7) ----

/** The one capability Phase 4 gates on. Unknown capabilities are preserved. */
export const TERMINAL_JOURNAL_V1_CAPABILITY = "terminal-journal-v1";

/**
 * Normalize a daemon's capability declaration into the snapshot the server
 * persists: ABSENT (undefined) or explicit null → null; explicit `[]` → `[]`;
 * otherwise dedupe + sort (unknown names kept verbatim). A snapshot is the
 * CURRENT complete set, never an accumulation of past declarations. Persisted-
 * side limits (entry count, name length, name validity) are Batch 2's
 * machine-store concern, deliberately not here.
 */
export function normalizeCapabilities(input: readonly string[] | null | undefined): string[] | null {
  if (input == null) return null;
  return [...new Set(input)].sort();
}

/** Membership check — never a version-string comparison. */
export function hasTerminalJournalV1(capabilities: readonly string[] | null | undefined): boolean {
  return capabilities?.includes(TERMINAL_JOURNAL_V1_CAPABILITY) ?? false;
}
