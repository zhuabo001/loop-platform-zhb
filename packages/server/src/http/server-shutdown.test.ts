/**
 * Slice 7 — the bounded listener shutdown (the manual OAuth smoke found that a
 * browser keep-alive socket kept `server.close()` pending, so `closeDb` and the
 * dataDir lock release never ran).
 *
 *  SD1  An idle keep-alive connection does not delay shutdown.
 *  SD2  A connection with an unfinished request is force-closed at the grace
 *       deadline: shutdown is BOUNDED, never dependent on the client.
 */
import { Agent, request } from "node:http";

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { waitForListening } from "../start.js";
import { closeHttpServer } from "./server-shutdown.js";

const servers = new Set<ServerType>();
const agents: Agent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers) {
    (server as ServerType & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
});

async function start(): Promise<{ server: ServerType; port: number }> {
  const app = new Hono();
  app.get("/", (c) => c.text("ok"));
  // A request that never completes: `closeIdleConnections` must NOT reap it,
  // so only the grace-deadline force-close can end the shutdown.
  app.get("/hang", () => new Promise<Response>(() => {}));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  servers.add(server);
  await waitForListening(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port };
}

describe("slice 7 SD: listener shutdown is bounded", () => {
  it("SD1: an IDLE keep-alive connection does not delay the close callback", async () => {
    const { server, port } = await start();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);

    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

    const started = Date.now();
    await closeHttpServer(server, { graceMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    servers.delete(server);
  });

  it("SD2: an ACTIVE request is force-closed at the grace deadline", async () => {
    const { server, port } = await start();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);

    const req = request({ host: "127.0.0.1", port, path: "/hang", agent });
    req.on("error", () => {});
    req.end();
    // Let the request reach the handler; it will never be answered.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    await closeHttpServer(server, { graceMs: 150 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_500);
    req.destroy();
    servers.delete(server);
  });
});
