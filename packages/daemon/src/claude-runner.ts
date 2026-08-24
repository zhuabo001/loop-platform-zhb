/**
 * The Claude Code adapter (Phase 2 batch 3, plan §2.2–2.4): the real
 * AgentRunner. One run =
 *
 *   agent gate → jail.resolve → build settings → jail.revalidate →
 *   spawnWithTimeout(claude …fixed argv…) → stream-json parser → report
 *
 * with the per-run scratch released in a `finally` (a failed release FAILS
 * the run — the success report is discarded, plan §2.2).
 *
 * Security posture (the batch-3 safety unit):
 *  - ONLY the Bash tool is exposed (`--tools Bash`): Claude's built-in
 *    sandbox bounds Bash and its children at the OS level; the built-in
 *    Read/Edit/Write tools are NOT inside that boundary, so they stay off;
 *  - the sandbox is FAIL-CLOSED (`failIfUnavailable`, no unsandboxed
 *    fallback, no excluded commands, denyRead `/` + allowlists, an empty
 *    network allowlist) — when the OS sandbox is unavailable the CLI must
 *    fail, never degrade;
 *  - user/project/local settings sources are disabled (`--setting-sources
 *    ""`, `--safe-mode`), hooks and memory are off, permission mode is
 *    pinned to `dontAsk` (never bypass);
 *  - child-controlled progress text is discarded in favor of fixed semantic
 *    labels; terminal child text (finalText, error narrative, session id) is
 *    redacted with env secrets AND the run token before report/runtime;
 *  - jail.revalidate re-checks the resolution immediately before spawn —
 *    a drifted cwd/root/scratch means NO spawn (S1–S10); the irreducible
 *    revalidate→execve residue is bounded by the fail-closed OS sandbox
 *    (allowlists are computed from realpaths) — ADR-006 决策 7;
 *  - the production runner spawns the probe-RESOLVED binary path and
 *    re-verifies its identity before every spawn; observed drift is refused.
 *    The same-UID stat/hash→execve residual is explicit in ADR-006.
 *
 * Failure mapping is stable and content-free: a fixed message per failure
 * class (spawn/timeout/abort/signal/non-zero exit/stream parse), the CLI's
 * own error narrative when it produced one (redacted, capped), and NEVER an
 * untrusted raw transcript.
 */
import type { CostReport, Delivery } from "@loopzhb/protocol";

import { buildAgentEnv, redactSecrets } from "./agent-env.js";
import { createClaudeStreamParser, type ClaudeStreamParser } from "./claude-stream.js";
import type { ResolvedWorkdir, WorkdirJail } from "./jail.js";
import { sameClaudeBinary, statClaudeBinary, type ClaudeBinaryIdentity } from "./probe-claude.js";
import type { AgentRunner, RunnerContext, RunnerReport } from "./runner.js";
import { ERROR_CAP } from "./runtime.js";
import type { ProcessGroupLifecycleEvent, SpawnResult } from "./subprocess.js";
import { ProcessControlError, spawnWithTimeout } from "./subprocess.js";

export interface ClaudeRunnerDeps {
  jail: WorkdirJail;
  claudeBin: string;
  timeoutMs: number;
  /** The daemon process env — filtered through the agent-env whitelist. */
  envSource: NodeJS.ProcessEnv;
  /** The probe-pinned executable identity (production). The runner re-hashes
   *  this resolved path before every spawn. Absent only in direct adapter
   *  tests. */
  probedBinary?: ClaudeBinaryIdentity;
  /** Opt-in Batch-4 acceptance observer for the exact Claude process group
   *  created by spawnWithTimeout. */
  onProcessGroup?: (event: ProcessGroupLifecycleEvent) => void;
  /** Replaces spawnWithTimeout. TEST-ONLY seam (same standing as
   *  SpawnOptions.killImpl): production call sites never set this — the
   *  combined-failure pin (A22) needs a spawn that rejects with
   *  ProcessControlError, which a real child cannot do on demand. */
  spawnImpl?: typeof spawnWithTimeout;
}

/** The dynamic per-run settings (plan §2.3). allowRead/allowWrite are the
 *  effective roots PLUS the cwd (a scratch cwd lies outside the roots);
 *  exact duplicates collapse. */
export function buildSandboxSettings(resolved: ResolvedWorkdir): Record<string, unknown> {
  const allow = [...new Set([...resolved.effectiveRoots, resolved.cwd])];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        disabled: false,
        denyRead: ["/"],
        allowRead: allow,
        allowWrite: allow,
      },
      network: { strictAllowlist: true, allowedDomains: [] },
    },
    disableAllHooks: true,
    autoMemoryEnabled: false,
  };
}

/** The fixed CLI form (plan §2.3). `--model` / `--append-system-prompt`
 *  append only when the delivery carries them (an empty systemPrompt skips
 *  the flag — the protocol contract). */
export function buildClaudeArgs(delivery: Delivery, settingsJson: string): string[] {
  const args = [
    "-p",
    delivery.task,
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--tools",
    "Bash",
    "--permission-mode",
    "dontAsk",
    "--prompt-suggestions",
    "false",
    "--settings",
    settingsJson,
  ];
  if (delivery.loop.model !== null && delivery.loop.model !== "") {
    args.push("--model", delivery.loop.model);
  }
  if (delivery.systemPrompt !== "") {
    args.push("--append-system-prompt", delivery.systemPrompt);
  }
  return args;
}

/** A redacted, capped tail of stderr for operability — never the raw stream. */
function stderrTail(spawned: SpawnResult, redact: (text: string) => string): string {
  const tail = redact(spawned.stderr).trim();
  return tail === "" ? "" : `: stderr tail: ${tail.slice(-500)}`;
}

function streamFailureMessage(parse: { reason: string; detail: string }): string {
  return `claude stream parse failed (${parse.reason}): ${parse.detail}`;
}

export function createClaudeRunner(deps: ClaudeRunnerDeps): AgentRunner {
  return {
    async run(delivery: Delivery, ctx: RunnerContext): Promise<RunnerReport> {
      // The agent gate: only claude-code is implemented this batch; other
      // providers fail WITHOUT spawning (plan §2.2).
      const agent = delivery.loop.agent ?? "claude-code";
      if (agent !== "claude-code") {
        return { ok: false, error: `unsupported agent: ${agent}` };
      }

      const { env, secretValues } = buildAgentEnv(deps.envSource);
      const redact = (text: string): string => redactSecrets(text, [...secretValues, delivery.runToken]);

      const resolved = await deps.jail.resolve({
        workdir: delivery.loop.workdir,
        serverRoots: delivery.roots,
        loopId: delivery.loop.id,
        runId: delivery.runId,
      });
      const spawn = deps.spawnImpl ?? spawnWithTimeout;
      let controlErr: ProcessControlError | null = null;
      try {
        const settingsJson = JSON.stringify(buildSandboxSettings(resolved));
        // The spawn-time re-check (plan §2.2): any drift since resolve means
        // NO spawn — the JailError propagates and fails the run.
        await deps.jail.revalidate(resolved);

        // Re-check the exact resolved path that passed the credential-free
        // startup probes before exposing the full agent environment. The
        // residual stat/hash→execve window is userspace-irreducible.
        let command = deps.claudeBin;
        if (deps.probedBinary !== undefined) {
          const now = await statClaudeBinary(deps.probedBinary.resolvedPath, { signal: ctx.signal }).catch(() => null);
          if (now === null || !sameClaudeBinary(deps.probedBinary, now)) {
            return {
              ok: false,
              error: "claude binary changed since the startup probe — refusing to spawn (restart the daemon to re-probe)",
            };
          }
          command = deps.probedBinary.resolvedPath;
        }

        const parser = createClaudeStreamParser({
          onProgress: (_label, kind) => {
            // Progress is a continuously observable channel. Per-event
            // redaction cannot stop a credential split across two events, so
            // child-controlled assistant/command text never crosses it. Keep
            // only fixed semantic labels, including provider retry.
            if (kind === "assistant-text") ctx.onProgress("claude response");
            else if (kind === "tool-use") ctx.onProgress("running Bash");
            else ctx.onProgress("provider api retry");
          },
        });
        const spawned = await spawn({
          command,
          args: buildClaudeArgs(delivery, settingsJson),
          cwd: resolved.cwd,
          env,
          timeoutMs: deps.timeoutMs,
          signal: ctx.signal,
          onStdout: (chunk) => parser.push(chunk),
          ...(deps.onProcessGroup !== undefined ? { onProcessGroup: deps.onProcessGroup } : {}),
        });
        return reportFromSpawn(delivery, spawned, parser, redact, deps.timeoutMs);
      } catch (err) {
        if (err instanceof ProcessControlError) controlErr = err;
        throw err;
      } finally {
        // Scratch release is fail-closed and UNCONDITIONAL: if it throws, the
        // run fails (a computed report — success included — is discarded).
        // EXCEPTION (round-2 review P1): a ProcessControlError in flight must
        // NEVER be masked by the release failure — a runaway child outranks
        // broken cleanup, and the runtime escalates on exactly that type. The
        // release failure rides in the message so it is not silently lost.
        try {
          await deps.jail.release(resolved);
        } catch (releaseErr) {
          if (controlErr !== null) {
            const detail = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
            throw new ProcessControlError(`${controlErr.message} (scratch release also failed: ${detail})`, {
              cause: controlErr,
            });
          }
          throw releaseErr;
        }
      }
    },
  };
}

function reportFromSpawn(
  delivery: Delivery,
  spawned: SpawnResult,
  parser: ClaudeStreamParser,
  redact: (text: string) => string,
  timeoutMs: number,
): RunnerReport {
  const failure = (error: string): RunnerReport => ({ ok: false, error: error.slice(0, ERROR_CAP) });
  const completion = spawned.completion;
  const parse = parser.finish();

  if (completion.kind === "timed-out") return failure(`claude timed out after ${timeoutMs}ms`);
  if (completion.kind === "aborted") return failure("claude run aborted");
  if (completion.kind === "signaled") return failure(`claude exited on signal ${completion.signal}`);
  if (completion.kind === "spawn-error") {
    return failure(`failed to spawn claude (${completion.code ?? "unknown"}): ${redact(completion.message)}`);
  }
  if (completion.kind === "consumer-error") {
    // The stream consumer (the parser) threw — its recorded failure is the
    // authoritative narrative when present.
    return failure(parse.ok ? `claude stream consumer failed: ${completion.message}` : streamFailureMessage(parse));
  }

  // kind === "exited"
  const exitCode = completion.exitCode;
  if (exitCode === 0 && parse.ok && parse.terminal.success) {
    const terminal = parse.terminal;
    const report: RunnerReport = {
      ok: true,
      // Plan §2.2: role=evolve reports evolve; every other successful role
      // reports exec.
      outcome: delivery.role === "evolve" ? "evolve" : "exec",
      durationMs: Math.max(0, Math.round(spawned.durationMs)),
    };
    if (terminal.finalText !== null && terminal.finalText !== "") {
      report.finalText = redact(terminal.finalText);
    }
    // The session id falls back to the init capture when the terminal lacks
    // it. It is child-controlled text like any other — redact before it
    // enters the report (round-1 review P1).
    const sessionId = terminal.sessionId ?? parser.initSessionId;
    if (sessionId !== null) report.sessionId = redact(sessionId);
    const cost: CostReport = {};
    if (terminal.costUsd !== null) cost.usd = terminal.costUsd;
    if (terminal.inputTokens !== null) cost.inputTokens = terminal.inputTokens;
    if (terminal.outputTokens !== null) cost.outputTokens = terminal.outputTokens;
    if (terminal.cacheReadTokens !== null) cost.cacheReadTokens = terminal.cacheReadTokens;
    if (terminal.cacheCreationTokens !== null) cost.cacheCreationTokens = terminal.cacheCreationTokens;
    if (terminal.numTurns !== null) cost.numTurns = terminal.numTurns;
    if (Object.keys(cost).length > 0) report.cost = cost;
    return report;
  }

  // The CLI's own error narrative beats any process-level detail.
  if (parse.ok && !parse.terminal.success) {
    return failure(redact(parse.terminal.errorText ?? `claude reported ${parse.terminal.subtype}`));
  }
  if (exitCode !== 0) {
    if (parse.ok) {
      // A success terminal with a non-zero exit is a disagreement — fail-closed.
      return failure(`claude exited with code ${exitCode} despite a success result`);
    }
    return failure(`claude exited with code ${exitCode}${stderrTail(spawned, redact)}`);
  }
  // exit 0 without a (successful) terminal: the stream parse failure is the story.
  if (!parse.ok) return failure(`${streamFailureMessage(parse)}${stderrTail(spawned, redact)}`);
  return failure(`claude reported ${parse.terminal.subtype}`); // unreachable gate-kept fallback
}
