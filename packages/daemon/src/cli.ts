/**
 * THE daemon composition root (plan §1/§4): validated config → Machine client
 * → Fake Runner → runtime foreground loop, with ONE AbortController fanning
 * SIGINT/SIGTERM out to the poll sleep, in-flight HTTP and report retries.
 * The core never calls process.exit: a clean signal shutdown returns from
 * run() (exit 0); config failure or a protocol-fatal poll/report rejects
 * main() and the direct-run wrapper exits non-zero.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createMachineClient } from "./client.js";
import { loadDaemonConfig } from "./config.js";
import { machineIdentity } from "./identity.js";
import { createFakeRunner } from "./runner.js";
import { createDaemonRuntime } from "./runtime.js";

export async function main(): Promise<void> {
  const config = loadDaemonConfig(process.env);
  const client = createMachineClient({
    baseUrl: config.serverUrl,
    machineCredential: config.machineCredential,
  });
  const runtime = createDaemonRuntime({
    client,
    runner: createFakeRunner(),
    identity: machineIdentity(),
    pollMs: config.pollMs,
    machineCredential: config.machineCredential,
    log: (line) => console.log(line),
  });

  const ctl = new AbortController();
  const shutdown = (signal: string): void => {
    console.log(`received ${signal} — stopping poll loop`);
    ctl.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Startup log: URL and interval only — NEVER a credential.
  console.log(`loopzhb daemon polling ${config.serverUrl} every ${config.pollMs}ms`);
  await runtime.run(ctl.signal);
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
