/**
 * THE daemon composition root (plan §1/§4): validated config → Machine client
 * → Fake Runner → runtime foreground loop, with ONE AbortController fanning
 * SIGINT/SIGTERM out to the poll sleep, in-flight HTTP and report retries.
 * The core never calls process.exit: a clean signal shutdown returns from
 * run() (exit 0); config failure or a protocol-fatal poll/report rejects
 * main() and the direct-run wrapper exits non-zero.
 */
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createMachineClient } from "./client.js";
import { loadDaemonConfig, type DaemonConfig } from "./config.js";
import { machineIdentity } from "./identity.js";
import { createWorkdirJail, type WorkdirJail } from "./jail.js";
import { createFakeRunner, type AgentRunner } from "./runner.js";
import { createDaemonRuntime } from "./runtime.js";

/** Batch-2 startup seam: canonicalize + verify the isolation roots BEFORE
 *  any resource opens (fail-fast, fail-closed). The returned jail is NOT
 *  wired to a Runner yet — batch 3's sandboxed adapter receives it. */
export async function createStartupJail(config: DaemonConfig): Promise<WorkdirJail> {
  return await createWorkdirJail({
    allowedRoots: config.allowedRoots,
    // The factory mints an unpredictable per-start 0700 scratch root INSIDE
    // this base (round-1 P1) — never pass a predictable leaf directory.
    scratchBase: os.tmpdir(),
  });
}

/** The production Runner seam stays the Fake Runner for ALL of batch 2: no
 *  Delivery ever spawns a real subprocess until batch 3's sandboxed adapter
 *  lands (plan §2.5, pin I6). */
export const productionRunnerFactory: () => AgentRunner = createFakeRunner;

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
  // Fail fast on bad isolation roots BEFORE the first poll: a misconfigured
  // daemon never talks to the server (fail-closed, plan §2.1).
  await createStartupJail(config);
  const client = createMachineClient({
    baseUrl: config.serverUrl,
    machineCredential: config.machineCredential,
  });
  const runtime = createDaemonRuntime({
    client,
    runner: productionRunnerFactory(),
    identity: machineIdentity(),
    pollMs: config.pollMs,
    machineCredential: config.machineCredential,
    log: (line) => console.log(line),
  });

  const ctl = new AbortController();
  const unregisterShutdownSignals = registerShutdownSignals(ctl);

  try {
    // Startup log: URL and interval only — NEVER a credential.
    console.log(`loopzhb daemon polling ${config.serverUrl} every ${config.pollMs}ms`);
    await runtime.run(ctl.signal);
  } finally {
    unregisterShutdownSignals();
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
