/**
 * THE production composition root (plan §HTTP, A-11/A-12). This is the only
 * place the real graph is wired: validated config → create the data dir →
 * open+migrate the FILE-BACKED database (production never boots in-memory —
 * the no-dataDir factory is a test fixture) → production coordinator → Hono
 * app → @hono/node-server listener. Boot carries NO poll/report business
 * logic, and the start script runs the BUILT artifact (`node
 * --enable-source-maps dist/start.js`) — no implicit build lifecycle.
 *
 * Shutdown is idempotent and ordered: the sweep timer blocks new ticks and
 * drains its in-flight pass, then the HTTP server closes, then the DB.
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
import { createOwnerControl } from "./owner/index.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";
import { productionCronFactory } from "./scheduler/croner-factory.js";
import { armInactivitySweep, createInactivitySweep, type InactivitySweep } from "./sweep/index.js";
import { systemClock } from "./time.js";

export interface BootedServer {
  app: ReturnType<typeof createServerApp>;
  coordinator: RunCoordinator;
  /** The sweep INSTANCE (not yet ticking — the timer arms only after the
   *  listener binds, in main). Tests drive `sweep.runOnce()` directly, which
   *  is exactly the pass the armed timer fires. */
  sweep: InactivitySweep;
  /** Phase 3 Batch 2: Scheduler instance (not yet started). */
  scheduler: Scheduler;
  handle: DbHandle;
}

/**
 * Everything except the listener — the testable core of boot. Creates the
 * data dir, opens+migrates the file-backed DB at `<dataDir>/pgdata`, and
 * wires the production coordinator (systemClock, UUID run ids, `rk_` mint)
 * and the production sweep (default 20min timeout). Throws if the data dir
 * cannot be created — boot fails fast, before listen.
 *
 * Phase 3 Batch 2: Creates Scheduler with production Croner factory.
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
  const ownerControl = createOwnerControl({ db: handle.db, clock: systemClock });
  const sweep = createInactivitySweep({ db: handle.db, clock: systemClock });
  const scheduler = createScheduler({
    db: handle.db,
    coordinator,
    clock: systemClock,
    cronFactory: productionCronFactory,
  });
  return {
    app: createServerApp(coordinator, admin, ownerControl, handle.db, systemClock, scheduler),
    coordinator,
    sweep,
    scheduler,
    handle,
  };
}

export async function main(): Promise<void> {
  const config = loadServerConfig(process.env, os.homedir(), process.cwd());
  const warning = unauthenticatedExposureWarning(config.host);
  if (warning) console.warn(warning);

  let handle: DbHandle | undefined;
  try {
    const result = await bootstrapServer(config);
    handle = result.handle;
    const { app, sweep, scheduler } = result;

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

    // Phase 3 Batch 2: Start scheduler AFTER listener is bound (plan §2 fixed
    // startup order: DB → listener bind → scheduler start → sweep arm → ready).
    await startSchedulerOrFailBoot(scheduler, server);

    // The sweep arms ONLY after the listener is actually bound (plan §1): one
    // immediate async pass, then the unref'd interval.
    const sweepTimer = armInactivitySweep(sweep);
    // Startup log: host/port/dataDir only — NEVER a secret. Logged only once
    // the listener is actually bound.
    console.log(`loopzhb server listening on http://${config.host}:${config.port} (dataDir: ${config.dataDir})`);

    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return; // idempotent across SIGINT+SIGTERM races
      closing = true;
      console.log(`received ${signal} — draining scheduler, sweep, closing HTTP server, then DB`);
      // Ordered (plan §1 + Phase 3 Batch 2): stop scheduler (drain callbacks) →
      // block new sweep ticks and DRAIN the in-flight pass → HTTP → DB.
      void scheduler.stopAndDrain().catch(() => {}).then(() => {
        void sweepTimer.stopAndDrain().catch(() => {}).then(() => {
          server.close(async () => {
            await closeDb(handle!).catch(() => {});
            process.exit(0);
          });
        });
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    // Clean up DB handle if bootstrapServer failed
    if (handle) {
      await closeDb(handle).catch(() => {});
    }
    throw err;
  }
}

/**
 * Scheduler start is a BOOT gate (Batch 2 plan §2): a scan-level failure means
 * the server must NOT report ready without scheduling. Drain the scheduler,
 * close the listener, and rethrow — the caller's catch closes the DB and boot
 * exits non-zero. Extracted from main() so tests can drive the failure path
 * without binding a port.
 */
export async function startSchedulerOrFailBoot(scheduler: Scheduler, server: ServerType): Promise<void> {
  try {
    await scheduler.start();
  } catch (err) {
    console.error("[scheduler] startup scan failed — closing listener and DB");
    await scheduler.stopAndDrain().catch(() => {});
    server.close();
    throw err;
  }
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
