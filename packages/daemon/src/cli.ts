/**
 * THE daemon composition root (plan §1/§4): validated config → startup jail →
 * Claude CLI probe → provider env bootstrap → Machine client → Claude Runner
 * → runtime foreground loop, with ONE AbortController fanning SIGINT/SIGTERM
 * out to the poll sleep, in-flight HTTP and report retries. The core never
 * calls process.exit: a clean signal shutdown returns from run() (exit 0);
 * config failure, a failed startup jail/probe/provider bootstrap, or a
 * protocol-fatal poll/report rejects main() and the direct-run wrapper exits
 * non-zero.
 *
 * Batch 3 ordering contract (plan §2.2): the jail and the Claude probe run
 * BEFORE the HTTP client exists — a daemon that cannot isolate or cannot run
 * Claude never talks to the server (fail-closed). The probe therefore
 * provably happens before the first poll.
 *
 * Provider bootstrap (Issue #38 fix): the runner spawns Claude with
 * `--setting-sources ""`, so Claude cannot see the user-level provider
 * configuration itself. `resolveClaudeProviderEnv` converges exactly the
 * allow-listed provider/TLS/proxy fields of `<configDir>/settings.json` into
 * the runner's env source — after the (credential-free, raw-env) probe,
 * before the runner is constructed. Settings-derived values then ride the
 * existing buildAgentEnv allow-list + collectSecretValues + redactSecrets
 * pipeline; explicit launch-env values always win.
 */
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createMachineClient } from "./client.js";
import { resolveClaudeProviderEnv } from "./claude-provider-env.js";
import { createClaudeRunner, type ClaudeRunnerDeps } from "./claude-runner.js";
import { loadDaemonConfig, type DaemonConfig } from "./config.js";
import { createControlRoot, releaseControlRoot, type ControlRoot } from "./control-root.js";
import { machineIdentity } from "./identity.js";
import { createWorkdirJail, type WorkdirJail } from "./jail.js";
import { probeClaudeBinary, type ClaudeProbeResult } from "./probe-claude.js";
import type { AgentRunner } from "./runner.js";
import { createDaemonRuntime, type DaemonRuntime } from "./runtime.js";
import type { ProcessGroupLifecycleEvent } from "./subprocess.js";

/** Batch-2 startup seam: canonicalize + verify the isolation roots BEFORE
 *  any resource opens (fail-fast, fail-closed). */
export async function createStartupJail(config: DaemonConfig): Promise<WorkdirJail> {
  return await createWorkdirJail({
    allowedRoots: config.allowedRoots,
    // The factory mints an unpredictable per-start 0700 scratch root INSIDE
    // this base (round-1 P1) — never pass a predictable leaf directory.
    scratchBase: os.tmpdir(),
  });
}

/** Phase 4 Batch 2 startup seam (plan §2.1): the per-start private control
 *  root (0700) holding the static loopzhb wrapper — minted BEFORE the first
 *  poll, like the jail, so a daemon that cannot isolate its journal channel
 *  never talks to the server. */
export async function createStartupControlRoot(): Promise<ControlRoot> {
  return await createControlRoot(os.tmpdir());
}

/** The production Runner (batch 3 switch, plan §2.2): the sandboxed Claude
 *  adapter. The Fake Runner survives only as a test/loopback fixture. */
export const productionRunnerFactory: (deps: ClaudeRunnerDeps) => AgentRunner = (deps) => createClaudeRunner(deps);

/** The testable composition: config → startup jail → Claude probe → client →
 *  Claude Runner → runtime. Polls begin only after this resolves, so the
 *  probe provably precedes the first poll (plan §2.2). */
export interface PrepareDaemonOptions {
  /** Opt-in acceptance observer. It receives the exact identity pinned by
   *  the production probe, not a second test-side resolution. */
  onClaudeProbe?: (probe: ClaudeProbeResult) => void;
  /** Opt-in acceptance observer for each real Claude process group. */
  onClaudeProcessGroup?: (event: ProcessGroupLifecycleEvent) => void;
  /** Opt-in lifecycle observer (review STD-4): receives the minted control
   *  root so the composition root can release it at shutdown. On a startup
   *  failure AFTER the mint, prepareDaemon releases the root itself. */
  onControlRoot?: (root: ControlRoot) => void;
  /** Opt-in lifecycle observer for the owned per-start scratch root. */
  onJail?: (jail: WorkdirJail) => void;
  /** TEST-ONLY seam: observes the provider-bootstrapped env handed to the
   *  production runner. Production call sites never set it — the merged env
   *  carries settings-derived credentials and stays inside the composition. */
  onRunnerEnvSource?: (envSource: NodeJS.ProcessEnv) => void;
}

async function releasePerStartResources(
  controlRoot: ControlRoot | undefined,
  jail: WorkdirJail | undefined,
  log: (resource: "control root" | "scratch root", err: unknown) => void = () => {},
): Promise<void> {
  if (controlRoot !== undefined) await releaseControlRoot(controlRoot).catch((err) => log("control root", err));
  if (jail !== undefined) await jail.dispose().catch((err) => log("scratch root", err));
}

export async function prepareDaemon(
  config: DaemonConfig,
  envSource: NodeJS.ProcessEnv,
  options: PrepareDaemonOptions = {},
): Promise<DaemonRuntime> {
  let jail: WorkdirJail | undefined;
  let controlRoot: ControlRoot | undefined;
  try {
    jail = await createStartupJail(config);
    options.onJail?.(jail);
    controlRoot = await createStartupControlRoot();
    options.onControlRoot?.(controlRoot);
    const probe = await probeClaudeBinary(config.claudeBin, envSource);
    options.onClaudeProbe?.(probe);
    // Provider bootstrap (plan `codex-fix-claude-runner-plan` §4, Issue #38):
    // the runner spawns Claude with `--setting-sources ""`, so Claude never
    // loads the user-level settings itself — converge the allow-listed
    // provider/TLS/proxy fields from that settings file into the env ONCE,
    // here, after the probe and before the runner exists. The probe above
    // deliberately ran on the RAW envSource: its env is credential-free
    // (buildProbeEnv) and unchanged by this bootstrap. A bootstrap failure
    // propagates into the catch below — per-start roots released, no poll
    // loop ever created.
    const runnerEnvSource = resolveClaudeProviderEnv(envSource);
    options.onRunnerEnvSource?.(runnerEnvSource);
    const client = createMachineClient({
      baseUrl: config.serverUrl,
      machineCredential: config.machineCredential,
    });
    return createDaemonRuntime({
      client,
      runner: productionRunnerFactory({
        jail,
        claudeBin: config.claudeBin,
        timeoutMs: config.agentTimeoutMs,
        envSource: runnerEnvSource,
        controlRoot,
        // The probe-pinned binary identity: every run re-verifies it before
        // spawning (round-1 review P1).
        probedBinary: probe.binary,
        ...(options.onClaudeProcessGroup !== undefined ? { onProcessGroup: options.onClaudeProcessGroup } : {}),
      }),
      identity: machineIdentity(),
      pollMs: config.pollMs,
      machineCredential: config.machineCredential,
      log: (line) => console.log(line),
    });
  } catch (err) {
    // Startup failure AFTER the mint: the per-start control root must not
    // outlive a daemon that never started (review STD-4). A release failure
    // never masks the original error.
    await releasePerStartResources(controlRoot, jail);
    throw err;
  }
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

type ShutdownSignalListener = (signal: ShutdownSignal) => void;

export interface ShutdownSignalEvents {
  on(signal: ShutdownSignal, listener: ShutdownSignalListener): unknown;
  off(signal: ShutdownSignal, listener: ShutdownSignalListener): unknown;
}

/** Register the process-facing shutdown adapter and return its cleanup. The
 *  injectable event source keeps signal behavior testable without signalling
 *  the test runner process itself. */
export function registerShutdownSignals(
  ctl: AbortController,
  log: (line: string) => void = (line) => console.log(line),
  events: ShutdownSignalEvents = process,
): () => void {
  const shutdown: ShutdownSignalListener = (signal) => {
    log(`received ${signal} — stopping poll loop`);
    ctl.abort();
  };
  events.on("SIGINT", shutdown);
  events.on("SIGTERM", shutdown);
  return () => {
    events.off("SIGINT", shutdown);
    events.off("SIGTERM", shutdown);
  };
}

export async function main(): Promise<void> {
  const config = loadDaemonConfig(process.env);
  let controlRoot: ControlRoot | undefined;
  let jail: WorkdirJail | undefined;
  const runtime = await prepareDaemon(config, process.env, {
    onControlRoot: (root) => {
      controlRoot = root;
    },
    onJail: (created) => {
      jail = created;
    },
    ...(process.env.LOOPZHB_REAL_CLAUDE_E2E === "1"
      ? {
          onClaudeProbe: (probe: ClaudeProbeResult): void => {
            console.log(
              `loopzhb claude provenance ${JSON.stringify({
                resolvedPath: probe.binary.resolvedPath,
                version: probe.version,
                sha256: probe.binary.sha256,
              })}`,
            );
          },
          onClaudeProcessGroup: (event: ProcessGroupLifecycleEvent): void => {
            console.log(`loopzhb claude process-group ${JSON.stringify(event)}`);
          },
        }
      : {}),
  });

  const ctl = new AbortController();
  const unregisterShutdownSignals = registerShutdownSignals(ctl);

  try {
    // Startup log: URL and interval only — NEVER a credential.
    console.log(`loopzhb daemon polling ${config.serverUrl} every ${config.pollMs}ms`);
    await runtime.run(ctl.signal);
  } finally {
    unregisterShutdownSignals();
    // The per-start control root leaves with the daemon (review STD-4) —
    // normal signal shutdown AND a fatal runtime error alike. A release
    // failure is logged, never masks the run's outcome.
    await releasePerStartResources(controlRoot, jail, (resource, err) => {
      console.error(`${resource} release failed:`, err instanceof Error ? err.message : err);
    });
  }
}

/** True only when executed as `node dist/cli.js` — importing this module in
 *  tests must NOT boot anything. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("daemon stopped:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
