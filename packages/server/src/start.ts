/**
 * THE production composition root (plan §HTTP, A-11/A-12). This is the only
 * place the real graph is wired: validated config → create the data dir →
 * open+migrate the FILE-BACKED database (production never boots in-memory —
 * the no-dataDir factory is a test fixture) → production coordinator → Hono
 * app → @hono/node-server listener. Boot carries NO poll/report business
 * logic, and the start script runs the BUILT artifact (`node
 * --enable-source-maps dist/start.js`) — no implicit build lifecycle.
 *
 * Shutdown is idempotent and ordered: HTTP server first, then the DB.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { serve, type ServerType } from "@hono/node-server";

import { createLoopAdmin, newUuidLoopId } from "./admin/index.js";
import { createRunCoordinator, mintRunCredential, newUuidRunId, type RunCoordinator } from "./coordinator/index.js";
import { loadServerConfig, unauthenticatedExposureWarning, type ServerConfig } from "./config.js";
import { closeDb, openMigratedDb, type DbHandle } from "./db/index.js";
import { createServerApp } from "./http/app.js";
import { systemClock } from "./time.js";

export interface BootedServer {
  app: ReturnType<typeof createServerApp>;
  coordinator: RunCoordinator;
  handle: DbHandle;
}

/**
 * Everything except the listener — the testable core of boot. Creates the
 * data dir, opens+migrates the file-backed DB at `<dataDir>/pgdata`, and
 * wires the production coordinator (systemClock, UUID run ids, `rk_` mint).
 * Throws if the data dir cannot be created — boot fails fast, before listen.
 */
export async function bootstrapServer(config: ServerConfig): Promise<BootedServer> {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const handle = await openMigratedDb({ dataDir: config.dataDir });
  const coordinator = createRunCoordinator({
    db: handle.db,
    clock: systemClock,
    newRunId: newUuidRunId,
    mintRunCredential,
  });
  const admin = createLoopAdmin({ db: handle.db, clock: systemClock, newLoopId: newUuidLoopId });
  return { app: createServerApp(coordinator, admin), coordinator, handle };
}

export async function main(): Promise<void> {
  const config = loadServerConfig(process.env, os.homedir(), process.cwd());
  const warning = unauthenticatedExposureWarning(config.host);
  if (warning) console.warn(warning);

  const { app, handle } = await bootstrapServer(config);
  const server: ServerType = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  try {
    // serve() returns BEFORE listen completes — EADDRINUSE & friends arrive
    // via the async error event. Await the outcome; on failure run the SAME
    // ordered cleanup as shutdown (HTTP first, then DB) and rethrow so boot
    // exits non-zero instead of falsely reporting ready (review #8).
    await waitForListening(server);
  } catch (err) {
    server.close();
    await closeDb(handle).catch(() => {});
    throw err;
  }
  // Startup log: host/port/dataDir only — NEVER a secret. Logged only once
  // the listener is actually bound.
  console.log(`loopzhb server listening on http://${config.host}:${config.port} (dataDir: ${config.dataDir})`);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return; // idempotent across SIGINT+SIGTERM races
    closing = true;
    console.log(`received ${signal} — closing HTTP server, then DB`);
    server.close(async () => {
      await closeDb(handle).catch(() => {});
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Resolve once the server is bound; reject on the first listen error. The
 *  LOSER listener is removed on settle — a leftover once-listener would keep
 *  consuming later runtime 'error' events into an already-settled promise,
 *  silently swallowing them (Node treats any 'error' listener as handled). */
export function waitForListening(server: ServerType): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

/** True only when executed as `node dist/start.js` — importing this module in
 *  tests must NOT boot anything. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("boot failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
