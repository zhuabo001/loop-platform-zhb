/**
 * A real listening Server lifetime — TEST-ONLY (excluded from the build with
 * the rest of `src/testkit/**`).
 *
 * Slice 7 needs the production boot order, not an ad-hoc assembly:
 *
 *   bootstrapServer (lock → file DB → migrations → graph)
 *     → serve on 127.0.0.1:0
 *     → waitForListening
 *     → scheduler.start
 *
 * Shutdown is the production order too: scheduler drain → listener close →
 * closeDb (which releases the dataDir lock). A restart is `shutdown()` followed
 * by another `bootListeningServer` over the SAME dataDir.
 */
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";

import { closeDb } from "../db/index.js";
import { closeHttpServer } from "../http/server-shutdown.js";
import {
  bootstrapServer,
  waitForListening,
  type BootedServer,
  type BootstrapOverrides,
} from "../start.js";
import type { Clock } from "../time.js";
import { makeTestAuthConfig } from "./index.js";

export interface ListeningServer {
  booted: BootedServer;
  server: ServerType;
  baseUrl: string;
  port: number;
  shutdown(): Promise<void>;
}

export interface BootListeningOptions {
  dataDir: string;
  clock: Clock;
  cronFactory?: BootstrapOverrides["cronFactory"];
  githubFetch?: BootstrapOverrides["githubFetch"];
  githubTimeoutMs?: BootstrapOverrides["githubTimeoutMs"];
  /** Mirror `main()`: start the scheduler after the listener is bound. */
  startScheduler?: boolean;
}

export async function bootListeningServer(options: BootListeningOptions): Promise<ListeningServer> {
  const booted = await bootstrapServer(
    { auth: makeTestAuthConfig(), host: "127.0.0.1", port: 0, dataDir: options.dataDir },
    {
      clock: options.clock,
      ...(options.cronFactory !== undefined ? { cronFactory: options.cronFactory } : {}),
      ...(options.githubFetch !== undefined ? { githubFetch: options.githubFetch } : {}),
      ...(options.githubTimeoutMs !== undefined ? { githubTimeoutMs: options.githubTimeoutMs } : {}),
    },
  );

  let server: ServerType;
  try {
    server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
    await waitForListening(server);
  } catch (err) {
    await booted.scheduler.stopAndDrain().catch(() => {});
    await closeDb(booted.handle).catch(() => {});
    throw err;
  }

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  let stopped = false;

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await booted.scheduler.stopAndDrain();
    } finally {
      try {
        await closeHttpServer(server, { graceMs: 2_000 });
      } finally {
        await closeDb(booted.handle);
      }
    }
  };

  if (options.startScheduler !== false) {
    try {
      await booted.scheduler.start();
    } catch (err) {
      await shutdown().catch(() => {});
      throw err;
    }
  }

  return { booted, server, baseUrl: `http://127.0.0.1:${port}`, port, shutdown };
}
