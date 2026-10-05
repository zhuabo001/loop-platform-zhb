/**
 * Slice-5 end-to-end coverage: REAL chokidar, REAL temp directories, the REAL
 * slice-4 sync client and the in-memory fake artifact server. This is the
 * layer where "a file changed on disk becomes a server-side revision" is
 * proven, so it stays small, positive-assertion-first and deadline-bounded —
 * the exact timing and ordering rules live in artifact-watch-manager.test.ts
 * (fake watcher + injected time) and the adapter's own event-mapping suite.
 *
 * The manager keeps its PRODUCTION 250 ms merge window; only the 60 s
 * reconcile cadence is scaled down so a test could observe it (AW11 itself is
 * pinned deterministically in the manager suite).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactWatchItem } from "@loopzhb/protocol";

import { createArtifactTransport } from "./artifact-client.js";
import { createArtifactHashCache } from "./artifact-hash-cache.js";
import { createArtifactSyncClient } from "./artifact-sync.js";
import { createChokidarWatcher, type ArtifactWatcherFactory } from "./artifact-watcher.js";
import { ARTIFACT_WATCH_RECONCILE_MS, createArtifactWatchManager } from "./artifact-watch-manager.js";
import { createFakeArtifactServer, type FakeArtifactServer } from "./testkit/artifact-sync-fake.js";

const CREDENTIAL = "dk_slice5_integration_credential";
const LOOP_ID = "loop-1";
const DEADLINE_MS = 15_000;

let base: string;
let extraDirs: string[];
let server: FakeArtifactServer;
let tracked: Array<{ root: string; closed: boolean }>;
let manager: ReturnType<typeof createArtifactWatchManager> | null;

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-watch-e2e-test-"));
  extraDirs = [];
  tracked = [];
  manager = null;
});

afterEach(async () => {
  await manager?.drain(2_000);
  for (const dir of [base, ...extraDirs]) rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`deadline exceeded waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function loop(): NonNullable<ReturnType<FakeArtifactServer["loops"]["get"]>> {
  return server.loops.get(LOOP_ID)!;
}

function manifestPaths(): string[] {
  return loop().manifest.map((entry) => entry.path).sort();
}

/** The production stack, with the reconcile cadence scaled down and every
 *  chokidar instance tracked so a swap's close is observable. */
function start(loopDir: string): void {
  server = createFakeArtifactServer({
    machineCredential: CREDENTIAL,
    loops: [{ loopId: LOOP_ID, artifactDir: loopDir }],
  });
  const client = createArtifactSyncClient({
    transport: createArtifactTransport({
      baseUrl: "http://fake.invalid",
      machineCredential: CREDENTIAL,
      fetchImpl: server.fetchImpl,
    }),
    cache: createArtifactHashCache(),
    sleep: async () => {}, // no failure paths here; the real backoff is slice-4's
  });
  const factory: ArtifactWatcherFactory = (root) => {
    const inner = createChokidarWatcher(root);
    const entry = { root, closed: false };
    tracked.push(entry);
    return {
      ready: () => inner.ready(),
      onEvent: (listener) => inner.onEvent(listener),
      onError: (listener) => inner.onError(listener),
      close: async () => {
        entry.closed = true;
        await inner.close();
      },
    };
  };
  manager = createArtifactWatchManager({
    sync: client,
    daemonRoots: [base],
    createWatcher: factory,
    sleep: (ms, signal) =>
      // Scale ONLY the reconcile cadence; the 250 ms merge window stays real.
      ms === ARTIFACT_WATCH_RECONCILE_MS
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          })
        : new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          }),
  });
  manager.start();
}

function target(overrides: Partial<ArtifactWatchItem> = {}): ArtifactWatchItem {
  return { loopId: LOOP_ID, artifactDir: base, workdir: null, roots: [], configRevision: 1, ...overrides };
}

describe("artifact watch end-to-end (real watcher, real dirs, fake server)", () => {
  it("converges on create, modify and delete with no Run anywhere (AW1/AW2/AW3/AW6/AW14)", async () => {
    writeFileSync(path.join(base, "seeded.txt"), "seeded");
    start(base);

    manager!.apply([target()], "digest-1");

    // The startup full scan commits the seeded tree — no delivery, no run.
    await until(() => loop().manifestRevision >= 1, "the startup scan to commit");
    expect(manifestPaths()).toEqual(["seeded.txt"]);

    // Idle: nothing changes, so nothing is committed (suppression + no events).
    const idleRevision = loop().manifestRevision;
    await sleep(800);
    expect(loop().manifestRevision).toBe(idleRevision);

    writeFileSync(path.join(base, "created.txt"), "one");
    await until(() => manifestPaths().includes("created.txt"), "the created file to sync (AW1)");

    writeFileSync(path.join(base, "created.txt"), "two");
    const createdHash = loop().manifest.find((entry) => entry.path === "created.txt")!.hash;
    await until(
      () => loop().manifest.find((entry) => entry.path === "created.txt")?.hash !== createdHash,
      "the modified content to sync (AW2)",
    );

    rmSync(path.join(base, "created.txt"));
    await until(() => !manifestPaths().includes("created.txt"), "the deleted file to leave the manifest (AW3)");
    expect(manifestPaths()).toEqual(["seeded.txt"]);
  });

  it("syncs a same-size rewrite with its new hash (AW7)", async () => {
    writeFileSync(path.join(base, "same.txt"), "AAAA");
    start(base);
    manager!.apply([target()]);
    await until(() => loop().manifestRevision >= 1, "the startup scan to commit");

    const before = loop().manifest.find((entry) => entry.path === "same.txt")!;
    writeFileSync(path.join(base, "same.txt"), "BBBB"); // identical length

    await until(
      () => loop().manifest.find((entry) => entry.path === "same.txt")?.hash !== before.hash,
      "the same-size rewrite to sync",
    );
    expect(loop().manifest.find((entry) => entry.path === "same.txt")!.size).toBe(before.size);
  });

  it("closes the old watcher and syncs the new root on a config swap (AS7)", async () => {
    const next = path.join(base, "next");
    mkdirSync(next);
    writeFileSync(path.join(base, "old.txt"), "old");
    writeFileSync(path.join(next, "new.txt"), "new");
    start(base);
    manager!.apply([target()]);
    await until(() => loop().manifestRevision >= 1, "the startup scan to commit");

    // The server moves the loop to `next` (generation 2).
    loop().artifactDir = next;
    loop().configRevision = 2;
    manager!.apply([target({ artifactDir: next, configRevision: 2 })], "digest-2");

    await until(() => tracked.length === 2, "the new subscription");
    await until(() => manifestPaths().join() === "new.txt", "the new root's manifest");
    expect(tracked[0]!.closed).toBe(true);
    expect(tracked[1]!.root).toBe(realpathSync(next));
  });

  it("drains within the deadline and stops intake (AS12)", async () => {
    writeFileSync(path.join(base, "a.txt"), "a");
    start(base);
    manager!.apply([target()]);
    await until(() => loop().manifestRevision >= 1, "the startup scan to commit");

    expect(await manager!.drain(5_000)).toEqual({ settled: true });
    await manager!.settled();
    expect(tracked.every((entry) => entry.closed)).toBe(true);

    // Intake is over: a late event and a late watch update do nothing.
    const frozen = loop().manifestRevision;
    writeFileSync(path.join(base, "late.txt"), "late");
    manager!.apply([target({ configRevision: 7 })], "digest-7");
    await sleep(700);
    expect(loop().manifestRevision).toBe(frozen);
    expect(manager!.watchedLoopIds()).toEqual([LOOP_ID]); // the set is kept, intake is not
  });
});
