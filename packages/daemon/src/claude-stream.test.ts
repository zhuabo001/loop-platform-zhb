/**
 * Stream-json parser pins (Phase 2 batch 3, plan §2.4 — group P): the
 * incremental JSONL parser that rides spawnWithTimeout.onStdout.
 *
 * Pinned contract:
 *  - transport: streaming UTF-8 across arbitrary chunk splits (a 3-byte scalar
 *    split anywhere must never synthesize U+FFFD), CRLF tolerated, blank lines
 *    skipped, a final line without a trailing newline still parses;
 *  - events: system/init captures the session id (first wins); assistant text
 *    and tool_use blocks become progress labels IN ORDER; system/api_retry
 *    becomes a provider-retry progress label; unknown events are ignored;
 *  - the terminal result is the trust anchor: exactly ONE, success requires
 *    subtype === "success" AND is_error === false; numeric fields are kept
 *    only when finite, non-negative (and integral where the wire schema
 *    requires integers) — invalid values drop their OWN field only;
 *  - failure modes are stable and content-free: malformed JSON, a line over
 *    1 MiB, a duplicate result, a missing result and an init/result
 *    session_id conflict are distinct reasons, and the failure detail NEVER
 *    quotes the offending line (it may carry secrets). A parse failure throws
 *    from push() (the subprocess layer terminates the group on a throwing
 *    consumer) AND is returned by finish().
 */
import { describe, expect, it } from "vitest";

import {
  ClaudeStreamError,
  MAX_LINE_BYTES,
  createClaudeStreamParser,
  type ClaudeStreamParser,
} from "./claude-stream.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function harness(): { parser: ClaudeStreamParser; progress: string[] } {
  const progress: string[] = [];
  const parser = createClaudeStreamParser({ onProgress: (label) => progress.push(label) });
  return { parser, progress };
}

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  tools: ["Bash"],
  cwd: "/work",
});

const TEXT = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "looking into it" }] },
});

const TOOL_BASH = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }],
  },
});

const SUCCESS_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "all done",
  session_id: "sess-1",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  num_turns: 2,
  duration_ms: 4321,
});

describe("P1: the canonical stream parses end to end", () => {
  it("init + assistant text + tool_use + success result, all in one chunk", () => {
    const { parser, progress } = harness();
    parser.push(enc(`${INIT}\n${TEXT}\n${TOOL_BASH}\n${SUCCESS_RESULT}\n`));
    const outcome = parser.finish();

    expect(progress).toEqual(["looking into it", "Bash: ls -la"]);
    expect(parser.initSessionId).toBe("sess-1");
    expect(outcome).toEqual({
      ok: true,
      terminal: {
        success: true,
        subtype: "success",
        finalText: "all done",
        sessionId: "sess-1",
        costUsd: 0.0123,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        numTurns: 2,
        errorText: null,
      },
    });
  });
});

describe("P2: transport — arbitrary chunk splits never corrupt UTF-8", () => {
  const stream = `${INIT}\n${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "已处理 3 个文件 ✅" }] },
  })}\n${SUCCESS_RESULT}\n`;
  const bytes = enc(stream);

  it("every two-chunk split point yields the identical parse", () => {
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const { parser, progress } = harness();
      parser.push(bytes.subarray(0, cut));
      parser.push(bytes.subarray(cut));
      const outcome = parser.finish();
      expect(outcome.ok).toBe(true);
      expect(progress).toEqual(["已处理 3 个文件 ✅"]);
    }
  });

  it("byte-at-a-time drip feeding yields the identical parse", () => {
    const { parser, progress } = harness();
    for (let i = 0; i < bytes.length; i += 1) parser.push(bytes.subarray(i, i + 1));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    expect(progress).toEqual(["已处理 3 个文件 ✅"]);
  });
});

describe("P3–P5: transport tolerances", () => {
  it("P3: a final line without a trailing newline still parses at finish()", () => {
    const { parser } = harness();
    parser.push(enc(`${INIT}\n${SUCCESS_RESULT}`)); // no trailing \n
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.terminal.finalText).toBe("all done");
  });

  it("P4: CRLF line endings are tolerated", () => {
    const { parser, progress } = harness();
    parser.push(enc(`${INIT}\r\n${TEXT}\r\n${SUCCESS_RESULT}\r\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    expect(progress).toEqual(["looking into it"]);
  });

  it("P5: blank and whitespace-only lines are skipped", () => {
    const { parser } = harness();
    parser.push(enc(`\n${INIT}\n   \n\t\n${SUCCESS_RESULT}\n\n`));
    expect(parser.finish().ok).toBe(true);
  });
});

describe("P6: unknown events are ignored", () => {
  it("future types/subtypes, non-object message members and a repeated init never disturb the parse", () => {
    const { parser, progress } = harness();
    const events = [
      JSON.stringify({ type: "future-feature", payload: { x: 1 } }),
      JSON.stringify({ type: "system", subtype: "tomorrow", note: "unknown subtype" }),
      JSON.stringify({ type: "system" }), // no subtype
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
      JSON.stringify({ type: 42 }), // non-string type
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" }), // repeat init: first wins
    ];
    parser.push(enc(`${INIT}\n${events.join("\n")}\n${SUCCESS_RESULT}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    expect(progress).toEqual([]);
    expect(parser.initSessionId).toBe("sess-1");
    if (outcome.ok) expect(outcome.terminal.sessionId).toBe("sess-1");
  });
});

describe("P7: api_retry becomes a provider-retry progress label", () => {
  it("with attempt/delay fields, without them, and with non-numeric ones", () => {
    const { parser, progress } = harness();
    const lines = [
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, delay_ms: 500 }),
      JSON.stringify({ type: "system", subtype: "api_retry" }),
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: "2", delay_ms: null }),
      SUCCESS_RESULT,
    ];
    parser.push(enc(`${lines.join("\n")}\n`));
    expect(parser.finish().ok).toBe(true);
    expect(progress).toEqual([
      "provider api retry (attempt 2, delay 500ms)",
      "provider api retry",
      "provider api retry",
    ]);
  });
});

describe("P8: tool_use progress labels", () => {
  it("Bash summarizes the command; other tools summarize the JSON input; no input leaves the bare name", () => {
    const { parser, progress } = harness();
    const message = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
          { type: "tool_use", name: "Read", input: { file_path: "/x/y.ts" } },
          { type: "tool_use", name: "Bash" },
          { type: "tool_use", name: 7, input: { command: "ignored — non-string name" } },
          "not-an-object-block",
        ],
      },
    });
    parser.push(enc(`${message}\n${SUCCESS_RESULT}\n`));
    expect(parser.finish().ok).toBe(true);
    expect(progress).toEqual(["Bash: pnpm test", 'Read: {"file_path":"/x/y.ts"}', "Bash"]);
  });
});

describe("P9: assistant robustness", () => {
  it("missing/non-object message, non-array content and empty text produce no progress and no failure", () => {
    const { parser, progress } = harness();
    const lines = [
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "assistant", message: "nope" }),
      JSON.stringify({ type: "assistant", message: { content: "nope" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: 9 }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "real" }] } }),
      SUCCESS_RESULT,
    ];
    parser.push(enc(`${lines.join("\n")}\n`));
    expect(parser.finish().ok).toBe(true);
    expect(progress).toEqual(["real"]);
  });
});

describe("P10: the success gate — subtype AND is_error", () => {
  it("is_error:true with subtype success is NOT a success", () => {
    const { parser } = harness();
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "boom" });
    parser.push(enc(`${result}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.terminal.success).toBe(false);
      expect(outcome.terminal.errorText).toBe("boom");
    }
  });

  it("error_max_turns carries its result text as errorText", () => {
    const { parser } = harness();
    const result = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "ran out of turns",
    });
    parser.push(enc(`${result}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.terminal.success).toBe(false);
      expect(outcome.terminal.subtype).toBe("error_max_turns");
      expect(outcome.terminal.errorText).toBe("ran out of turns");
    }
  });

  it("an errors array is the errorText fallback; no text at all leaves null", () => {
    const withErrors = harness();
    withErrors.parser.push(
      enc(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "bad"] })}\n`),
    );
    const a = withErrors.parser.finish();
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.terminal.errorText).toBe("boom; bad");

    const bare = harness();
    bare.parser.push(enc(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })}\n`));
    const b = bare.parser.finish();
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.terminal.errorText).toBeNull();
  });
});

describe("P11: numeric field hygiene", () => {
  it("non-finite, negative, non-integer and wrongly-typed values drop ONLY their own field", () => {
    const { parser } = harness();
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: -0.5, // negative → dropped
      usage: {
        input_tokens: "10", // string → dropped
        output_tokens: -3, // negative → dropped
        cache_read_input_tokens: 1e400, // non-finite after parse → dropped
        cache_creation_input_tokens: 40, // the sole survivor
      },
      num_turns: 1.5, // non-integer → dropped
    });
    parser.push(enc(`${result}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.terminal.costUsd).toBeNull();
      expect(outcome.terminal.inputTokens).toBeNull();
      expect(outcome.terminal.outputTokens).toBeNull();
      expect(outcome.terminal.cacheReadTokens).toBeNull();
      expect(outcome.terminal.cacheCreationTokens).toBe(40);
      expect(outcome.terminal.numTurns).toBeNull();
    }
  });

  it("a missing or non-object usage block leaves every token field null", () => {
    for (const usage of [undefined, "lots", 7]) {
      const { parser } = harness();
      const result = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        total_cost_usd: 0,
        ...(usage === undefined ? {} : { usage }),
        num_turns: 0,
      });
      parser.push(enc(`${result}\n`));
      const outcome = parser.finish();
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.terminal.costUsd).toBe(0); // zero is non-negative and kept
        expect(outcome.terminal.inputTokens).toBeNull();
        expect(outcome.terminal.outputTokens).toBeNull();
        expect(outcome.terminal.cacheReadTokens).toBeNull();
        expect(outcome.terminal.cacheCreationTokens).toBeNull();
        expect(outcome.terminal.numTurns).toBe(0);
      }
    }
  });
});

describe("P12: malformed JSON fails stably and content-free", () => {
  it("push() throws ClaudeStreamError; finish() returns the failure; the detail never quotes the line", () => {
    const { parser } = harness();
    const bad = `{"type":"assistant", BROKEN sk-ant-live-secret`;
    let thrown: unknown;
    try {
      parser.push(enc(`${INIT}\n${bad}\n`));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaudeStreamError);
    expect((thrown as ClaudeStreamError).reason).toBe("malformed-json");

    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("malformed-json");
      expect(outcome.detail).toContain("line 2");
      expect(outcome.detail).not.toContain("sk-ant-live-secret");
      expect(outcome.detail).not.toContain("BROKEN");
    }
  });
});

describe("P13: the 1 MiB line cap", () => {
  const prefix = '{"type":"future","pad":"';
  const suffix = '"}';

  it("a line of exactly MAX_LINE_BYTES parses; one byte more fails", () => {
    const exact = harness();
    const okLine = prefix + "a".repeat(MAX_LINE_BYTES - prefix.length - suffix.length) + suffix;
    expect(enc(okLine).length).toBe(MAX_LINE_BYTES);
    exact.parser.push(enc(`${okLine}\n${SUCCESS_RESULT}\n`));
    expect(exact.parser.finish().ok).toBe(true);

    const over = harness();
    const overLine = okLine + "b";
    let thrown: unknown;
    try {
      over.parser.push(enc(`${overLine}\n`));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaudeStreamError);
    expect((thrown as ClaudeStreamError).reason).toBe("line-too-long");
    const outcome = over.parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("line-too-long");
  });

  it("the cap is enforced on bytes accumulated ACROSS chunks before any newline", () => {
    const { parser } = harness();
    const half = "a".repeat(MAX_LINE_BYTES / 2);
    parser.push(enc(half)); // half a line, no newline — fine
    expect(() => parser.push(enc(half + "c"))).toThrow(ClaudeStreamError);
  });
});

describe("P14: the terminal result must appear exactly once", () => {
  it("a second result in the same push fails duplicate-result", () => {
    const { parser } = harness();
    expect(() => parser.push(enc(`${SUCCESS_RESULT}\n${SUCCESS_RESULT}\n`))).toThrow(ClaudeStreamError);
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("duplicate-result");
  });

  it("a second result in a later push fails duplicate-result", () => {
    const { parser } = harness();
    parser.push(enc(`${SUCCESS_RESULT}\n`));
    expect(() => parser.push(enc(`${SUCCESS_RESULT}\n`))).toThrow(ClaudeStreamError);
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("duplicate-result");
  });
});

describe("P15: a clean stream without a result is missing-result", () => {
  it("events but no terminal", () => {
    const { parser, progress } = harness();
    parser.push(enc(`${INIT}\n${TEXT}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("missing-result");
    expect(progress).toEqual(["looking into it"]); // progress was still emitted live
  });
});

describe("P16: valid JSON that is not an event object is malformed", () => {
  it.each(["42", '"str"', "null", "[1,2]", "true"])("%s fails malformed-json", (line) => {
    const { parser } = harness();
    expect(() => parser.push(enc(`${line}\n`))).toThrow(ClaudeStreamError);
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("malformed-json");
  });
});

describe("P17: post-terminal tolerance", () => {
  it("unknown events and even unparseable junk AFTER the terminal are ignored; the parse stands", () => {
    const { parser, progress } = harness();
    parser.push(
      enc(
        `${SUCCESS_RESULT}\n${JSON.stringify({ type: "future", note: "late" })}\n{totally broken\n\n`,
      ),
    );
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.terminal.finalText).toBe("all done");
    expect(progress).toEqual([]);
  });
});

describe("P18: session id sources", () => {
  it("a terminal without session_id leaves terminal.sessionId null; the init capture remains available", () => {
    const { parser } = harness();
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" });
    parser.push(enc(`${INIT}\n${result}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.terminal.sessionId).toBeNull();
    expect(parser.initSessionId).toBe("sess-1");
  });

  it("a non-string session_id is dropped", () => {
    const { parser } = harness();
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: 42 });
    parser.push(enc(`${result}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.terminal.sessionId).toBeNull();
  });
});

describe("P19: the result event must carry a valid subtype and is_error", () => {
  it.each([
    ["missing is_error", { type: "result", subtype: "success" }],
    ["non-boolean is_error", { type: "result", subtype: "success", is_error: "no" }],
    ["missing subtype", { type: "result", is_error: false }],
    ["non-string subtype", { type: "result", subtype: 7, is_error: false }],
    ["empty subtype", { type: "result", subtype: "", is_error: false }],
  ])("%s fails malformed-json", (_label, event) => {
    const { parser } = harness();
    expect(() => parser.push(enc(`${JSON.stringify(event)}\n`))).toThrow(ClaudeStreamError);
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("malformed-json");
  });
});

describe("P21: init/result session identity conflict fails closed", () => {
  it("a result session_id that differs from the init capture fails session-id-conflict — content-free", () => {
    const { parser } = harness();
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      session_id: "sess-OTHER",
    });
    expect(() => parser.push(enc(`${INIT}\n${result}\n`))).toThrow(ClaudeStreamError);
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("session-id-conflict");
      expect(outcome.detail).toContain("line 2");
      expect(outcome.detail).not.toContain("sess-1");
      expect(outcome.detail).not.toContain("sess-OTHER");
    }
  });

  it("matching ids, a missing terminal id, and no init are all accepted", () => {
    const matching = harness();
    matching.parser.push(enc(`${INIT}\n${SUCCESS_RESULT}\n`));
    const matched = matching.parser.finish();
    expect(matched.ok).toBe(true);
    if (matched.ok) expect(matched.terminal.sessionId).toBe("sess-1");

    const noTerminalId = harness();
    const bare = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    noTerminalId.parser.push(enc(`${INIT}\n${bare}\n`));
    expect(noTerminalId.parser.finish().ok).toBe(true);

    const noInit = harness();
    noInit.parser.push(enc(`${SUCCESS_RESULT}\n`));
    expect(noInit.parser.finish().ok).toBe(true);
  });

  it("first-init-wins: a later init does not re-target the identity", () => {
    const { parser } = harness();
    const init2 = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" });
    parser.push(enc(`${INIT}\n${init2}\n${SUCCESS_RESULT}\n`));
    const outcome = parser.finish();
    expect(outcome.ok).toBe(true);
    expect(parser.initSessionId).toBe("sess-1");
  });

  it("an error terminal with a conflicting session_id still fails conflict", () => {
    const { parser } = harness();
    const result = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "blew up",
      session_id: "sess-OTHER",
    });
    expect(() => parser.push(enc(`${INIT}\n${result}\n`))).toThrow(ClaudeStreamError);
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("session-id-conflict");
  });
});

describe("P20: the failure state is sticky", () => {
  it("push() after a failure keeps throwing the same reason; finish() still returns it", () => {
    const { parser } = harness();
    expect(() => parser.push(enc("{bad\n"))).toThrow(ClaudeStreamError);
    expect(() => parser.push(enc("{still bad\n"))).toThrow(ClaudeStreamError);
    let second: unknown;
    try {
      parser.push(enc("{again\n"));
    } catch (err) {
      second = err;
    }
    expect((second as ClaudeStreamError).reason).toBe("malformed-json");
    const outcome = parser.finish();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("malformed-json");
  });
});
