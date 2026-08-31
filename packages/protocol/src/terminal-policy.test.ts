/**
 * Terminal-policy tests (plan P3/P6/P7): the value rules daemon and server
 * execute identically (ADR-009; ADR-002 决策 4 的窄例外). Every boundary is
 * pinned at the exact byte, because both peers must agree bit-for-bit.
 */
import { describe, expect, it } from "vitest";

import {
  GOAL_MAX_UTF8_BYTES,
  hasTerminalJournalV1,
  normalizeCapabilities,
  normalizeGoal,
  TASK_FILE_CONTENT_MAX_UTF8_BYTES,
  TERMINAL_JOURNAL_V1_CAPABILITY,
  TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES,
  TERMINAL_TEXT_MAX_UTF8_BYTES,
  validateFinishReason,
  validateTaskFileSyncResult,
  validateTerminalMessage,
  validateTerminalState,
} from "./index.js"; // P7: the policy rides the MAIN entry, no subpath

describe("normalizeGoal (ADR-009 决策 2)", () => {
  it("trims and persists the normalized value", () => {
    expect(normalizeGoal("  ship the audit report  ")).toEqual({ ok: true, goal: "ship the audit report" });
    expect(normalizeGoal("\tkeep\tinner\twhitespace\t")).toEqual({ ok: true, goal: "keep\tinner\twhitespace" });
  });

  it("rejects empty-after-trim", () => {
    expect(normalizeGoal("")).toEqual({ ok: false, failure: "empty" });
    expect(normalizeGoal("   \t  ")).toEqual({ ok: false, failure: "empty" });
  });

  it("rejects NUL, CR and LF anywhere in the normalized value", () => {
    expect(normalizeGoal("a\0b")).toEqual({ ok: false, failure: "contains_nul" });
    expect(normalizeGoal("a\rb")).toEqual({ ok: false, failure: "not_single_line" });
    expect(normalizeGoal("a\nb")).toEqual({ ok: false, failure: "not_single_line" });
    expect(normalizeGoal("a\r\nb")).toEqual({ ok: false, failure: "not_single_line" });
  });

  it("rejects unpaired UTF-16 surrogates — not PG-representable (review A-2)", () => {
    expect(normalizeGoal("a\uD800b")).toEqual({ ok: false, failure: "malformed_unicode" });
    expect(normalizeGoal("a\uDC00b")).toEqual({ ok: false, failure: "malformed_unicode" });
    expect(normalizeGoal("\uD800")).toEqual({ ok: false, failure: "malformed_unicode" });
    // A well-formed astral pair is fine.
    expect(normalizeGoal("ship 🚀 it")).toEqual({ ok: true, goal: "ship 🚀 it" });
  });

  it("pins the 2000 UTF-8 byte ceiling exactly (ASCII)", () => {
    expect(normalizeGoal("a".repeat(GOAL_MAX_UTF8_BYTES))).toEqual({
      ok: true,
      goal: "a".repeat(GOAL_MAX_UTF8_BYTES),
    });
    expect(normalizeGoal("a".repeat(GOAL_MAX_UTF8_BYTES + 1))).toEqual({ ok: false, failure: "too_long" });
  });

  it("pins the ceiling in UTF-8 BYTES, not code units (multibyte)", () => {
    // 'é' (U+00E9): 1 UTF-16 code unit, 2 UTF-8 bytes.
    expect(normalizeGoal("é".repeat(1000))).toEqual({ ok: true, goal: "é".repeat(1000) });
    expect(normalizeGoal("é".repeat(1001))).toEqual({ ok: false, failure: "too_long" });
    // Astral char (2 code units, 4 bytes) fits under the ceiling.
    expect(normalizeGoal("🚀".repeat(500))).toEqual({ ok: true, goal: "🚀".repeat(500) });
  });

  it("checks emptiness before NUL and NUL before line breaks (stable first failure)", () => {
    expect(normalizeGoal("  ")).toEqual({ ok: false, failure: "empty" });
    expect(normalizeGoal("a\0b\nc")).toEqual({ ok: false, failure: "contains_nul" });
  });
});

describe("validateTerminalMessage / validateFinishReason (ADR-009 决策 6)", () => {
  it("keeps the original text and newlines — no trim, no single-line rule", () => {
    const messy = "  line one\nline two\r\n  ";
    expect(validateTerminalMessage(messy)).toEqual({ ok: true });
    expect(validateFinishReason(messy)).toEqual({ ok: true });
  });

  it("message may be empty; finish reason must NOT", () => {
    expect(validateTerminalMessage("")).toEqual({ ok: true });
    expect(validateFinishReason("")).toEqual({ ok: false, failure: "empty" });
  });

  it("rejects NUL", () => {
    expect(validateTerminalMessage("a\0b")).toEqual({ ok: false, failure: "contains_nul" });
    expect(validateFinishReason("a\0b")).toEqual({ ok: false, failure: "contains_nul" });
  });

  it("rejects unpaired UTF-16 surrogates — not PG-representable (review A-2)", () => {
    expect(validateTerminalMessage("bad \uD800 message")).toEqual({ ok: false, failure: "malformed_unicode" });
    expect(validateFinishReason("\uDFFF")).toEqual({ ok: false, failure: "malformed_unicode" });
    expect(validateTerminalMessage("paired 🚀 pair")).toEqual({ ok: true });
  });

  it("pins the 2000 UTF-8 byte ceiling exactly", () => {
    expect(validateTerminalMessage("m".repeat(TERMINAL_TEXT_MAX_UTF8_BYTES))).toEqual({ ok: true });
    expect(validateTerminalMessage("m".repeat(TERMINAL_TEXT_MAX_UTF8_BYTES + 1))).toEqual({
      ok: false,
      failure: "too_long",
    });
    expect(validateFinishReason("é".repeat(1000))).toEqual({ ok: true });
    expect(validateFinishReason("é".repeat(1001))).toEqual({ ok: false, failure: "too_long" });
  });
});

describe("validateTerminalState (ADR-009 决策 6)", () => {
  it("requires a top-level JSON object — array/null/string/number are illegal", () => {
    expect(validateTerminalState({})).toEqual({ ok: true, state: {} });
    expect(validateTerminalState({ nested: { a: [1, "x", null, true] } })).toEqual({
      ok: true,
      state: { nested: { a: [1, "x", null, true] } },
    });
    expect(validateTerminalState([])).toEqual({ ok: false, failure: "not_object" });
    expect(validateTerminalState(null)).toEqual({ ok: false, failure: "not_object" });
    expect(validateTerminalState("s")).toEqual({ ok: false, failure: "not_object" });
    expect(validateTerminalState(42)).toEqual({ ok: false, failure: "not_object" });
  });

  it("pins the 64 KiB COMPACT-encoding ceiling exactly", () => {
    // Compact form is {"data":"<n x's>"} — derive n from the real wrapper so
    // the boundary is exact, not hand-counted.
    const wrapper = '{"data":""}'.length; // 11 compact bytes
    const fits = { data: "x".repeat(TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES - wrapper) };
    expect(JSON.stringify(fits).length).toBe(TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES);
    expect(validateTerminalState(fits)).toEqual({ ok: true, state: fits });
    const over = { data: "x".repeat(TERMINAL_STATE_MAX_COMPACT_UTF8_BYTES - wrapper + 1) };
    expect(validateTerminalState(over)).toEqual({ ok: false, failure: "too_large" });
  });

  it("rejects non-JSON values that stringify would silently drop or mangle", () => {
    expect(validateTerminalState({ a: undefined })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ a: Number.NaN })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ a: 10n })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ a: () => 1 })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ a: new Date(0) })).toEqual({ ok: false, failure: "not_json" });
  });

  it("turns a circular structure into a stable not_json, never a crash", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(validateTerminalState(circular)).toEqual({ ok: false, failure: "not_json" });
  });

  it("rejects strings PostgreSQL jsonb cannot store — NUL and unpaired surrogates, in values AND keys (review A-2)", () => {
    expect(validateTerminalState({ x: "\0" })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ x: "a\0b" })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ x: "\uD800" })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ x: "\uDC00" })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ nested: [{ deep: "bad\uD800" }] })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ "k\0": 1 })).toEqual({ ok: false, failure: "not_json" });
    expect(validateTerminalState({ "k\uD800": 1 })).toEqual({ ok: false, failure: "not_json" });
    // Well-formed astral pairs and nested multibyte text are fine.
    expect(validateTerminalState({ "é🚀": ["pair 🚀 ok"] })).toEqual({
      ok: true,
      state: { "é🚀": ["pair 🚀 ok"] },
    });
  });

  it("returns the CANONICAL CLONE, not the caller's object (review A-3)", () => {
    const inner = { b: "x" };
    const input = { a: [1, inner] };
    const result = validateTerminalState(input);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state).toEqual(input);
    expect(result.state).not.toBe(input);
    // Mutating the input after validation cannot alter the validated value.
    inner.b = "tampered";
    expect(result.state).toEqual({ a: [1, { b: "x" }] });
  });

  it("contains getter/Proxy trap exceptions inside the validation boundary (review A-3)", () => {
    // A getter that throws on the (single) read, and a Proxy whose ownKeys
    // trap throws — both must become a stable not_json, never escape.
    const throwsOnRead = {
      get value(): number {
        throw new Error("trap");
      },
    };
    expect(validateTerminalState(throwsOnRead)).toEqual({ ok: false, failure: "not_json" });
    const proxied = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    expect(validateTerminalState(proxied)).toEqual({ ok: false, failure: "not_json" });
  });

  it("reads every property EXACTLY ONCE — the single read IS the validated value (review AD2-2)", () => {
    // The old stringify→walk→stringify flow read the same getter three times:
    // a getter answering 1, 1, then undefined was ACCEPTED and silently
    // persisted as {} — data the validator never actually saw. Now the clone
    // is built from one controlled pass, so whatever the single read returns
    // is exactly what gets validated and persisted.
    let reads = 0;
    const shapeShifter = {
      get value(): unknown {
        reads++;
        return reads === 1 ? 1 : undefined; // any SECOND read would be illegal
      },
    };
    const result = validateTerminalState(shapeShifter);
    expect(result).toEqual({ ok: true, state: { value: 1 } });
    expect(reads).toBe(1);

    // And a single read of an ILLEGAL value rejects, of course.
    expect(validateTerminalState({ get value() { return undefined; } })).toEqual({
      ok: false,
      failure: "not_json",
    });
    expect(validateTerminalState({ get value() { return Number.NaN; } })).toEqual({
      ok: false,
      failure: "not_json",
    });
  });

  it("preserves special keys like __proto__ as REAL own properties in the canonical clone (review SP2-1)", () => {
    // JSON.parse gives __proto__ a genuine own property; the clone must match
    // — assigning it would silently set the clone's PROTOTYPE and drop the key.
    const input = JSON.parse('{"__proto__":{"marker":1},"keep":2,"outer":{"__proto__":[3]}}');
    const result = validateTerminalState(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.state)).toBe(Object.prototype);
    expect(Object.keys(result.state).sort()).toEqual(["__proto__", "keep", "outer"]);
    expect(Object.prototype.hasOwnProperty.call(result.state, "__proto__")).toBe(true);
    expect((result.state as Record<string, unknown>)["__proto__"]).toEqual({ marker: 1 });
    const outer = result.state["outer"] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(outer, "__proto__")).toBe(true);
    expect(outer["__proto__"]).toEqual([3]);
  });

  it("turns pathological depth into a stable not_json — no stack overflow escapes", () => {
    // Far beyond any engine's stringify recursion limit; built iteratively.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200_000; i++) deep = { next: deep };
    expect(validateTerminalState(deep)).toEqual({ ok: false, failure: "not_json" });
  });
});

describe("validateTaskFileSyncResult (ADR-009 决策 6)", () => {
  it("requires EXACTLY ONE sync result", () => {
    expect(validateTaskFileSyncResult({ taskFileContent: "# doc" })).toEqual({ ok: true });
    expect(validateTaskFileSyncResult({ taskFileContent: "" })).toEqual({ ok: true }); // empty is legal
    for (const error of ["missing", "unreadable", "outside_jail", "changed", "too_large"] as const) {
      expect(validateTaskFileSyncResult({ taskFileSyncError: error })).toEqual({ ok: true });
    }
    expect(validateTaskFileSyncResult({ taskFileContent: "x", taskFileSyncError: "missing" })).toEqual({
      ok: false,
      failure: "both_present",
    });
    expect(validateTaskFileSyncResult({})).toEqual({ ok: false, failure: "both_missing" });
  });

  it("pins the 256 KiB UTF-8 content ceiling exactly", () => {
    expect(validateTaskFileSyncResult({ taskFileContent: "x".repeat(TASK_FILE_CONTENT_MAX_UTF8_BYTES) })).toEqual({
      ok: true,
    });
    expect(
      validateTaskFileSyncResult({ taskFileContent: "x".repeat(TASK_FILE_CONTENT_MAX_UTF8_BYTES + 1) }),
    ).toEqual({ ok: false, failure: "content_too_large" });
    expect(validateTaskFileSyncResult({ taskFileContent: "é".repeat(TASK_FILE_CONTENT_MAX_UTF8_BYTES / 2) })).toEqual(
      { ok: true },
    );
  });

  it("rejects content PostgreSQL text cannot store verbatim — NUL and unpaired surrogates (review A-2)", () => {
    expect(validateTaskFileSyncResult({ taskFileContent: "\0" })).toEqual({
      ok: false,
      failure: "content_not_representable",
    });
    expect(validateTaskFileSyncResult({ taskFileContent: "a\0b" })).toEqual({
      ok: false,
      failure: "content_not_representable",
    });
    expect(validateTaskFileSyncResult({ taskFileContent: "lone \uD800 surrogate" })).toEqual({
      ok: false,
      failure: "content_not_representable",
    });
    // Newlines, tabs, multibyte and astral pairs round-trip fine.
    expect(validateTaskFileSyncResult({ taskFileContent: "# TASK\n\t- é 🚀" })).toEqual({ ok: true });
  });
});

describe("capability snapshot (ADR-009 决策 7)", () => {
  it("pins the capability name", () => {
    expect(TERMINAL_JOURNAL_V1_CAPABILITY).toBe("terminal-journal-v1");
  });

  it("absent or null → null; explicit empty array stays empty", () => {
    expect(normalizeCapabilities(undefined)).toBeNull();
    expect(normalizeCapabilities(null)).toBeNull();
    expect(normalizeCapabilities([])).toEqual([]);
  });

  it("dedupes, sorts and preserves unknown capabilities", () => {
    expect(normalizeCapabilities(["zeta", "terminal-journal-v1", "zeta", "alpha"])).toEqual([
      "alpha",
      "terminal-journal-v1",
      "zeta",
    ]);
    expect(normalizeCapabilities(["unknown-future-cap"])).toEqual(["unknown-future-cap"]);
  });

  it("membership check never does version-string comparison", () => {
    expect(hasTerminalJournalV1(null)).toBe(false);
    expect(hasTerminalJournalV1(undefined)).toBe(false);
    expect(hasTerminalJournalV1([])).toBe(false);
    expect(hasTerminalJournalV1(["terminal-journal-v1"])).toBe(true);
    expect(hasTerminalJournalV1(["terminal-journal-v2"])).toBe(false);
    expect(hasTerminalJournalV1(["daemon-9.9.9"])).toBe(false);
  });
});
