/**
 * Phase 5 Batch 2 slice 8 — fault-integration acceptance (plan §3 AI1–AI7).
 * The FIRST harness to combine ALL of: a REAL 127.0.0.1 listener, file-backed
 * PGlite (<dataDir>/pgdata), the production local BlobStore (<dataDir>/blobs),
 * a production-shaped daemon — the cli.ts composition mirrored field by field
 * (ONE shared sync client feeding BOTH the watch manager and the run-final
 * sync) with exactly two substitutions (the Fake Runner for the Claude
 * runner, and a recording/rewriting fetch dial) — and REAL chokidar watchers
 * over real temp artifact roots.
 *
 * The dial owns the socket story:
 *  - `offline`  — a network outage: the request never leaves the daemon;
 *  - `dropNext` — a lost response: the request REALLY reaches the server and
 *    is applied, then the client sees a network error (the real-HTTP version
 *    of the fake server's throw_after_apply — the semantic cross-check the
 *    fake's header defers to this slice);
 *  - `rebind`   — a server restart: the daemon stack survives, only the
 *    origin moves to the new listener.
 *
 * A server restart follows the production order (scheduler drain → listener
 * close → DB close) and boots again over the SAME dataDir (the restart-e2e
 * precedent); a daemon restart drains the watch manager (production exit)
 * and rebuilds the whole stack (the hash cache is memory — AS6's model).
 * The runtime is driven by pollOnce(), so the 60 s reconcile tick (started
 * only by runtime.run()) never fires — convergence is event-driven and every
 * wait is deadline-bounded, never wall-clock (the bounded quiet windows that
 * assert ABSENCE follow the slice-5 integration precedent).
 *
 * The daemon's public index deliberately keeps the artifact modules off its
 * surface (AD4), so this file deep-imports the BUILT dist — the same
 * "verify what ships" convention as the slice-6/7 E2Es.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
import {
  artifactDiffResponseSchema,
  createLoopResponseSchema,
  loopArtifactsResponseSchema,
  triggerRunResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

// eslint-disable-next-line no-restricted-imports -- slice-8 E2E: drive the BUILT daemon modules (AD4 keeps them off the public index)
import { createArtifactTransport } from "../../daemon/dist/artifact-client.js";
// eslint-disable-next-line no-restricted-imports
import { createFinalArtifactSync } from "../../daemon/dist/artifact-final-sync.js";
// eslint-disable-next-line no-restricted-imports
import { createArtifactHashCache } from "../../daemon/dist/artifact-hash-cache.js";
// eslint-disable-next-line no-restricted-imports
import { createArtifactSyncClient } from "../../daemon/dist/artifact-sync.js";
// eslint-disable-next-line no-restricted-imports
import { createArtifactWatchManager } from "../../daemon/dist/artifact-watch-manager.js";
// eslint-disable-next-line no-restricted-imports
import { createChokidarWatcher, type ArtifactWatcherFactory } from "../../daemon/dist/artifact-watcher.js";

import { closeDb } from "./db/index.js";
import { artifactManifests, loops, runs } from "./db/schema.js";
import { bootstrapServer, waitForListening, type BootedServer } from "./start.js";
import { FakeClock, FakeCronFactory } from "./testkit/index.js";

const TOKEN = "dk_slice8_e2e_machine";
const MACHINE_ID = machineIdFromToken(TOKEN);
const T0 = new Date("2026-08-27T09:00:00.000Z");
const DEADLINE_MS = 20_000;
/** Absence windows: ~5× the production 250 ms merge window (slice-5 posture). */
const QUIET_MS = 1_300;

// ---------------------------------------------------------------------------
// Teardown tracking
// ---------------------------------------------------------------------------

interface RunningServer extends BootedServer {
  server: ServerType;
  baseUrl: string;
}

const runningServers = new Set<RunningServer>();
const dirs: string[] = [];
/** A watcher tracked at the seam. `closing` marks that close() was CALLED;
 *  `closed` flips ONLY after the inner close has PHYSICALLY completed — a
 *  rejected or never-finished close leaves the pair `true/false`, which the
 *  afterEach invariant turns red (#114: never claim a close before it landed). */
interface TrackedWatcher {
  root: string;
  closing: boolean;
  closed: boolean;
}
/** Event-order log: a swap must close-complete the old watcher BEFORE the
 *  successor subscribes (AS7's fixed order — the manager's admission awaits
 *  the retained predecessor close before it calls the factory). */
type WatchEvent = { kind: "subscribed" | "close-completed"; root: string };
/** Every watcher ever created by any stack; afterEach asserts all closed
 *  (the handle-leak invariant, asserted at the seam — never OS fd counts). */
const allTrackedWatchers: TrackedWatcher[] = [];
const drainables: Array<{ drained: boolean; drain(ms: number): Promise<{ settled: boolean }> }> = [];

afterEach(async () => {
  // Cleanup must never mask verification: drain/shutdown errors and un-settled
  // drains are COLLECTED and asserted — not swallowed — and the leak invariant
  // still runs on the tracked entries afterwards.
  const errors: unknown[] = [];
  const drainResults = await Promise.all(
    drainables.splice(0).map(async (d) => {
      try {
        return await d.drain(2_000);
      } catch (err) {
        errors.push(err);
        return { settled: false };
      }
    }),
  );
  await Promise.all([...runningServers].map((rs) => shutdown(rs).catch((err: unknown) => errors.push(err))));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  const watchers = allTrackedWatchers.splice(0);
  expect(errors).toEqual([]);
  expect(drainResults.every((r) => r.settled)).toBe(true);
  expect(watchers.every((w) => w.closing && w.closed)).toBe(true);
});

// ---------------------------------------------------------------------------
// Server lifetime — the restart-e2e production-order precedent.
// ---------------------------------------------------------------------------

async function closeListener(server: ServerType): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Production shutdown order: scheduler drain → listener close → DB close. */
async function shutdown(rs: RunningServer): Promise<void> {
  runningServers.delete(rs);
  try {
    await rs.scheduler.stopAndDrain();
  } finally {
    try {
      await closeListener(rs.server);
    } finally {
      await closeDb(rs.handle);
    }
  }
}

/** One server lifetime — production boot order (listener bound BEFORE the
 *  scheduler starts), FakeClock + FakeCronFactory through the internal
 *  override seam so nothing fires autonomously. */
async function bootServer(dataDir: string, clock: FakeClock): Promise<RunningServer> {
  const cronFactory = new FakeCronFactory();
  const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir }, { clock, cronFactory });
  const server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
  try {
    await waitForListening(server);
  } catch (err) {
    await closeListener(server).catch(() => {});
    await booted.scheduler.stopAndDrain().catch(() => {});
    await closeDb(booted.handle).catch(() => {});
    throw err;
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const rs: RunningServer = { ...booted, server, baseUrl: `http://127.0.0.1:${port}` };
  runningServers.add(rs);
  try {
    await rs.scheduler.start();
    return rs;
  } catch (err) {
    await shutdown(rs).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The dial: a recording/rewriting fetch shared by BOTH daemon clients.
// ---------------------------------------------------------------------------

interface DialCall {
  method: string;
  /** path + query, origin already stripped. */
  path: string;
  /** JSON request bodies (blob PUT bytes stay unrecorded). */
  requestBody?: string;
  /** The PUT session header, when present. */
  syncId?: string;
  status?: number;
  /** JSON response bodies — captured BEFORE a drop throws the response away. */
  responseBody?: string;
  thrown?: true;
}

type DialMatcher = (call: { method: string; path: string }) => boolean;

interface Dial {
  fetchImpl: typeof fetch;
  calls: DialCall[];
  offline: boolean;
  /** One-shot: the next matching request REALLY reaches the server, then the
   *  client sees a network error (the response is lost after apply). */
  dropNext(match: DialMatcher): void;
  /** One-shot, PRE-forward: runs before the server evaluates the request
   *  (the AI5(d) clock advance must land before the commit is judged). */
  hookNext(match: DialMatcher, hook: () => void | Promise<void>): void;
  rebind(baseUrl: string): void;
  artifactCalls(): DialCall[];
  thrownAttempts(): DialCall[];
}

const isPrepare: DialMatcher = (c) => c.method === "POST" && c.path === "/api/machine/sync";
const isPut: DialMatcher = (c) => c.method === "PUT" && c.path.startsWith("/api/machine/blob/");
const isCommit: DialMatcher = (c) => c.method === "POST" && /^\/api\/machine\/sync\/[^/]+\/commit$/.test(c.path);

function isArtifactPath(path: string): boolean {
  return (
    path.startsWith("/api/machine/sync") ||
    path.startsWith("/api/machine/blob/") ||
    path.includes("/artifact-sync-error") ||
    /^\/api\/machine\/loops\/[^/]+\/artifacts/.test(path)
  );
}

function makeDial(baseUrl: string): Dial {
  let current = baseUrl;
  const calls: DialCall[] = [];
  const drops: Array<{ match: DialMatcher; used: boolean }> = [];
  const hooks: Array<{ match: DialMatcher; hook: () => void | Promise<void>; used: boolean }> = [];
  const dial: Dial = {
    calls,
    offline: false,
    dropNext(match) {
      drops.push({ match, used: false });
    },
    hookNext(match, hook) {
      hooks.push({ match, hook, used: false });
    },
    rebind(baseUrl: string) {
      current = baseUrl;
    },
    artifactCalls: () => calls.filter((c) => isArtifactPath(c.path)),
    thrownAttempts: () => calls.filter((c) => c.thrown === true),
    fetchImpl: undefined as unknown as typeof fetch,
  };
  dial.fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const call: DialCall = { method, path: `${url.pathname}${url.search}` };
    if (typeof init?.body === "string") call.requestBody = init.body;
    const headers = init?.headers;
    if (headers !== undefined && !Array.isArray(headers) && !(headers instanceof Headers)) {
      const syncId = (headers as Record<string, string>)["x-artifact-sync-id"];
      if (syncId !== undefined) call.syncId = syncId;
    }
    calls.push(call);
    if (dial.offline) {
      call.thrown = true;
      throw new TypeError("fetch failed");
    }
    const hook = hooks.find((h) => !h.used && h.match(call));
    if (hook) {
      hook.used = true;
      await hook.hook();
    }
    const res = await fetch(`${current}${call.path}`, init);
    call.status = res.status;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      call.responseBody = await res.clone().text();
    }
    const drop = drops.find((d) => !d.used && d.match(call));
    if (drop) {
      drop.used = true;
      call.thrown = true;
      throw new TypeError("response lost after apply");
    }
    return res;
  }) as typeof fetch;
  return dial;
}

// ---------------------------------------------------------------------------
// The production-shaped daemon stack (cli.ts's composition, two substitutions).
// ---------------------------------------------------------------------------

interface DaemonStack {
  runtime: ReturnType<typeof createDaemonRuntime>;
  watch: ReturnType<typeof createArtifactWatchManager>;
  tracked: TrackedWatcher[];
  events: WatchEvent[];
  runnerCalls: () => number;
}

function makeDaemonStack(dial: Dial, daemonRoots: readonly string[]): DaemonStack {
  const tracked: DaemonStack["tracked"] = [];
  const events: DaemonStack["events"] = [];
  const client = createMachineClient({ baseUrl: "http://slice8.daemon", machineCredential: TOKEN, fetchImpl: dial.fetchImpl });
  const sync = createArtifactSyncClient({
    transport: createArtifactTransport({ baseUrl: "http://slice8.daemon", machineCredential: TOKEN, fetchImpl: dial.fetchImpl }),
    cache: createArtifactHashCache(),
  });
  // The tracking factory wraps the PRODUCTION chokidar factory so a swap's
  // close is observable (the slice-5 integration precedent). The entry flips
  // `closed` ONLY after the inner close physically completed; a rejection
  // propagates and leaves the leak-invariant pair `closing:true/closed:false`.
  const factory: ArtifactWatcherFactory = (root) => {
    const inner = createChokidarWatcher(root);
    const entry: TrackedWatcher = { root, closing: false, closed: false };
    tracked.push(entry);
    allTrackedWatchers.push(entry);
    events.push({ kind: "subscribed", root });
    return {
      ready: () => inner.ready(),
      onEvent: (listener) => inner.onEvent(listener),
      onError: (listener) => inner.onError(listener),
      close: async () => {
        entry.closing = true;
        await inner.close();
        entry.closed = true;
        events.push({ kind: "close-completed", root });
      },
    };
  };
  const watch = createArtifactWatchManager({ sync, daemonRoots, createWatcher: factory });
  const finalSync = createFinalArtifactSync({ sync, daemonRoots });
  const fake = createFakeRunner();
  let runnerCalls = 0;
  const countingRunner: AgentRunner = {
    run: (delivery, ctx) => {
      runnerCalls += 1;
      return fake.run(delivery, ctx);
    },
  };
  const runtime = createDaemonRuntime({
    client,
    runner: countingRunner,
    identity: { host: "slice8-host", platform: "test", arch: "test", version: "0.1.0", capabilities: ["terminal-journal-v1", "artifact-sync-v1"] },
    pollMs: 3000,
    machineCredential: TOKEN,
    watch,
    finalSync,
  });
  const drainable = {
    drained: false,
    drain: async (ms: number): Promise<{ settled: boolean }> => {
      if (drainable.drained) return { settled: true };
      drainable.drained = true;
      return watch.drain(ms);
    },
  };
  drainables.push(drainable);
  return { runtime, watch, tracked, events, runnerCalls: () => runnerCalls };
}

// ---------------------------------------------------------------------------
// Probes and drivers
// ---------------------------------------------------------------------------

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`deadline exceeded waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Db = RunningServer["handle"]["db"];

async function loopRow(db: Db, loopId: string) {
  return (await db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
}

async function manifestRow(db: Db, id: string) {
  return (await db.select().from(artifactManifests).where(eq(artifactManifests.id, id)))[0]!;
}

async function runRow(db: Db, runId: string) {
  return (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
}

/** The committed manifest's paths, sorted (the wire sorts by UTF-16 units). */
async function manifestPaths(db: Db, loopId: string): Promise<string[]> {
  const loop = await loopRow(db, loopId);
  if (loop.artifactManifestId === null) return [];
  const manifest = await manifestRow(db, loop.artifactManifestId);
  return manifest.entries.map((entry) => entry.path).sort();
}

/** Every blob the manifest names must exist on disk (no partial manifest). */
async function expectBlobsOnDisk(dataDir: string, manifest: { entries: ReadonlyArray<{ hash: string }> }): Promise<void> {
  for (const entry of manifest.entries) {
    await readFile(path.join(dataDir, "blobs", MACHINE_ID, entry.hash));
  }
}

async function freshDataDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-slice8-${label}-${process.pid}-`));
  dirs.push(dir);
  return dir;
}

/** A realpath'd artifact root (macOS /var → /private/var: the jail compares
 *  the realpath'd target verbatim — the slice-6 fixture lesson). */
async function freshArtifactRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `loopzhb-slice8-artifacts-${label}-${process.pid}-`)));
  dirs.push(root);
  return root;
}

async function createLoop(rs: RunningServer, name: string, artifactDir?: string): Promise<string> {
  const body: Record<string, unknown> = { machineId: MACHINE_ID, name, taskFile: "/srv/e2e/TASK.md" };
  if (artifactDir !== undefined) body.artifactDir = artifactDir;
  const res = await fetch(`${rs.baseUrl}/api/loops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return createLoopResponseSchema.parse(await res.json()).loop.id;
}

async function patchArtifactDir(rs: RunningServer, loopId: string, artifactDir: string | null): Promise<void> {
  const res = await fetch(`${rs.baseUrl}/api/loops/${loopId}/artifact-dir`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifactDir }),
  });
  expect(res.status).toBe(200);
}

async function triggerRun(rs: RunningServer, loopId: string): Promise<string> {
  const res = await fetch(`${rs.baseUrl}/api/loops/${loopId}/run`, { method: "POST" });
  expect(res.status).toBe(202);
  const body = triggerRunResponseSchema.parse(await res.json());
  if (!body.enqueued) throw new Error("expected the trigger to enqueue");
  return body.runId;
}

async function currentView(rs: RunningServer, loopId: string) {
  const res = await fetch(`${rs.baseUrl}/api/loops/${loopId}/artifacts`);
  expect(res.status).toBe(200);
  return loopArtifactsResponseSchema.parse(await res.json());
}

async function downloadBytes(rs: RunningServer, loopId: string, snapshotId: string, artifactPath: string): Promise<Buffer> {
  const res = await fetch(
    `${rs.baseUrl}/api/loops/${loopId}/artifacts/download?snapshotId=${snapshotId}&path=${encodeURIComponent(artifactPath)}`,
  );
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

// ---------------------------------------------------------------------------
// AI1–AI7
// ---------------------------------------------------------------------------

describe("slice 8 fault-integration E2E (real HTTP + file PGlite + local BlobStore + production-shaped daemon + real roots)", () => {
  it("AI1: idle edits and deletes converge through real chokidar; a same-content rewrite is suppressed; every committed blob is on disk", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai1");
    const rs = await bootServer(dataDir, clock);
    const root = await freshArtifactRoot("ai1");
    await writeFile(path.join(root, "seeded.txt"), "seeded");

    const dial = makeDial(rs.baseUrl);
    const stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce(); // machine self-registration
    const loopId = await createLoop(rs, "ai1-loop", root);
    await stack.runtime.pollOnce(); // delivers the watch set → apply → subscribe → startup scan

    // The startup full scan commits the seeded tree with no Run anywhere.
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 1, "the startup scan to commit revision 1");
    expect(stack.tracked).toHaveLength(1);
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["seeded.txt"]);
    const loop1 = await loopRow(rs.handle.db, loopId);
    await expectBlobsOnDisk(dataDir, await manifestRow(rs.handle.db, loop1.artifactManifestId!));

    // AW1/AW2/AW3 at integration level: create, modify, delete — one revision each.
    await writeFile(path.join(root, "created.txt"), "one");
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 2, "the create to commit");
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["created.txt", "seeded.txt"]);

    await writeFile(path.join(root, "created.txt"), "two");
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 3, "the modify to commit");

    await rm(path.join(root, "created.txt"));
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 4, "the delete to commit");
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["seeded.txt"]);
    const loop4 = await loopRow(rs.handle.db, loopId);
    await expectBlobsOnDisk(dataDir, await manifestRow(rs.handle.db, loop4.artifactManifestId!));

    // Quiet window: nothing changes, so nothing is negotiated (no events, the
    // 60 s reconcile tick never starts under pollOnce).
    const quietBaseline = dial.artifactCalls().length;
    await sleep(QUIET_MS);
    expect(dial.artifactCalls()).toHaveLength(quietBaseline);
    expect((await loopRow(rs.handle.db, loopId)).artifactManifestRevision).toBe(4);

    // A same-content rewrite FIRES an event (mtime moves) but the rehash
    // yields identical entries ⇒ client-side suppression ⇒ still zero
    // requests (非空窗口由 M6 变异验证其非 vacuous).
    await writeFile(path.join(root, "seeded.txt"), "seeded");
    await sleep(QUIET_MS);
    expect(dial.artifactCalls()).toHaveLength(quietBaseline);
    expect((await loopRow(rs.handle.db, loopId)).artifactManifestRevision).toBe(4);
  }, 90_000);

  it("AI2: two runs bind two snapshots over a REAL socket; run 1's snapshot stays frozen; the diff shows the three change classes", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai2");
    const rs = await bootServer(dataDir, clock);
    const root = await freshArtifactRoot("ai2");
    const V1 = "console.log('v1')";
    const V2 = "console.log('v2')";
    await writeFile(path.join(root, "app.js"), V1);
    await writeFile(path.join(root, "old.txt"), "old");

    const dial = makeDial(rs.baseUrl);
    const stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce();
    const loopId = await createLoop(rs, "ai2-loop", root);
    await stack.runtime.pollOnce();
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 1, "the startup scan to commit");

    // Run 1 binds snapshot 1 — claimed, synced and reported over the real
    // socket (slice 6 drove the same chain through app.request).
    const runId1 = await triggerRun(rs, loopId);
    await stack.runtime.pollOnce();
    await stack.runtime.executionSettled();
    await until(async () => (await runRow(rs.handle.db, runId1)).phase === "done", "run 1 to finalize");
    const run1 = await runRow(rs.handle.db, runId1);
    expect(run1.outcome).toBe("exec");
    const snapshot1 = run1.artifactSnapshotId!;
    expect(snapshot1).toBeTruthy();
    expect(run1.artifactSyncError).toBeNull();
    const snapshot1RowJson = JSON.stringify(await manifestRow(rs.handle.db, snapshot1));
    const snapshot1Bytes = await downloadBytes(rs, loopId, snapshot1, "app.js");
    expect(snapshot1Bytes.toString()).toBe(V1);

    // Edit (modify + add + delete) → run 2 binds a DIFFERENT snapshot.
    await writeFile(path.join(root, "app.js"), V2);
    await writeFile(path.join(root, "notes.txt"), "notes");
    await rm(path.join(root, "old.txt"));
    const runId2 = await triggerRun(rs, loopId);
    await stack.runtime.pollOnce();
    await stack.runtime.executionSettled();
    await until(async () => (await runRow(rs.handle.db, runId2)).phase === "done", "run 2 to finalize");
    const run2 = await runRow(rs.handle.db, runId2);
    const snapshot2 = run2.artifactSnapshotId!;
    expect(snapshot2).toBeTruthy();
    expect(snapshot2).not.toBe(snapshot1);

    // AR3: run 1's binding and snapshot 1's row are frozen; its bytes still serve.
    expect((await runRow(rs.handle.db, runId1)).artifactSnapshotId).toBe(snapshot1);
    expect(JSON.stringify(await manifestRow(rs.handle.db, snapshot1))).toBe(snapshot1RowJson);
    expect((await downloadBytes(rs, loopId, snapshot1, "app.js")).equals(snapshot1Bytes)).toBe(true);

    // The structural diff shows exactly the three change classes.
    const diffRes = await fetch(`${rs.baseUrl}/api/loops/${loopId}/artifacts/diff?from=${snapshot1}&to=${snapshot2}`);
    expect(diffRes.status).toBe(200);
    const diff = artifactDiffResponseSchema.parse(await diffRes.json());
    expect(diff.added.map((e) => e.path)).toEqual(["notes.txt"]);
    expect(diff.modified).toEqual([
      {
        path: "app.js",
        beforeHash: sha256(V1),
        beforeSize: Buffer.byteLength(V1),
        afterHash: sha256(V2),
        afterSize: Buffer.byteLength(V2),
      },
    ]);
    expect(diff.removed.map((e) => e.path)).toEqual(["old.txt"]);
  }, 90_000);

  it("AI3: a config change swaps the watcher generation over the wire; removal closes the watcher and the old root goes silent", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai3");
    const rs = await bootServer(dataDir, clock);
    const rootA = await freshArtifactRoot("ai3-a");
    const rootB = await freshArtifactRoot("ai3-b");
    await writeFile(path.join(rootA, "a.txt"), "a");
    await writeFile(path.join(rootB, "b.txt"), "b");

    const dial = makeDial(rs.baseUrl);
    const stack = makeDaemonStack(dial, [rootA, rootB]);
    await stack.runtime.pollOnce();
    const loopId = await createLoop(rs, "ai3-loop", rootA);
    await stack.runtime.pollOnce();
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 1, "root A's startup scan");
    expect(stack.tracked).toHaveLength(1);
    expect(stack.tracked[0]!.root).toBe(rootA);

    // The PATCH lands BEFORE the daemon learns of it: the view is stale at
    // generation 2 deterministically (the daemon syncs only via pollOnce).
    await patchArtifactDir(rs, loopId, rootB);
    const staleView = await currentView(rs, loopId);
    expect(staleView.stale).toBe(true);
    expect(staleView.configRevision).toBe(2);
    expect(staleView.manifestRevision).toBe(1);

    // The next poll delivers the new watch set: the old watcher closes and
    // the new root's startup scan commits AT generation 2.
    await stack.runtime.pollOnce();
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 2, "root B's scan to commit at generation 2");
    expect(stack.tracked).toHaveLength(2);
    expect(stack.tracked[0]!.closing).toBe(true);
    expect(stack.tracked[0]!.closed).toBe(true);
    expect(stack.tracked[1]!.root).toBe(rootB);
    // AS7's fixed order with PHYSICAL evidence (#114): the old watcher's close
    // COMPLETED before the successor subscribed. The log records the actual
    // close completion (not a flag flip), so a manager that subscribes early
    // fails here even while every generation converges.
    const closedA = stack.events.findIndex((e) => e.kind === "close-completed" && e.root === rootA);
    const subscribedB = stack.events.findIndex((e) => e.kind === "subscribed" && e.root === rootB);
    expect(closedA).toBeGreaterThanOrEqual(0);
    expect(subscribedB).toBeGreaterThan(closedA);
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["b.txt"]);
    const loop2 = await loopRow(rs.handle.db, loopId);
    const manifest2 = await manifestRow(rs.handle.db, loop2.artifactManifestId!);
    expect(manifest2.configRevision).toBe(2);
    expect((await currentView(rs, loopId)).stale).toBe(false);

    // Removal: the poll carries the empty set, the watcher closes, and edits
    // in BOTH old roots produce zero traffic and zero revision movement.
    await patchArtifactDir(rs, loopId, null);
    await stack.runtime.pollOnce();
    await until(() => stack.tracked[1]!.closed, "the watcher to close on removal");
    expect(stack.watch.watchedLoopIds()).toEqual([]);
    expect((await currentView(rs, loopId)).artifactDir).toBeNull();

    const baselineCalls = dial.artifactCalls().length;
    await writeFile(path.join(rootA, "late-a.txt"), "late");
    await writeFile(path.join(rootB, "late-b.txt"), "late");
    await sleep(QUIET_MS);
    expect(dial.artifactCalls()).toHaveLength(baselineCalls);
    expect((await loopRow(rs.handle.db, loopId)).artifactManifestRevision).toBe(2);
  }, 90_000);

  it("AI4: a network outage is retried inside the client's backoff window and converges to exactly one new revision", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai4");
    const rs = await bootServer(dataDir, clock);
    const root = await freshArtifactRoot("ai4");
    await writeFile(path.join(root, "a.txt"), "a");

    const dial = makeDial(rs.baseUrl);
    const stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce();
    const loopId = await createLoop(rs, "ai4-loop", root);
    await stack.runtime.pollOnce();
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 1, "the startup scan to commit");
    await stack.watch.settled(); // the startup round — responses included — must land BEFORE the fault window opens (#116)

    // Outage BEFORE the edit: the event-driven sync's first attempt fails for
    // real (observed via the dial, never wall-clock), then connectivity is
    // restored inside the client's real 1 s/2 s backoff window.
    dial.offline = true;
    await writeFile(path.join(root, "b.txt"), "during-outage");
    await until(() => dial.thrownAttempts().length >= 1, "the first failed sync attempt");
    dial.offline = false;

    // The revision moves when the SERVER applies — possibly BEFORE the commit
    // response reached the client and the dial recorded its status. Join the
    // sync round first (the AI5 converge pattern), THEN count (#116).
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 2, "the recovery to commit exactly one revision");
    await stack.watch.settled();
    expect((await loopRow(rs.handle.db, loopId)).artifactManifestRevision).toBe(2);
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["a.txt", "b.txt"]);
    // Exactly ONE prepare+commit round carried the recovery (the thrown
    // attempts never reached the server); zero local-failure reports (AS1).
    const prepares = dial.artifactCalls().filter((c) => isPrepare(c) && c.status === 200);
    const commits = dial.artifactCalls().filter((c) => isCommit(c) && c.status === 200);
    expect(prepares).toHaveLength(2); // startup + recovery
    expect(commits).toHaveLength(2);
    expect(dial.calls.filter((c) => c.path.includes("artifact-sync-error"))).toHaveLength(0);

    // A follow-up edit syncs normally — nothing stuck.
    await writeFile(path.join(root, "c.txt"), "after-recovery");
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 3, "the follow-up edit to sync");
  }, 90_000);

  it("AI5: lost responses against the REAL server recover on the same session and the frozen receipt; an expired session renews in place", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai5");
    const rs = await bootServer(dataDir, clock);
    const root = await freshArtifactRoot("ai5");
    await writeFile(path.join(root, "seed.txt"), "seed");

    const dial = makeDial(rs.baseUrl);
    const stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce();
    const loopId = await createLoop(rs, "ai5-loop", root);
    await stack.runtime.pollOnce();
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 1, "the startup scan to commit");

    const revision = async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision;
    /** A dropped response means the SERVER applied first — the revision moves
     *  while the client's retry still sits in its backoff sleep. Join the
     *  round before counting calls. */
    const converge = async (expected: number, label: string) => {
      await until(async () => (await revision()) === expected, label);
      await stack.watch.settled();
    };
    const preparesFor = (marker: string) =>
      dial.artifactCalls().filter((c) => isPrepare(c) && c.requestBody?.includes(marker) === true);
    const putsFor = (hash: string) => dial.artifactCalls().filter((c) => isPut(c) && c.path === `/api/machine/blob/${hash}`);
    const commitsFor = (syncId: string) =>
      dial.artifactCalls().filter((c) => isCommit(c) && c.path === `/api/machine/sync/${syncId}/commit`);

    // Leg (a) — AS2 on the real server: the prepare response is lost AFTER
    // the server created the session; the retry reuses the requestId and the
    // server hands back the SAME session.
    dial.dropNext(isPrepare);
    await writeFile(path.join(root, "leg-a.txt"), "leg-a");
    await converge(2, "leg (a) to converge");
    const legA = preparesFor("leg-a.txt");
    expect(legA).toHaveLength(2);
    expect(legA[0]!.thrown).toBe(true);
    const legARequestIds = legA.map((c) => JSON.parse(c.requestBody!).requestId);
    expect(legARequestIds[1]).toBe(legARequestIds[0]);
    const legASyncIds = legA.map((c) => JSON.parse(c.responseBody!).syncId);
    expect(legASyncIds[1]).toBe(legASyncIds[0]);

    // Leg (b) — AS3 on the real server: the PUT response is lost AFTER the
    // blob was published; the re-PUT dedupes (published:false).
    const legBHash = sha256("leg-b");
    dial.dropNext(isPut);
    await writeFile(path.join(root, "leg-b.txt"), "leg-b");
    await converge(3, "leg (b) to converge");
    const legB = putsFor(legBHash);
    expect(legB).toHaveLength(2);
    expect(legB[0]!.thrown).toBe(true);
    expect(legB[0]!.syncId).toBe(legB[1]!.syncId);
    expect(JSON.parse(legB[0]!.responseBody!).published).toBe(true);
    expect(JSON.parse(legB[1]!.responseBody!).published).toBe(false);

    // Leg (c) — AS4 on the real server: the commit response is lost AFTER the
    // receipt was frozen; the retry takes the IDENTICAL receipt and the
    // revision advances exactly once.
    dial.dropNext(isCommit);
    await writeFile(path.join(root, "leg-c.txt"), "leg-c");
    await converge(4, "leg (c) to converge");
    const legCSyncId = JSON.parse(preparesFor("leg-c.txt")[0]!.responseBody!).syncId;
    const legC = commitsFor(legCSyncId);
    expect(legC).toHaveLength(2);
    expect(legC[0]!.thrown).toBe(true);
    expect(legC[1]!.status).toBe(200);
    // The SAME frozen receipt (JSONB round-trip may reorder keys — compare parsed).
    expect(JSON.parse(legC[0]!.responseBody!)).toEqual(JSON.parse(legC[1]!.responseBody!));

    // Leg (d) — AS5 on the real server: the session EXPIRES before the commit
    // (the server clock advances 2 h just before the commit is evaluated);
    // the client re-prepares the SAME payload, the server renews the session
    // in place (same syncId), the blobs are already there (needHashes: [])
    // and the retry commits.
    dial.hookNext(isCommit, () => clock.advance(2 * 60 * 60 * 1000));
    const legDHash = sha256("leg-d");
    await writeFile(path.join(root, "leg-d.txt"), "leg-d");
    await converge(5, "leg (d) to converge");
    const legD = preparesFor("leg-d.txt");
    expect(legD).toHaveLength(2);
    const legDRequestIds = legD.map((c) => JSON.parse(c.requestBody!).requestId);
    expect(legDRequestIds[1]).toBe(legDRequestIds[0]);
    const legDSyncIds = legD.map((c) => JSON.parse(c.responseBody!).syncId);
    expect(legDSyncIds[1]).toBe(legDSyncIds[0]);
    expect(JSON.parse(legD[1]!.responseBody!).needHashes).toEqual([]);
    expect(putsFor(legDHash)).toHaveLength(1); // never re-uploaded
    const legDCommits = commitsFor(legDSyncIds[0]);
    expect(legDCommits).toHaveLength(2);
    expect(legDCommits[0]!.status).toBe(409);
    expect(legDCommits[0]!.responseBody).toContain("artifact_session_expired");
    expect(legDCommits[1]!.status).toBe(200);

    // Every leg advanced the revision by exactly one and the bytes are intact.
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["leg-a.txt", "leg-b.txt", "leg-c.txt", "leg-d.txt", "seed.txt"]);
    const loop5 = await loopRow(rs.handle.db, loopId);
    await expectBlobsOnDisk(dataDir, await manifestRow(rs.handle.db, loop5.artifactManifestId!));
  }, 90_000);

  it("AI6: daemon and server restarts keep old snapshots and download bytes stable; no partial manifests, stale-generation commits or residue", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai6");
    let rs = await bootServer(dataDir, clock);
    const root = await freshArtifactRoot("ai6");
    await writeFile(path.join(root, "f1.txt"), "f1");
    await writeFile(path.join(root, "f2.txt"), "f2");

    const dial = makeDial(rs.baseUrl);
    let stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce();
    const loopId = await createLoop(rs, "ai6-loop", root);
    await stack.runtime.pollOnce();
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === 1, "the startup scan to commit");

    // A bound run snapshot is the stronger stability subject.
    const runId1 = await triggerRun(rs, loopId);
    await stack.runtime.pollOnce();
    await stack.runtime.executionSettled();
    await until(async () => (await runRow(rs.handle.db, runId1)).phase === "done", "run 1 to finalize");
    const snapshot1 = (await runRow(rs.handle.db, runId1)).artifactSnapshotId!;
    const snapshot1RowJson = JSON.stringify(await manifestRow(rs.handle.db, snapshot1));
    const snapshot1Bytes = await downloadBytes(rs, loopId, snapshot1, "f1.txt");
    const revisionBefore = (await loopRow(rs.handle.db, loopId)).artifactManifestRevision;
    const entriesBefore = JSON.stringify((await manifestRow(rs.handle.db, (await loopRow(rs.handle.db, loopId)).artifactManifestId!)).entries);
    const putsBefore = dial.artifactCalls().filter((c) => isPut(c)).length;

    // (a) DAEMON restart: production exit (drain) then a whole fresh stack —
    // the hash cache is memory and is gone (AS6's model at integration level).
    const drainResult = await drainables[drainables.length - 1]!.drain(2_000);
    expect(drainResult.settled).toBe(true);
    expect(stack.tracked.every((w) => w.closing && w.closed)).toBe(true);
    stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce(); // no digest echoed ⇒ the full watch set is re-delivered
    // The fresh client cannot prove equivalence (its baseline read carries no
    // entries — the documented U2 residual of AS6), so exactly ONE prepare /
    // commit round mints exactly ONE new revision with the SAME entries and
    // ZERO blob uploads (只传缺失内容 holds across the restart).
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === revisionBefore + 1, "the restart round to commit");
    expect(dial.artifactCalls().filter((c) => isPut(c))).toHaveLength(putsBefore);
    const restartLoop = await loopRow(rs.handle.db, loopId);
    const restartManifest = await manifestRow(rs.handle.db, restartLoop.artifactManifestId!);
    expect(JSON.stringify(restartManifest.entries)).toBe(entriesBefore);
    // …and with the entries now recorded, the same instance goes quiet.
    const quietBaseline = dial.artifactCalls().length;
    await sleep(QUIET_MS);
    expect(dial.artifactCalls()).toHaveLength(quietBaseline);

    // (b) SERVER restart: production shutdown order, then a fresh boot over
    // the SAME dataDir; the daemon survives and is re-pointed by the dial.
    await shutdown(rs);
    rs = await bootServer(dataDir, clock);
    dial.rebind(rs.baseUrl);

    // Old snapshots are row-frozen and the bytes still download.
    expect(JSON.stringify(await manifestRow(rs.handle.db, snapshot1))).toBe(snapshot1RowJson);
    expect((await downloadBytes(rs, loopId, snapshot1, "f1.txt")).equals(snapshot1Bytes)).toBe(true);
    expect((await runRow(rs.handle.db, runId1)).artifactSnapshotId).toBe(snapshot1);

    // A new edit syncs over the NEW listener (the daemon's watcher survived).
    await writeFile(path.join(root, "f3.txt"), "f3");
    await until(async () => (await loopRow(rs.handle.db, loopId)).artifactManifestRevision === revisionBefore + 2, "the post-restart edit to sync");
    const finalLoop = await loopRow(rs.handle.db, loopId);
    expect(await manifestPaths(rs.handle.db, loopId)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);

    // No partial manifests anywhere, no stale-generation commits, and the
    // blob root holds ONLY published content-addressed blobs (zero .tmp-*).
    const allManifests = await rs.handle.db.select().from(artifactManifests);
    for (const manifest of allManifests) {
      expect(manifest.configRevision).toBe(finalLoop.artifactConfigRevision);
      await expectBlobsOnDisk(dataDir, manifest);
    }
    const blobNames = await readdir(path.join(dataDir, "blobs", MACHINE_ID));
    expect(blobNames.length).toBeGreaterThan(0);
    expect(blobNames.every((name) => /^[0-9a-f]{64}$/.test(name))).toBe(true);
  }, 90_000);

  it("AI7: a production-shaped daemon NEVER syncs an unconfigured loop — the Batch-1 dormancy guard's e2e successor", async () => {
    const clock = new FakeClock(T0);
    const dataDir = await freshDataDir("ai7");
    const rs = await bootServer(dataDir, clock);
    // The daemon HAS roots and the full artifact wiring (production shape);
    // only the LOOP is unconfigured.
    const root = await freshArtifactRoot("ai7");

    const dial = makeDial(rs.baseUrl);
    const stack = makeDaemonStack(dial, [root]);
    await stack.runtime.pollOnce();
    const loopId = await createLoop(rs, "ai7-loop"); // no artifactDir
    await stack.runtime.pollOnce(); // delivers the (empty) watch set
    expect(stack.watch.watchedLoopIds()).toEqual([]);

    // The loop runs normally — the Fake Runner executes and the real-HTTP
    // report finalizes done/exec with NO artifact fields (旧 Loop 保持原执行行为).
    const runId = await triggerRun(rs, loopId);
    await stack.runtime.pollOnce();
    expect(stack.runnerCalls()).toBe(1);
    await stack.runtime.executionSettled();
    await until(async () => (await runRow(rs.handle.db, runId)).phase === "done", "the run to finalize");
    const run = await runRow(rs.handle.db, runId);
    expect(run.outcome).toBe("exec");
    expect(run.artifactSnapshotId).toBeNull();
    expect(run.artifactSyncError).toBeNull();

    // The WIRE-level guard (#115): DB null is only the server's cleanup — a
    // Report CARRYING an empty artifactSyncError would still be cleaned to
    // null. Assert on the actual Report body recorded by the dial for THIS
    // run: neither artifact key is an own property at all.
    const reports = dial.calls
      .filter((c) => c.method === "POST" && c.path === "/api/machine/report")
      .map((c) => JSON.parse(c.requestBody!) as Record<string, unknown>)
      .filter((body) => body.runId === runId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toHaveProperty("artifactSnapshotId");
    expect(reports[0]).not.toHaveProperty("artifactSyncError");

    // The guard: zero artifact traffic of ANY kind — no baseline reads, no
    // prepare, no PUT, no commit, no error reports.
    expect(dial.artifactCalls()).toEqual([]);
    expect(stack.tracked).toEqual([]);
    // And the blob root was never even created for this machine.
    await expect(readdir(path.join(dataDir, "blobs", MACHINE_ID))).rejects.toThrow();
  }, 90_000);
});
