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
import { createScheduler, type CronFactory, type Scheduler } from "./scheduler/index.js";
import { productionCronFactory } from "./scheduler/croner-factory.js";
import { armInactivitySweep, createInactivitySweep, type InactivitySweep } from "./sweep/index.js";
import { systemClock, type Clock } from "./time.js";

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
 * INTERNAL-ONLY test seam (Phase 3 Batch 3 plan §2.4): an injected Clock
 * replaces EVERY systemClock use in this composition root (coordinator,
 * admin, ownerControl, sweep, scheduler AND the HTTP app), so a FakeClock E2E
 * can never split occurrence/watermark time from run/lease/progress time.
 * Production callers pass NO overrides and get systemClock +
 * productionCronFactory exactly as before.
 */
export interface BootstrapOverrides {
  clock?: Clock;
  cronFactory?: CronFactory;
}

/**
 * Everything except the listener — the testable core of boot. Creates the
 * data dir, opens+migrates the file-backed DB at `<dataDir>/pgdata`, and
 * wires the production coordinator (systemClock, UUID run ids, `rk_` mint)
 * and the production sweep (default 20min timeout). Throws if the data dir
 * cannot be created — boot fails fast, before listen.
 *
 * DB-handle ownership: a failure INSIDE bootstrap closes the handle here; once
 * the BootedServer is returned, the caller owns the handle exactly once.
 *
 * Phase 3 Batch 2: Creates Scheduler with production Croner factory.
 */
export async function bootstrapServer(
  config: ServerConfig,
  overrides: BootstrapOverrides = {},
): Promise<BootedServer> {
  const clock = overrides.clock ?? systemClock;
  const cronFactory = overrides.cronFactory ?? productionCronFactory;
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const handle = await openMigratedDb({ dataDir: config.dataDir });
  try {
    const coordinator = createRunCoordinator({
      db: handle.db,
      clock,
      newRunId: newUuidRunId,
      mintRunCredential,
    });
    const admin = createLoopAdmin({ db: handle.db, clock, newLoopId: newUuidLoopId });
    const ownerControl = createOwnerControl({ db: handle.db, clock });
    const sweep = createInactivitySweep({ db: handle.db, clock });
    const scheduler = createScheduler({
      db: handle.db,
      coordinator,
      clock,
      cronFactory,
    });
    return {
      app: createServerApp(coordinator, admin, ownerControl, handle.db, clock, (loop) =>
        scheduler.reconcile(loop),
      ),
      coordinator,
      sweep,
      scheduler,
      handle,
    };
  } catch (err) {
    // Internal wiring failure after the DB opened: close the handle HERE —
    // the caller never received it and must not double-close.
    await closeDb(handle).catch(() => {});
    throw err;
  }
}

export async function main(): Promise<void> {
  const config = loadServerConfig(process.env, os.homedir(), process.cwd());
  const warning = unauthenticatedExposureWarning(config.host);
  if (warning) console.warn(warning);

  // The outer catch is the SINGLE owner of post-bootstrap DB cleanup
  // (bootstrapServer owns its own internal failures).
  let handle: DbHandle | undefined;
  try {
    const result = await bootstrapServer(config);
    handle = result.handle;
    const { app, sweep, scheduler } = result;

    const server: ServerType = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
    // serve() returns BEFORE listen completes — EADDRINUSE & friends arrive
    // via the async error event. Await the outcome; on failure the outer catch
    // runs the DB cleanup so boot exits non-zero instead of falsely reporting
    // ready (review #8). Nothing is bound on a listen failure, so no drain.
    await waitForListening(server);

    // Phase 3 Batch 2: Start scheduler AFTER listener is bound (plan §2 fixed
    // startup order: DB → listener bind → scheduler start → sweep arm → ready).
    // On scan failure the helper drains the scheduler AND the listener before
    // closing the DB through the composition-owned callback.
    await startSchedulerOrFailBootWithDatabase(scheduler, server, handle!, () => {
      handle = undefined;
    });

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
 * the server must NOT report ready without scheduling. Cleanup follows the
 * fixed shutdown order — drain the scheduler, then drain the LISTENER (await
 * in-flight requests; only then may the caller close the DB), and rethrow a
 * fixed-message error so the entry layer never prints the scan's original
 * exception (DB internals must not reach logs). Extracted from main() so tests
 * can drive the failure path without binding a port.
 */
export interface FailedBootCleanupOptions {
  /** Production uses a bounded drain so a stuck connection cannot hang boot. */
  closeTimeoutMs?: number;
  /** Composition-owned DB close, invoked only after the listener is drained
   *  or force-closed. Tests inject this boundary to pin the ordering. */
  closeDatabase?: () => Promise<void>;
}

/** Production composition for the scheduler boot gate. Keeping the real
 * closeDb wiring in this exported seam lets lifecycle tests observe the actual
 * database handle rather than a callback-shaped stand-in. */
export async function startSchedulerOrFailBootWithDatabase(
  scheduler: Scheduler,
  server: ServerType,
  handle: DbHandle,
  onDatabaseClosed?: () => void,
): Promise<void> {
  await startSchedulerOrFailBoot(scheduler, server, {
    closeDatabase: async () => {
      await closeDb(handle);
      onDatabaseClosed?.();
    },
  });
}

export async function startSchedulerOrFailBoot(
  scheduler: Scheduler,
  server: ServerType,
  cleanup: FailedBootCleanupOptions = {},
): Promise<void> {
  try {
    await scheduler.start();
  } catch (err) {
    console.error("[scheduler] startup scan failed — draining scheduler and listener before DB close");
    await scheduler.stopAndDrain().catch(() => {});
    await closeServer(server, cleanup.closeTimeoutMs).catch(() => {});
    await cleanup.closeDatabase?.().catch(() => {});
    throw new Error("scheduler startup scan failed", { cause: err });
  }
}

/** Awaitable http.Server close: resolves once the listener has drained its
 *  in-flight connections. A bounded fallback force-closes connections so a
 *  callback that never fires cannot keep failed boot alive forever. */
function closeServer(server: ServerType, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const forceClose = (): void => {
      const forceClosable = server as ServerType & {
        closeIdleConnections?: () => void;
        closeAllConnections?: () => void;
      };
      forceClosable.closeIdleConnections?.();
      forceClosable.closeAllConnections?.();
    };
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => {
      try {
        forceClose();
      } catch {
        // Best-effort cleanup; failed boot must still progress to DB close.
      } finally {
        settle();
      }
    }, timeoutMs);

    try {
      server.close((err) => {
        if (!err) {
          settle();
          return;
        }
        try {
          forceClose();
        } catch {
          // Preserve the listener close error as the primary failure.
        } finally {
          settle(err);
        }
      });
    } catch (err) {
      try {
        forceClose();
      } catch {
        // Preserve the listener close error as the primary failure.
      } finally {
        settle(err instanceof Error ? err : new Error("server close failed"));
      }
    }
  });
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
