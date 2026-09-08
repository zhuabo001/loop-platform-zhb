/** Pure policy and stream analysis for the opt-in Claude compatibility gate. */

export const MAX_DIAGNOSTIC_CALLS = 8;
export const DIAGNOSTIC_WINDOW_MS = 90 * 60_000;
export const COST_TARGET_USD = 3;

export const VARIANT_PROFILES = Object.freeze({
  A: Object.freeze({ wrapper: "legacy", runTemp: "legacy", purpose: "diagnostic" }),
  B: Object.freeze({ wrapper: "legacy", runTemp: "fixed", purpose: "diagnostic" }),
  C: Object.freeze({ wrapper: "fixed", runTemp: "legacy", purpose: "diagnostic" }),
  D: Object.freeze({ wrapper: "fixed", runTemp: "fixed", purpose: "diagnostic" }),
  P: Object.freeze({ wrapper: "fixed", runTemp: "fixed", purpose: "production" }),
  R: Object.freeze({ wrapper: "fixed", runTemp: "fixed", purpose: "refusal" }),
});

function resultText(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

export function isTerminalCommand(command) {
  return /^\s*loopzhb\s+(?:report|finish)(?:\s|$)/.test(command);
}

/** Pair Bash calls/results by Claude's tool-use identity. Event order is not
 * a reliable join key: tool results can be grouped or arrive out of order. */
export function analyzeStream(stdoutText) {
  const calls = [];
  const resultById = new Map();
  let terminal = null;
  for (const line of stdoutText.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "tool_use" && block.name === "Bash") {
          calls.push({ id: String(block.id ?? ""), command: String(block.input?.command ?? "") });
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "tool_result") {
          resultById.set(String(block.tool_use_id ?? ""), {
            isError: block.is_error === true,
            preview: resultText(block.content).slice(0, 300),
          });
        }
      }
    } else if (event.type === "result") {
      terminal = event;
    }
  }
  const joined = calls.map((call) => ({ ...call, result: resultById.get(call.id) ?? null }));
  return { calls: joined, terminalCalls: joined.filter((call) => isTerminalCommand(call.command)), terminal };
}

function exactCalls(stream, command) {
  return stream.calls.filter((call) => call.command.trim() === command.trim());
}

/** Strict acceptance for final production/refusal runs. Diagnostic A/B/C/D
 * still records this result, while their expected red/green signatures are
 * assessed separately by the driver. */
export function evaluateCompatVerdict({ variant, reportOk, stream, markers, sideEffectOk, commands, refusal }) {
  const failures = [];
  const taskRead = exactCalls(stream, commands.taskRead);
  const success = exactCalls(stream, commands.success);
  const expectedFailure = exactCalls(stream, commands.expectedFailure);
  const terminal = exactCalls(stream, commands.terminal);
  const expectedCommands = new Set([
    commands.taskRead.trim(),
    commands.success.trim(),
    commands.expectedFailure.trim(),
    commands.terminal.trim(),
    ...(commands.denials ?? []).map((command) => command.trim()),
  ]);
  const unexpected = stream.calls.filter((call) => !expectedCommands.has(call.command.trim()));

  if (!reportOk) failures.push("runner report was not ok");
  if (markers.opensslAbort) failures.push("OpenSSL abort marker present");
  if (markers.cwdEperm) failures.push("cwd EPERM marker present");
  if (taskRead.length !== 1) failures.push(`task-file read command count was ${taskRead.length}, expected 1`);
  else if (taskRead[0].result?.isError !== false) failures.push("task-file read command did not succeed");
  if (success.length !== 1) failures.push(`success command count was ${success.length}, expected 1`);
  else if (success[0].result?.isError !== false) failures.push("success command did not succeed");
  if (!sideEffectOk) failures.push("success side effect missing");
  if (expectedFailure.length !== 1) failures.push(`expected-failure command count was ${expectedFailure.length}, expected 1`);
  else if (expectedFailure[0].result?.isError !== true) failures.push("expected-failure command did not fail");
  if (stream.terminalCalls.length !== 1) failures.push(`terminal command count was ${stream.terminalCalls.length}, expected 1`);
  if (terminal.length !== 1) failures.push(`expected terminal command count was ${terminal.length}, expected 1`);
  else if (terminal[0].result?.isError !== false) failures.push("terminal command did not succeed");
  if (unexpected.length > 0) failures.push(`unexpected Bash command count was ${unexpected.length}`);

  for (const denial of commands.denials ?? []) {
    const matches = exactCalls(stream, denial);
    if (matches.length !== 1) failures.push(`denial command count was ${matches.length}, expected 1: ${denial}`);
    else if (matches[0].result?.isError !== false) failures.push(`refusal probe shell did not complete: ${denial}`);
  }
  const expectedSequence = [commands.taskRead, commands.success, commands.expectedFailure, ...(commands.denials ?? []), commands.terminal];
  const actualSequence = stream.calls.map((call) => call.command.trim());
  if (
    actualSequence.length !== expectedSequence.length ||
    expectedSequence.some((command, index) => actualSequence[index] !== command.trim())
  ) {
    failures.push("Bash command sequence did not match the acceptance protocol");
  }
  if (variant === "R") {
    if (refusal?.allProbesAttempted !== true) failures.push("refusal probe did not reach the shell attempt");
    if (refusal?.allProbesDenied !== true) failures.push("refusal probe did not take the denied branch");
    if (refusal?.allTargetsIntact !== true) failures.push("refusal target changed");
  }
  return { ok: failures.length === 0, failures };
}

function validateLedgerRow(row) {
  if (
    row === null ||
    typeof row !== "object" ||
    typeof row.variant !== "string" ||
    typeof row.runId !== "string" ||
    typeof row.at !== "string" ||
    !Number.isFinite(Date.parse(row.at)) ||
    !(row.usd === null || (typeof row.usd === "number" && Number.isFinite(row.usd) && row.usd >= 0)) ||
    !(row.status === undefined || ["started", "complete", "cost-unknown"].includes(row.status))
  ) {
    throw new Error("invalid spend ledger row");
  }
}

export function assessBudget(ledger, nowMs = Date.now(), limits = {}) {
  const maxCalls = limits.maxCalls ?? MAX_DIAGNOSTIC_CALLS;
  const windowMs = limits.windowMs ?? DIAGNOSTIC_WINDOW_MS;
  const costTargetUsd = limits.costTargetUsd ?? COST_TARGET_USD;
  if (!Array.isArray(ledger)) throw new Error("invalid spend ledger: expected an array");
  for (const row of ledger) validateLedgerRow(row);
  const spent = ledger.reduce((sum, row) => sum + (typeof row.usd === "number" ? row.usd : 0), 0);
  const unfinished = ledger.find((row) => row.status === "started");
  if (unfinished) return { ok: false, spent, reason: `unfinished call ${unfinished.runId} blocks further paid experiments` };
  const unknown = ledger.find((row) => row.usd === null || row.status === "cost-unknown");
  if (unknown) return { ok: false, spent, reason: `unknown cost for ${unknown.runId} blocks further paid experiments` };
  if (ledger.length >= maxCalls) {
    return { ok: false, spent, reason: `${maxCalls} call ${limits.label ?? "diagnostic"} limit reached` };
  }
  if (ledger.length > 0) {
    const firstAt = Math.min(...ledger.map((row) => Date.parse(row.at)));
    if (nowMs - firstAt >= windowMs) {
      return { ok: false, spent, reason: `${windowMs / 60_000} minute ${limits.label ?? "diagnostic"} window elapsed` };
    }
  }
  if (spent >= costTargetUsd) return { ok: false, spent, reason: `$${costTargetUsd} cost target reached` };
  return { ok: true, spent, reason: null };
}
