/**
 * Mock Anthropic Messages API for the permission probe
 * (claude-permission-probe.test.ts, Issue #57).
 *
 * The permission layer — not the model — is what decides whether a Bash call
 * runs under `--permission-mode dontAsk`. Driving the REAL CLI with a canned
 * tool_use therefore exercises that layer exactly, at zero cost.
 *
 *  - turn 1 (no tool_result in the request): stream one assistant message
 *    whose only content block is a Bash tool_use carrying $PROBE_COMMAND;
 *  - turn 2 (a tool_result is present): end the turn with plain text so the
 *    CLI exits cleanly.
 *
 * Every request body is appended to $PROBE_LOG as one JSON line, so the CLI's
 * own verdict (the tool_result text) is captured as evidence.
 */
import { appendFileSync } from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PROBE_PORT ?? "0");
const LOG = process.env.PROBE_LOG;
const COMMAND = process.env.PROBE_COMMAND;

function log(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

function sse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function hasToolResult(body) {
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_result") return true;
    }
  }
  return false;
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    log({ url: req.url, method: req.method, body });

    if (req.method !== "POST") return void res.writeHead(404).end();
    if ((req.url ?? "").includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ input_tokens: 1 }));
    }

    const message = {
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model: body?.model ?? "claude-sonnet-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    if (!hasToolResult(body)) {
      return sse(res, [
        ["message_start", { type: "message_start", message }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_probe_1", name: "Bash", input: {} },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: COMMAND, description: "probe" }) },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
        ],
        ["message_stop", { type: "message_stop" }],
      ]);
    }

    sse(res, [
      ["message_start", { type: "message_start", message }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "probe done" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  log({ ready: true, port: typeof address === "object" && address !== null ? address.port : null });
  if (process.send) process.send({ port: typeof address === "object" && address !== null ? address.port : null });
});
