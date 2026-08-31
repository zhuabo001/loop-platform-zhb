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

// ---- PostgreSQL writability ----

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
 * domain: a policy-accepted value must round-trip bit-for-bit,
 * so a v1 write-plan can never fail at the database step.
 *
 * Module-private: an implementation helper, not a protocol
 * package promise, until a real cross-module caller exists.
 */
function isPgRepresentableText(value: string): boolean {
  return !value.includes("\0") && !hasUnpairedSurrogate(value);
}

// ---- goal (ADR-009 决策 2) ----

export const GOAL_MAX_UTF8_BYTES = 2000;

export type GoalValidationFailure = "empty" | "contains_nul" | "not_single_line" | "malformed_unicode" | "too_long";

export type GoalValidation = { ok: true; goal: string } | { ok: false; failure: GoalValidationFailure };

/**
 * Normalize and validate a goal string: JavaScript `trim()`, then reject when
 * empty, containing NUL/CR/LF, containing an unpaired UTF-16 surrogate (not
 * storable verbatim), or over 2000 UTF-8 bytes. The NORMALIZED
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
 * PG-representable) and the 2000 UTF-8 byte ceiling reject. The
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

type StrictJsonCloneResult =
  | { ok: true; state: JsonObject }
  | { ok: false; failure: "not_json" | "too_large" };

type CloneEntry = {
  clone: Record<string, unknown> | unknown[];
  compactUtf8Bytes?: number;
};

type AttachClone = (clone: unknown, compactUtf8Bytes: number) => void;

type ArrayFrame = {
  kind: "array";
  source: unknown[];
  clone: unknown[];
  length: number;
  index: number;
  compactUtf8Bytes: number;
  attach: AttachClone;
};

type ObjectFrame = {
  kind: "object";
  source: Record<string, unknown>;
  clone: Record<string, unknown>;
  keys: IterableIterator<string>;
  index: number;
  compactUtf8Bytes: number;
  attach: AttachClone;
};

type CloneFrame = ArrayFrame | ObjectFrame;

type CloneEvent = { type: "visit"; value: unknown; attach: AttachClone } | { type: "next"; frame: CloneFrame };

/** Exact compact-JSON UTF-8 bytes for a primitive or object key. */
function compactPrimitiveBytes(value: string | number | boolean | null): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  const serialized = JSON.stringify(value);
  return typeof value === "number" ? serialized.length : encoder.encode(serialized).length;
}

/** Lazily yields own enumerable string keys in JSON/Object.keys order. */
function* ownEnumerableKeys(source: object): IterableIterator<string> {
  for (const key in source) {
    if (Object.hasOwn(source, key)) yield key;
  }
}

function createSafeArray(length: number): unknown[] {
  const clone: unknown[] = new Array(length);
  Object.defineProperty(clone, "toJSON", { value: undefined, enumerable: false });
  return clone;
}

function createSafeObject(): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  // Drizzle and similar adapters inspect `constructor`, so keep the ordinary
  // object prototype while shadowing any polluted inherited serializer. A
  // legal own `toJSON` data key can replace this configurable placeholder.
  Object.defineProperty(clone, "toJSON", {
    value: undefined,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return clone;
}

/**
 * Validate, clone and size an untrusted state in one controlled iterative pass.
 * The event stack holds one cursor frame per nesting level instead of one event
 * per remaining sibling, and byte accounting stops the traversal immediately
 * after the compact encoding exceeds 64 KiB. Shared DAG nodes are cloned once;
 * their memoized encoded size is charged at every reference without expanding
 * the subtree. Cycles and every non-JSON value reject.
 *
 * Each source value is read once. Clone keys are defined rather than assigned,
 * so `__proto__` remains an own property. All caller-controlled reflection and
 * property access happens inside the caller's exception boundary.
 */
function cloneTerminalState(root: object): StrictJsonCloneResult {
  const clones = new Map<object, CloneEntry>();
  const active = new Set<object>();
  let rootClone: unknown;
  let failure: "not_json" | "too_large" | null = null;

  const addBytes = (frame: CloneFrame, bytes: number): boolean => {
    if (bytes > TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES - frame.compactUtf8Bytes) {
      failure = "too_large";
      return false;
    }
    frame.compactUtf8Bytes += bytes;
    return true;
  };

  // A null-prototype LIFO avoids Array.prototype numeric accessors changing
  // traversal control flow while validating adversarial input.
  const events = Object.create(null) as Record<number, CloneEvent>;
  let eventCount = 0;
  const pushEvent = (event: CloneEvent): void => {
    events[eventCount++] = event;
  };
  const popEvent = (): CloneEvent => {
    const index = --eventCount;
    const event = events[index]!;
    Reflect.deleteProperty(events, String(index));
    return event;
  };
  pushEvent({
    type: "visit",
    value: root,
    attach: (clone) => {
      rootClone = clone;
    },
  });

  while (eventCount > 0 && failure === null) {
    const event = popEvent();
    if (event.type === "next") {
      const frame = event.frame;
      if (frame.kind === "array") {
        if (frame.index >= frame.length) {
          active.delete(frame.source);
          clones.get(frame.source)!.compactUtf8Bytes = frame.compactUtf8Bytes;
          frame.attach(frame.clone, frame.compactUtf8Bytes);
          continue;
        }
        const index = frame.index++;
        if (index > 0 && !addBytes(frame, 1)) continue; // comma
        if (!Object.hasOwn(frame.source, index)) {
          failure = "not_json"; // sparse arrays are not strict JSON
          continue;
        }
        const child = frame.source[index];
        pushEvent({ type: "next", frame });
        pushEvent({
          type: "visit",
          value: child,
          attach: (clone, compactUtf8Bytes) => {
            Object.defineProperty(frame.clone, index, {
              value: clone,
              writable: true,
              enumerable: true,
              configurable: true,
            });
            addBytes(frame, compactUtf8Bytes);
          },
        });
        continue;
      }

      const keyResult = frame.keys.next();
      if (keyResult.done) {
        active.delete(frame.source);
        clones.get(frame.source)!.compactUtf8Bytes = frame.compactUtf8Bytes;
        frame.attach(frame.clone, frame.compactUtf8Bytes);
        continue;
      }
      const keyIndex = frame.index++;
      const key = keyResult.value;
      // Recreate a legal data key at its source-order position instead of
      // retaining the earlier non-enumerable prototype-pollution shield.
      if (key === "toJSON") Reflect.deleteProperty(frame.clone, key);
      if (!isPgRepresentableText(key)) {
        failure = "not_json";
        continue;
      }
      // JSON quoting cannot make a string shorter. Avoid allocating the
      // escaped string and UTF-8 buffer when the raw key alone is over limit.
      if (key.length > TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES) {
        failure = "too_large";
        continue;
      }
      const separatorBytes = (keyIndex > 0 ? 1 : 0) + compactPrimitiveBytes(key) + 1; // comma + key + colon
      if (!addBytes(frame, separatorBytes)) continue;
      const child = frame.source[key];
      pushEvent({ type: "next", frame });
      pushEvent({
        type: "visit",
        value: child,
        attach: (clone, compactUtf8Bytes) => {
          Object.defineProperty(frame.clone, key, {
            value: clone,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          addBytes(frame, compactUtf8Bytes);
        },
      });
      continue;
    }

    const { value, attach } = event;
    if (value === null || typeof value === "boolean") {
      attach(value, compactPrimitiveBytes(value));
      continue;
    }
    if (typeof value === "string") {
      if (!isPgRepresentableText(value)) {
        failure = "not_json";
        continue;
      }
      if (value.length > TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES) {
        failure = "too_large";
        continue;
      }
      attach(value, compactPrimitiveBytes(value));
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        failure = "not_json";
        continue;
      }
      attach(value, compactPrimitiveBytes(value));
      continue;
    }
    if (typeof value !== "object") {
      failure = "not_json"; // undefined/function/symbol/bigint
      continue;
    }
    if (active.has(value)) {
      failure = "not_json"; // cycle
      continue;
    }
    const shared = clones.get(value);
    if (shared?.compactUtf8Bytes !== undefined) {
      attach(shared.clone, shared.compactUtf8Bytes);
      continue;
    }
    if (Array.isArray(value)) {
      const length = value.length;
      const clone = createSafeArray(length);
      const frame: ArrayFrame = {
        kind: "array",
        source: value,
        clone,
        length,
        index: 0,
        compactUtf8Bytes: 2, // []
        attach,
      };
      clones.set(value, { clone });
      active.add(value);
      pushEvent({ type: "next", frame });
      continue;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      failure = "not_json";
      continue;
    }
    const clone = createSafeObject();
    const frame: ObjectFrame = {
      kind: "object",
      source: value as Record<string, unknown>,
      clone,
      keys: ownEnumerableKeys(value),
      index: 0,
      compactUtf8Bytes: 2, // {}
      attach,
    };
    clones.set(value, { clone });
    active.add(value);
    pushEvent({ type: "next", frame });
  }

  if (failure !== null) return { ok: false, failure };
  return { ok: true, state: rootClone as JsonObject };
}

/**
 * Validate a terminal-protocol state value: the top level must be a JSON
 * object (`{}` is legal and means "promote to an empty object"; absence is
 * handled by the caller and never reaches here), every nested value must be
 * strict JSON, the compact encoding must fit 64 KiB, and every string key and
 * value must be PostgreSQL-writable (NUL and unpaired surrogates reject as
 * `not_json` — the policy's legal domain never exceeds the DB's writable
 * domain).
 *
 * TOTAL over any input: the raw input is read only inside one exception
 * boundary, each property exactly once. That pass builds the CANONICAL CLONE,
 * validates PostgreSQL writability, and incrementally accounts for the exact
 * compact JSON bytes; it stops at 64 KiB without re-reading or recursively
 * serializing a getter-/Proxy-backed input. Any reflection or traversal
 * exception is a stable `not_json`, never an uncategorized crash.
 */
export function validateTerminalState(value: unknown): TerminalStateValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, failure: "not_object" };
  }
  let result: StrictJsonCloneResult;
  try {
    if (Array.isArray(value)) return { ok: false, failure: "not_object" };
    result = cloneTerminalState(value);
  } catch {
    return { ok: false, failure: "not_json" };
  }
  if (!result.ok) return result;
  try {
    // The exact expanded size is already <= 64 KiB, so this cannot recreate
    // the earlier resource amplification. It proves that the value accepted
    // here can pass the same recursive serialization used by DB adapters.
    if (typeof JSON.stringify(result.state) !== "string") return { ok: false, failure: "not_json" };
  } catch {
    return { ok: false, failure: "not_json" };
  }
  return { ok: true, state: result.state };
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
 * step (the daemon-side local classification of such a file is a
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
