/**
 * The stream-json incremental parser (Phase 2 batch 3, plan §2.4): turns the
 * Claude Code headless event stream (`claude -p --output-format stream-json
 * --verbose`, defined as JSONL whose LAST line is the terminal result) into
 * progress callbacks plus ONE terminal verdict, riding directly on
 * spawnWithTimeout's onStdout chunks.
 *
 * Contract (pinned by group-P tests):
 *  - TRANSPORT: a streaming TextDecoder reassembles multibyte UTF-8 across
 *    arbitrary chunk boundaries (no synthesized U+FFFD); CRLF is tolerated;
 *    blank lines are skipped; a final line without a trailing newline is
 *    flushed and parsed at finish().
 *  - MEMORY: a single line may buffer at most MAX_LINE_BYTES (1 MiB) of raw
 *    stream bytes, accounted on the BYTE stream (exact for ASCII, split-safe
 *    for multibyte) so a newline-free flood can never grow memory unbounded.
 *  - EVENTS: system/init captures the session id (first non-empty wins);
 *    assistant text blocks and tool_use blocks become progress labels in
 *    order (Bash summarizes input.command, other tools the JSON input);
 *    system/api_retry becomes a provider-retry progress label; every unknown
 *    event type/subtype/shape is IGNORED (tolerant reader — the parser only
 *    ever ACTS on shapes it fully recognizes).
 *  - TERMINAL RESULT (the trust anchor): exactly one `type:"result"` event,
 *    requiring a non-empty string subtype and a boolean is_error; success ⇔
 *    subtype === "success" AND is_error === false. Extracted numerics are
 *    kept only when finite, non-negative — and integral for the token/turn
 *    fields the wire schema declares int (costReportSchema) — an invalid
 *    value drops its OWN field only, never the parse.
 *  - FAILURES are stable and content-free: malformed JSON (or valid JSON that
 *    is not an event object), an overlong line, a duplicate result and a
 *    missing result are four distinct reasons whose detail carries a line
 *    NUMBER but NEVER line content (a line may embed secrets). A failure
 *    discovered by push() throws ClaudeStreamError — spawnWithTimeout turns a
 *    throwing consumer into consumer-error and terminates the process group
 *    immediately — and is ALSO returned by finish(); the failure state is
 *    sticky (later pushes keep throwing the same reason). After a terminal
 *    result the tail is tolerant: trailing lines are ignored EXCEPT a second
 *    result, which is the duplicate-result failure.
 *
 * This module does NOT redact: progress labels and extracted text are
 * verbatim child output until the ADAPTER scrubs them with redactSecrets
 * before they reach the runtime/report/log surface (plan §2.4).
 */

export const MAX_LINE_BYTES = 1024 * 1024;

export type ClaudeStreamFailureReason = "malformed-json" | "line-too-long" | "duplicate-result" | "missing-result";

export class ClaudeStreamError extends Error {
  readonly reason: ClaudeStreamFailureReason;
  constructor(reason: ClaudeStreamFailureReason, detail: string) {
    super(detail);
    this.name = "ClaudeStreamError";
    this.reason = reason;
  }
}

/** The validated terminal result event. Numeric fields are null when the
 *  child's value was absent or failed hygiene; errorText is the failure
 *  narrative for non-success terminals (null on success). */
export interface ClaudeTerminal {
  /** subtype === "success" AND is_error === false — NOTHING else counts. */
  success: boolean;
  subtype: string;
  /** The result text of a SUCCESS terminal only (null otherwise). */
  finalText: string | null;
  sessionId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  errorText: string | null;
}

export type ClaudeStreamParse =
  | { ok: true; terminal: ClaudeTerminal }
  | { ok: false; reason: ClaudeStreamFailureReason; detail: string };

export interface ClaudeStreamEvents {
  /** Fires synchronously per assistant text/tool_use block and per
   *  api_retry, in stream order, with the child's VERBATIM text. */
  onProgress?: (label: string) => void;
}

export interface ClaudeStreamParser {
  /** Feed one stdout chunk. Throws ClaudeStreamError on a recorded failure
   *  (sticky) and plain Error when pushed after finish(). */
  push(chunk: Uint8Array): void;
  /** Flush the decoder, parse any unterminated final line, and return the
   *  outcome. Idempotent. */
  finish(): ClaudeStreamParse;
  /** The session id captured at system/init — available even on failure. */
  readonly initSessionId: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite, non-negative — else null (the field is dropped, not the parse). */
function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Additionally integral — the wire cost schema declares these int. */
function intNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function createClaudeStreamParser(events: ClaudeStreamEvents = {}): ClaudeStreamParser {
  const onProgress = events.onProgress ?? ((): void => {});
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  /** Raw bytes accumulated for the CURRENT line since its last newline. */
  let pendingLineBytes = 0;
  /** Physical lines consumed (blank lines count) — the failure detail's
   *  content-free locator. */
  let linesProcessed = 0;
  let terminalSeen = false;
  let terminal: ClaudeTerminal | null = null;
  let failure: { reason: ClaudeStreamFailureReason; detail: string } | null = null;
  let initSessionId: string | null = null;
  let finished = false;

  /** Record the FIRST failure (it alone is reported) and throw it. */
  function fail(reason: ClaudeStreamFailureReason, detail: string): never {
    failure ??= { reason, detail };
    throw new ClaudeStreamError(reason, detail);
  }

  /** Enforce the per-line byte cap on the RAW stream, per completed segment
   *  and for the unterminated tail. Runs BEFORE decoding so an overlong line
   *  fails even when its bytes would never decode. */
  function accountBytes(chunk: Uint8Array): void {
    let segmentStart = 0;
    let completedInChunk = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] === 0x0a) {
        completedInChunk += 1;
        if (pendingLineBytes + (i - segmentStart) > MAX_LINE_BYTES) {
          fail("line-too-long", `line ${linesProcessed + completedInChunk} exceeded the 1 MiB line limit`);
        }
        pendingLineBytes = 0;
        segmentStart = i + 1;
      }
    }
    pendingLineBytes += chunk.length - segmentStart;
    if (pendingLineBytes > MAX_LINE_BYTES) {
      fail("line-too-long", `line ${linesProcessed + completedInChunk + 1} exceeded the 1 MiB line limit`);
    }
  }

  function toolLabel(name: string, input: unknown): string {
    if (!isObject(input)) return name;
    // Bash is the ONLY tool this batch exposes; its command is the summary.
    // Other names appear only from a CLI that ignored --tools — still worth a
    // label, summarized as compact JSON.
    if (name === "Bash" && typeof input.command === "string") return `Bash: ${input.command}`;
    return `${name}: ${JSON.stringify(input)}`;
  }

  function handleSystem(event: Record<string, unknown>): void {
    if (event.subtype === "init") {
      if (initSessionId === null && typeof event.session_id === "string" && event.session_id !== "") {
        initSessionId = event.session_id;
      }
      return;
    }
    if (event.subtype === "api_retry") {
      const parts: string[] = [];
      if (typeof event.attempt === "number" && Number.isFinite(event.attempt)) parts.push(`attempt ${event.attempt}`);
      if (typeof event.delay_ms === "number" && Number.isFinite(event.delay_ms)) {
        parts.push(`delay ${event.delay_ms}ms`);
      }
      onProgress(parts.length > 0 ? `provider api retry (${parts.join(", ")})` : "provider api retry");
    }
    // Unknown system subtypes: ignored.
  }

  function handleAssistant(event: Record<string, unknown>): void {
    const message = event.message;
    if (!isObject(message)) return;
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text") {
        if (typeof block.text === "string" && block.text.trim() !== "") onProgress(block.text);
      } else if (block.type === "tool_use") {
        if (typeof block.name !== "string" || block.name === "") continue;
        onProgress(toolLabel(block.name, block.input));
      }
      // thinking, tool_result and future block kinds: ignored.
    }
  }

  function extractErrorText(event: Record<string, unknown>): string | null {
    if (typeof event.result === "string" && event.result.trim() !== "") return event.result;
    if (Array.isArray(event.errors)) {
      const parts = event.errors.filter((e): e is string => typeof e === "string" && e !== "");
      if (parts.length > 0) return parts.join("; ");
    }
    return null;
  }

  function handleResult(event: Record<string, unknown>): void {
    const subtype = event.subtype;
    const isError = event.is_error;
    if (typeof subtype !== "string" || subtype === "" || typeof isError !== "boolean") {
      fail("malformed-json", `line ${linesProcessed}: the result event lacks a valid subtype/is_error`);
    }
    terminalSeen = true;
    const success = subtype === "success" && isError === false;
    const usage = isObject(event.usage) ? event.usage : {};
    terminal = {
      success,
      subtype,
      finalText: success && typeof event.result === "string" ? event.result : null,
      sessionId: typeof event.session_id === "string" && event.session_id !== "" ? event.session_id : null,
      costUsd: finiteNonNegative(event.total_cost_usd),
      inputTokens: intNonNegative(usage.input_tokens),
      outputTokens: intNonNegative(usage.output_tokens),
      cacheReadTokens: intNonNegative(usage.cache_read_input_tokens),
      cacheCreationTokens: intNonNegative(usage.cache_creation_input_tokens),
      numTurns: intNonNegative(event.num_turns),
      errorText: success ? null : extractErrorText(event),
    };
  }

  function handleLine(raw: string): void {
    linesProcessed += 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    if (terminalSeen) {
      // Tolerant tail: only a SECOND terminal result is an error; anything
      // else — known events, unknown events, unparseable junk — is ignored.
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (isObject(event) && event.type === "result") {
        fail("duplicate-result", `line ${linesProcessed} is a second terminal result event`);
      }
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      fail("malformed-json", `line ${linesProcessed} is not valid JSON`);
    }
    if (!isObject(event)) {
      fail("malformed-json", `line ${linesProcessed} is not a JSON object event`);
    }
    if (event.type === "system") handleSystem(event);
    else if (event.type === "assistant") handleAssistant(event);
    else if (event.type === "result") handleResult(event);
    // Unknown event types: ignored.
  }

  return {
    push(chunk: Uint8Array): void {
      if (finished) throw new Error("claude stream parser already finished");
      if (failure !== null) throw new ClaudeStreamError(failure.reason, failure.detail);
      accountBytes(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let idx = pending.indexOf("\n");
      while (idx >= 0) {
        const raw = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        handleLine(raw);
        idx = pending.indexOf("\n");
      }
    },

    finish(): ClaudeStreamParse {
      if (!finished) {
        finished = true;
        pending += decoder.decode(); // flush any held partial sequence
        try {
          if (pending.trim() !== "") handleLine(pending);
        } catch (err) {
          if (!(err instanceof ClaudeStreamError)) throw err;
          // A failure discovered on the final line is recorded — fall through.
        }
        pending = "";
      }
      if (failure !== null) return { ok: false, reason: failure.reason, detail: failure.detail };
      if (terminal === null) {
        return { ok: false, reason: "missing-result", detail: "stream ended without a terminal result event" };
      }
      return { ok: true, terminal };
    },

    get initSessionId() {
      return initSessionId;
    },
  };
}
