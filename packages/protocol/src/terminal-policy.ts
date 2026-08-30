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
import type { JsonObject } from "./json.js";
import type { TaskFileSyncError } from "./report.js";

// ---- shared byte measurement ----

const encoder = new TextEncoder();

/** Exact UTF-8 byte length. Fast path: a string longer than `maxBytes` in
 *  UTF-16 code units is always over (UTF-8 never shrinks). */
function utf8BytesExceed(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true;
  return encoder.encode(value).length > maxBytes;
}

// ---- goal (ADR-009 决策 2) ----

export const GOAL_MAX_UTF8_BYTES = 2000;

export type GoalValidationFailure = "empty" | "contains_nul" | "not_single_line" | "too_long";

export type GoalValidation = { ok: true; goal: string } | { ok: false; failure: GoalValidationFailure };

/**
 * Normalize and validate a goal string: JavaScript `trim()`, then reject when
 * empty, containing NUL/CR/LF, or over 2000 UTF-8 bytes. The NORMALIZED value
 * is what gets persisted and compared — equal-after-trim updates are no-ops.
 * `null` (Open Loop) is handled by the domain layer, not here.
 */
export function normalizeGoal(raw: string): GoalValidation {
  const goal = raw.trim();
  if (goal === "") return { ok: false, failure: "empty" };
  if (goal.includes("\0")) return { ok: false, failure: "contains_nul" };
  if (goal.includes("\r") || goal.includes("\n")) return { ok: false, failure: "not_single_line" };
  if (utf8BytesExceed(goal, GOAL_MAX_UTF8_BYTES)) return { ok: false, failure: "too_long" };
  return { ok: true, goal };
}

// ---- terminal message / finish reason (ADR-009 决策 6 的文本规则) ----

export const TERMINAL_TEXT_MAX_UTF8_BYTES = 2000;

export type TerminalTextFailure = "empty" | "contains_nul" | "too_long";

export type TerminalTextValidation = { ok: true } | { ok: false; failure: TerminalTextFailure };

/**
 * message/reason keep their original text and newlines — NO trim, NO
 * single-line rule (unlike goal). Only NUL and the 2000 UTF-8 byte ceiling
 * reject. The finish reason must additionally be non-empty.
 */
function validateTerminalText(raw: string, requireNonEmpty: boolean): TerminalTextValidation {
  if (requireNonEmpty && raw === "") return { ok: false, failure: "empty" };
  if (raw.includes("\0")) return { ok: false, failure: "contains_nul" };
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
 * Iterative strict JSON-value check: rejects `undefined`, functions, symbols,
 * bigints, non-finite numbers and exotic object prototypes — values that
 * `JSON.stringify` would silently drop or mangle. Runs only AFTER a
 * successful stringify, so the input is provably finite and acyclic and this
 * explicit-stack walk always terminates (no recursion → no stack overflow on
 * deep JsonObjects, per ADR-009 决策 6).
 */
function isStrictJsonValue(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null) continue;
    switch (typeof value) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(value)) return false;
        continue;
      case "object": {
        if (Array.isArray(value)) {
          for (const item of value) stack.push(item);
          continue;
        }
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto !== null && proto !== Object.prototype) return false;
        for (const key of Object.keys(value)) {
          stack.push((value as Record<string, unknown>)[key]);
        }
        continue;
      }
      default:
        return false;
    }
  }
  return true;
}

/**
 * Validate a terminal-protocol state value: the top level must be a JSON
 * object (`{}` is legal and means "promote to an empty object"; absence is
 * handled by the caller and never reaches here), every nested value must be
 * strict JSON, and the compact encoding must fit 64 KiB. ANY traversal or
 * serialization exception (deep nesting RangeError, circular TypeError, …) is
 * a stable `not_json` rejection — never an uncategorized crash.
 */
export function validateTerminalState(value: unknown): TerminalStateValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: "not_object" };
  }
  let compact: string;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return { ok: false, failure: "not_json" };
    compact = serialized;
  } catch {
    return { ok: false, failure: "not_json" };
  }
  if (!isStrictJsonValue(value)) return { ok: false, failure: "not_json" };
  if (utf8BytesExceed(compact, TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES)) {
    return { ok: false, failure: "too_large" };
  }
  return { ok: true, state: value as JsonObject };
}

// ---- task file sync result (ADR-009 决策 6) ----

/** 256 KiB over the UTF-8 content bytes. */
export const TASK_FILE_CONTENT_MAX_UTF8_BYTES = 262_144;

export type TaskFileSyncFailure = "both_present" | "both_missing" | "content_too_large";

export type TaskFileSyncValidation = { ok: true } | { ok: false; failure: TaskFileSyncFailure };

/**
 * A v1 SUCCESS report carries EXACTLY ONE task-file sync result: content
 * (empty string is legal) XOR a sync error. Both present or both missing is
 * invalid.
 */
export function validateTaskFileSyncResult(input: {
  taskFileContent?: string | undefined;
  taskFileSyncError?: TaskFileSyncError | undefined;
}): TaskFileSyncValidation {
  const hasContent = input.taskFileContent !== undefined;
  const hasError = input.taskFileSyncError !== undefined;
  if (hasContent && hasError) return { ok: false, failure: "both_present" };
  if (!hasContent && !hasError) return { ok: false, failure: "both_missing" };
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
