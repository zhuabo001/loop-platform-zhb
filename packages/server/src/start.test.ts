/**
 * Boot composition (A-11/A-12) — tested WITHOUT opening a real port: the
 * listener stays in main(), tests drive bootstrapServer + app.request.
 *
 * The pins that matter:
 *  - production boot ALWAYS opens a file-backed DB (never in-memory);
 *  - restart durability (ADR-001 T4's boot-level face): machines, runs and
 *    ACTIVE LEASES survive a close/reopen — a run claimed before the restart
 *    can still report after it;
 *  - a data dir that can't be created fails boot fast;
 *  - the production mint issues shape-valid `rk_` credentials.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { isRunTokenShape, pollResponseSchema } from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { mintRunCredential } from "./coordinator/index.js";
import { closeDb, type DbHandle } from "./db/index.js";
import { loops } from "./db/schema.js";
import { bootstrapServer, main, startSchedulerOrFailBoot, waitForListening, type BootedServer } from "./start.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let seq = 0;
async function tmpDataDir(): Promise<string> {
  seq += 1;
  return mkdtemp(path.join(tmpdir(), `loopzhb-boot-${process.pid}-${seq}-`));
}

async function boot(dataDir: string): Promise<BootedServer> {
  const b = await bootstrapServer({ host: "127.0.0.1", port: 3000, dataDir });
  handles.push(b.handle);
  return b;
}

function poll(app: BootedServer["app"], token: string, body: unknown = {}) {
  return app.request("/api/machine/poll", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("bootstrapServer", () => {
  it("opens a FILE-BACKED database (never in-memory) and serves the machine routes", async () => {
    const dir = await tmpDataDir();
    await rm(dir, { recursive: true, force: true }); // prove boot creates it
    const { app, handle } = await boot(dir);

    expect(handle.dataDir).toBe(dir); // file-backed, not the memory fixture
    const res = await poll(app, "dk_boot_machine", { host: "boot-host" });
    expect(res.status).toBe(200);
    expect(pollResponseSchema.parse(await res.json())).toEqual({ deliveries: [] });
  });

  it("fails fast when the data dir cannot be created", async () => {
    const dir = await tmpDataDir();
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "a file, not a dir");
    await expect(bootstrapServer({ host: "127.0.0.1", port: 3000, dataDir: path.join(blocker, "sub") })).rejects.toThrow();
  });

  it("fails fast AND closes the DB when the port is already taken (review #8)", async () => {
    const dir = await tmpDataDir();
    // Occupy a real port first.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;

    process.env.LOOPZHB_PORT = String(port);
    process.env.LOOPZHB_DATA_DIR = dir;
    try {
      await expect(main()).rejects.toThrow(/EADDRINUSE|address already in use/i);
    } finally {
      delete process.env.LOOPZHB_PORT;
      delete process.env.LOOPZHB_DATA_DIR;
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    // The failed boot CLOSED its DB handle: a fresh bootstrap on the same
    // dataDir acquires the PGlite dir lock without contention.
    const second = await boot(dir);
    expect(second.handle.dataDir).toBe(dir);
  });

  it("scheduler scan failure fails boot: drains scheduler, closes listener, rethrows (Batch 2 plan §2)", async () => {
    const dir = await tmpDataDir();
    const b = await bootstrapServer({ host: "127.0.0.1", port: 3000, dataDir: dir });
    // Break the scheduler's startup scan by closing the DB underneath it.
    // (Not via boot() — we close this handle ourselves.)
    await closeDb(b.handle);

    let listenerClosed = false;
    const fakeServer = {
      close: () => {
        listenerClosed = true;
      },
    } as unknown as ServerType;

    // A scan-level failure must FAIL BOOT — never report ready without scheduling.
    await expect(startSchedulerOrFailBoot(b.scheduler, fakeServer)).rejects.toThrow();
    expect(listenerClosed).toBe(true);

    // The failed boot released its resources: a fresh bootstrap on the same
    // dataDir acquires the PGlite dir lock without contention.
    const second = await boot(dir);
    expect(second.handle.dataDir).toBe(dir);
  });

  it("restart durability: machine, run and ACTIVE LEASE survive close/reopen — a pre-restart claim still reports (T4)", async () => {
    const dir = await tmpDataDir();
    // Boot 1: enroll, seed a loop, enqueue + claim a run.
    const first = await boot(dir);
    await poll(first.app, "dk_boot_machine");
    await first.handle.db.insert(loops).values({
      id: "loop-1",
      machineId: machineIdFromToken("dk_boot_machine"),
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await first.coordinator.enqueueExecRun("loop-1")).toMatchObject({ enqueued: true });
    const claimed = pollResponseSchema.parse(await (await poll(first.app, "dk_boot_machine")).json());
    expect(claimed.deliveries).toHaveLength(1);
    const runToken = claimed.deliveries[0]!.runToken;
    await closeDb(first.handle);
    handles.splice(handles.indexOf(first.handle), 1);

    // Boot 2 (same dataDir): everything persisted; the pre-restart credential
    // still finalizes its run (durable lease, ADR-001 T4).
    const second = await boot(dir);
    const report = await second.app.request("/api/machine/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runToken}` },
      body: JSON.stringify({ ok: true, message: "across the restart" }),
    });
    expect(report.status).toBe(200);
    expect(await report.json()).toEqual({ ok: true });
    // …and the now-consumed credential is dead.
    const again = await second.app.request("/api/machine/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runToken}` },
      body: JSON.stringify({ ok: true }),
    });
    expect(again.status).toBe(401);
  });
});

describe("waitForListening (二次审核 P2)", () => {
  it("removes the losing listener on success — a later runtime error is NOT swallowed", async () => {
    const srv = serve({ fetch: () => new Response("ok"), port: 0, hostname: "127.0.0.1" });
    try {
      await waitForListening(srv);
      expect(srv.listenerCount("error")).toBe(0);
      // With the stale once-listener gone, an emitted 'error' has NO handler
      // and surfaces (Node throws) instead of being consumed into a settled
      // promise.
      expect(() => srv.emit("error", new Error("boom"))).toThrow("boom");
    } finally {
      srv.close();
    }
  });

  it("removes the listening listener on failure", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const srv = serve({ fetch: () => new Response("ok"), port, hostname: "127.0.0.1" });
    try {
      // hono's serve() registers its own internal listeners — the hygiene
      // check is that waitForListening adds NOTHING that survives settle.
      const before = srv.listenerCount("listening");
      await expect(waitForListening(srv)).rejects.toThrow();
      expect(srv.listenerCount("listening")).toBe(before);
    } finally {
      srv.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("production mint", () => {
  it("mints shape-valid rk_ credentials, unique per call", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => mintRunCredential()));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(isRunTokenShape(t)).toBe(true);
  });
});
