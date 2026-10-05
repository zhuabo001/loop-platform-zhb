/**
 * Slice-5 deterministic coverage for the WatchManager (AW9–AW14, AS7/AS8/AS12
 * plus the #91 admission and the stop-scope evidence). The watcher is a fake
 * and time is injected (the daemon's convention — never fake timers), so every
 * ordering claim is exact; the real chokidar adapter and the end-to-end suite
 * live in their own files.
 *
 * Each test names the mutation that would make it red.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactWatchItem } from "@loopzhb/protocol";

import type { ArtifactLocalFailureInput, ArtifactSyncInput, ArtifactSyncOutcome } from "./artifact-sync.js";
import type { ArtifactWatcher, ArtifactWatcherFactory } from "./artifact-watcher.js";
import {
  ARTIFACT_WATCH_EVENT_MERGE_MS,
  ARTIFACT_WATCH_RECONCILE_MS,
  createArtifactWatchManager,
  type ArtifactWatchController,
  type ArtifactWatchSync,
} from "./artifact-watch-manager.js";

let base: string;
let extraDirs: string[];

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-watch-manager-test-"));
  extraDirs = [];
});

afterEach(() => {
  for (const dir of [base, ...extraDirs]) rmSync(dir, { recursive: true, force: true });
});

// ---- harness ----

/** Let every pending microtask and immediate callback drain. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`deadline exceeded waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface FakeWatcherHandle {
  root: string;
  watcher: ArtifactWatcher;
  closed: boolean;
  emit: () => void;
  emitError: (error: unknown) => void;
  releaseReady: () => void;
}

interface WatcherHarness {
  factory: ArtifactWatcherFactory;
  handles: FakeWatcherHandle[];
  log: string[];
  autoReady: { value: boolean };
}

function createWatcherHarness(): WatcherHarness {
  const handles: FakeWatcherHandle[] = [];
  const log: string[] = [];
  const autoReady = { value: true };
  const factory: ArtifactWatcherFactory = (root) => {
    const eventListeners: Array<() => void> = [];
    const errorListeners: Array<(error: unknown) => void> = [];
    let releaseReady: (() => void) | null = null;
    let released = false;
    const handle: FakeWatcherHandle = {
      root,
      closed: false,
      emit: () => {
        if (!handle.closed) for (const listener of eventListeners) listener();
      },
      emitError: (error) => {
        if (!handle.closed) for (const listener of errorListeners) listener(error);
      },
      releaseReady: () => {
        released = true;
        releaseReady?.();
        releaseReady = null;
      },
      watcher: {
        ready: () =>
          new Promise<void>((resolve) => {
            if (handle.closed || released || autoReady.value) resolve();
            else releaseReady = resolve;
          }),
        onEvent: (listener) => {
          eventListeners.push(listener);
        },
        onError: (listener) => {
          errorListeners.push(listener);
        },
        close: () => {
          handle.closed = true;
          log.push(`close:${root}`);
          releaseReady?.();
          releaseReady = null;
          return Promise.resolve();
        },
      },
    };
    log.push(`create:${root}`);
    handles.push(handle);
    return handle.watcher;
  };
  return { factory, handles, log, autoReady };
}

interface ManualSleep {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pendingMs: () => number[];
  fire: (ms?: number) => number;
}

function createManualSleep(): ManualSleep {
  const waiting: Array<{ ms: number; done: boolean; finish: () => void }> = [];
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const entry = { ms, done: false, finish: () => {} };
      entry.finish = (): void => {
        if (entry.done) return;
        entry.done = true;
        resolve();
      };
      waiting.push(entry);
      if (signal.aborted) {
        entry.finish();
        return;
      }
      signal.addEventListener("abort", () => entry.finish(), { once: true });
    });
  return {
    sleep,
    pendingMs: () => waiting.filter((entry) => !entry.done).map((entry) => entry.ms),
    fire: (ms) => {
      const matches = waiting.filter((entry) => !entry.done && (ms === undefined || entry.ms === ms));
      for (const entry of matches) entry.finish();
      return matches.length;
    },
  };
}

interface SyncStub {
  client: ArtifactWatchSync;
  calls: ArtifactSyncInput[];
  reports: ArtifactLocalFailureInput[];
  setOutcome: (outcome: ArtifactSyncOutcome) => void;
  hold: () => () => void;
  clearStopsCount: () => number;
  settledCalls: () => number;
}

function createSyncStub(): SyncStub {
  const calls: ArtifactSyncInput[] = [];
  const reports: ArtifactLocalFailureInput[] = [];
  let outcome: ArtifactSyncOutcome = { kind: "unchanged" };
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let clearStopsCalls = 0;
  let settledCount = 0;
  const client: ArtifactWatchSync = {
    async syncLoop(input) {
      calls.push(input);
      if (gate !== null) await gate;
      return outcome;
    },
    async reportLocalFailure(input) {
      reports.push(input);
      return outcome.kind === "stopped"
        ? outcome
        : { kind: "failed", failure: input.failure, detail: input.detail, reported: "recorded" };
    },
    clearStops() {
      clearStopsCalls += 1;
    },
    async settled() {
      settledCount += 1;
    },
  };
  return {
    client,
    calls,
    reports,
    setOutcome: (next) => {
      outcome = next;
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release?.();
        gate = null;
        release = null;
      };
    },
    clearStopsCount: () => clearStopsCalls,
    settledCalls: () => settledCount,
  };
}

interface Harness {
  manager: ArtifactWatchController;
  watchers: WatcherHarness;
  sync: SyncStub;
  time: ManualSleep;
  logs: string[];
}

function createHarness(): Harness {
  const watchers = createWatcherHarness();
  const sync = createSyncStub();
  const time = createManualSleep();
  const logs: string[] = [];
  const manager = createArtifactWatchManager({
    sync: sync.client,
    daemonRoots: [base],
    createWatcher: watchers.factory,
    sleep: time.sleep,
    log: (line) => logs.push(line),
  });
  return { manager, watchers, sync, time, logs };
}

function item(overrides: Partial<ArtifactWatchItem> = {}): ArtifactWatchItem {
  return { loopId: "loop-1", artifactDir: base, workdir: null, roots: [], configRevision: 1, ...overrides };
}

/** Wait for the standard admission + subscribe + first full scan of one loop. */
async function waitForFirstScan(harness: Harness): Promise<void> {
  await waitUntil(() => harness.sync.calls.length >= 1, "the first scan");
}

async function fireWindow(harness: Harness): Promise<void> {
  await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_EVENT_MERGE_MS), "the merge window");
  harness.time.fire(ARTIFACT_WATCH_EVENT_MERGE_MS);
  await tick();
  await tick();
}

describe("artifact-watch-manager", () => {
  it("subscribes (and awaits ready) BEFORE the first full scan, and stores the digest on apply (AW12, AW13)", async () => {
    const harness = createHarness();
    harness.watchers.autoReady.value = false;

    harness.manager.apply([item()], "digest-1");

    expect(harness.manager.currentDigest()).toBe("digest-1");
    await waitUntil(() => harness.watchers.handles.length === 1, "the watcher");
    expect(harness.watchers.handles[0]!.root).toBe(realpathSync(base));
    // Mutation: scan before subscribe ⇒ this stays 0 after the release below.
    await tick();
    expect(harness.sync.calls).toHaveLength(0);

    harness.watchers.handles[0]!.releaseReady();
    await waitForFirstScan(harness);
    expect(harness.sync.calls[0]!.reuseCachedHashes).toBe(false); // startup = full rehash
  });

  it("stores the digest at APPLY time, never waiting for the watchers (摘要通道)", async () => {
    const harness = createHarness();
    harness.watchers.autoReady.value = false;

    harness.manager.apply([item()], "digest-1");

    // Mutation: store the digest only after the generation is up ⇒ the server
    // would resend the whole set on every poll until then.
    expect(harness.manager.currentDigest()).toBe("digest-1");
    await waitUntil(() => harness.watchers.handles.length === 1, "the watcher");
    expect(harness.manager.currentDigest()).toBe("digest-1");

    // A same-set re-apply only refreshes the digest; it starts NO new work.
    harness.manager.apply([item()], "digest-2");
    expect(harness.manager.currentDigest()).toBe("digest-2");

    harness.watchers.handles[0]!.releaseReady();
    await waitForFirstScan(harness);
    expect(harness.sync.calls).toHaveLength(1);
  });

  it("merges a burst of events into exactly ONE round in a fixed 250 ms window (AW10)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    for (let index = 0; index < 5; index += 1) harness.watchers.handles[0]!.emit();

    const windows = harness.time.pendingMs().filter((ms) => ms === ARTIFACT_WATCH_EVENT_MERGE_MS);
    expect(windows).toHaveLength(1); // one window, not one per event
    await fireWindow(harness);

    expect(harness.sync.calls).toHaveLength(2);
    expect(harness.sync.calls[1]!.reuseCachedHashes).toBe(true); // the event path opts in
  });

  it("rescans when events arrive DURING a round (dirty-during-scan, AW9/AW12)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    const releaseHold = harness.sync.hold();
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    expect(harness.sync.calls).toHaveLength(2); // held mid-round

    // An event while the round is in flight must survive it.
    harness.watchers.handles[0]!.emit();
    releaseHold();
    await tick();
    await fireWindow(harness);

    expect(harness.sync.calls).toHaveLength(3);
    expect(harness.sync.calls[2]!.reuseCachedHashes).toBe(true);
  });

  it("re-runs a FULL-rehash scan on the 60 s tick, catching missed events (AW11)", async () => {
    const harness = createHarness();
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the reconcile tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await tick();
    await tick();

    expect(harness.sync.calls).toHaveLength(2);
    // Mutation: reuse the cache on the tick ⇒ red (the reconcile MUST rehash).
    expect(harness.sync.calls[1]!.reuseCachedHashes).toBe(false);
    expect(harness.time.pendingMs()).toContain(ARTIFACT_WATCH_RECONCILE_MS); // re-armed
  });

  it("swaps a generation in the fixed order: abort, close the OLD watcher, then subscribe (AS7)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    const releaseHold = harness.sync.hold();
    harness.watchers.handles[0]!.emit(); // a round against the OLD generation, held
    await fireWindow(harness);
    expect(harness.sync.calls).toHaveLength(2);

    harness.manager.apply([item({ configRevision: 2 })]);
    await waitUntil(() => harness.watchers.handles.length === 2, "the new watcher");
    await waitUntil(() => harness.sync.calls.length === 3, "the new generation's scan");

    // The old round was aborted, not left running against the new config.
    expect(harness.sync.calls[1]!.signal?.aborted).toBe(true);
    // The order IS the AS7 evidence: the old watcher was closed before the
    // successor was created (mutation: subscribe first ⇒ create,create,close).
    expect(harness.watchers.handles[0]!.closed).toBe(true);
    expect(harness.watchers.log).toEqual([
      `create:${realpathSync(base)}`,
      `close:${realpathSync(base)}`,
      `create:${realpathSync(base)}`,
    ]);
    expect(harness.sync.calls[2]!.target.configRevision).toBe(2);
    expect(harness.sync.calls[2]!.reuseCachedHashes).toBe(false); // a new generation full-scans
    releaseHold();
  });

  it("removes a loop on watch-set removal and can re-add it (AS8)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);
    const callsAfterFirst = harness.sync.calls.length;

    harness.manager.apply([]);
    await waitUntil(() => harness.manager.watchedLoopIds().length === 0, "the dropped loop");
    await waitUntil(() => harness.watchers.handles[0]!.closed, "the closed watcher");
    harness.watchers.handles[0]!.emit(); // a late event must go nowhere
    await tick();
    expect(harness.sync.calls).toHaveLength(callsAfterFirst);

    harness.manager.apply([item()]);
    await waitUntil(() => harness.sync.calls.length === callsAfterFirst + 1, "the re-added loop's scan");
    expect(harness.manager.watchedLoopIds()).toEqual(["loop-1"]);
  });

  it("drains within the deadline: watchers closed, timers aborted, late events ignored, no forced commit (AS12)", async () => {
    const harness = createHarness();
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    const releaseHold = harness.sync.hold();
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness); // a round is now held
    const callsDuringDrain = harness.sync.calls.length;

    const draining = harness.manager.drain(1_000);
    await tick();
    // The deadline fires while the round is still held: the drain reports it.
    expect(harness.time.fire(1_000)).toBe(1);
    const result = await draining;
    expect(result).toEqual({ settled: false });
    expect(harness.logs.some((line) => line.includes("drain exceeded"))).toBe(true);
    expect(harness.watchers.handles[0]!.closed).toBe(true);
    expect(harness.time.pendingMs()).toEqual([]); // no timers left

    // Late events after the drain are ignored entirely.
    harness.watchers.handles[0]!.emit();
    harness.manager.apply([item({ configRevision: 9 })]);
    await tick();
    expect(harness.sync.calls).toHaveLength(callsDuringDrain);

    releaseHold();
    await tick();
  });

  it("drains instantly when idle, joining the sync client's settled()", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
    // Mutation: skip sync.settled() ⇒ red — the client may still hold uploads.
    expect(harness.sync.settledCalls()).toBe(1);
    expect(harness.watchers.handles[0]!.closed).toBe(true);
    // The LOSING deadline timer must be cleared: a pending ref'd timer would
    // hold the process open after a clean shutdown (the daemon would look
    // hung to its supervisor).
    expect(harness.time.pendingMs()).toEqual([]);
  });

  it("refuses a never-sync root at admission: no watcher, ONE report per generation (#91)", async () => {
    const ssh = path.join(base, ".ssh", "keys");
    mkdirSync(ssh, { recursive: true });
    writeFileSync(path.join(ssh, "notes.txt"), "ordinary");
    const harness = createHarness();
    harness.manager.start();

    harness.manager.apply([item({ artifactDir: ssh })]);

    await waitUntil(() => harness.sync.reports.length === 1, "the admission report");
    expect(harness.watchers.handles).toHaveLength(0); // never subscribed, never enumerated
    expect(harness.sync.calls).toHaveLength(0); // no sync attempt either
    expect(harness.sync.reports[0]).toMatchObject({ failure: "outside_jail" });

    // The tick re-verifies locally but does not spam a second report.
    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await tick();
    await tick();
    expect(harness.sync.reports).toHaveLength(1);

    // A new generation with a legal dir is admitted normally.
    harness.manager.apply([item({ artifactDir: path.join(base, "legal"), configRevision: 2 })]);
    mkdirSync(path.join(base, "legal"));
    await waitUntil(() => harness.watchers.handles.length === 1, "the legal root's watcher");
  });

  it("closes the watcher on a root-shaped sync failure and re-admits it from the tick (AW14)", async () => {
    const harness = createHarness();
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    harness.sync.setOutcome({ kind: "failed", failure: "outside_jail", detail: "jail moved", reported: "recorded" });
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    await waitUntil(() => harness.watchers.handles[0]!.closed, "the watcher close on the jail failure");

    harness.sync.setOutcome({ kind: "unchanged" });
    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await waitUntil(() => harness.watchers.handles.length === 2, "the re-admitted watcher");
    await waitUntil(() => harness.sync.calls.length >= 3, "the re-admission scan");
    expect(harness.sync.calls.at(-1)!.reuseCachedHashes).toBe(false);
  });

  it("parks every loop on a machine stop and re-admits after a material watch-set change clears stops", async () => {
    const harness = createHarness();
    mkdirSync(path.join(base, "two"));
    harness.manager.apply([item(), item({ loopId: "loop-2", artifactDir: path.join(base, "two") })]);
    await waitUntil(() => harness.watchers.handles.length === 2, "both watchers");

    harness.sync.setOutcome({ kind: "stopped", scope: "machine", status: 401, detail: "401" });
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    await waitUntil(() => harness.watchers.handles.every((handle) => handle.closed), "every watcher closed");

    // The machine stop is sticky: the tick does NOT re-admit.
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await tick();
    expect(harness.watchers.handles).toHaveLength(2);

    // A material set change is the documented clearStops trigger.
    harness.sync.setOutcome({ kind: "unchanged" });
    harness.manager.apply([item({ configRevision: 3 }), item({ loopId: "loop-2", artifactDir: path.join(base, "two") })]);
    await waitUntil(() => harness.sync.clearStopsCount() >= 1, "clearStops");
    await waitUntil(() => harness.watchers.handles.length === 4, "the re-admitted watchers");
  });

  it("closes only the affected loop on a loop-scope stop", async () => {
    const harness = createHarness();
    mkdirSync(path.join(base, "two"));
    harness.manager.apply([item(), item({ loopId: "loop-2", artifactDir: path.join(base, "two") })]);
    await waitUntil(() => harness.watchers.handles.length === 2, "both watchers");

    harness.sync.setOutcome({ kind: "stopped", scope: "loop", status: 403, detail: "403" });
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    await waitUntil(() => harness.watchers.handles[0]!.closed, "the stopped loop's watcher");

    expect(harness.watchers.handles[1]!.closed).toBe(false); // the other loop keeps watching
  });

  it("coalesces watcher errors into ONE reportLocalFailure per window", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    harness.watchers.handles[0]!.emitError(new Error("EACCES: permission denied"));
    harness.watchers.handles[0]!.emitError(new Error("EACCES: permission denied"));
    await fireWindow(harness);

    expect(harness.sync.reports).toHaveLength(1);
    expect(harness.sync.reports[0]).toMatchObject({ failure: "watcher_error" });
    expect(harness.sync.reports[0]!.detail).toContain("EACCES");
  });

  it("applies synchronously: a held round for one loop never blocks another loop (poll heartbeat)", async () => {
    const harness = createHarness();
    mkdirSync(path.join(base, "two"));
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    const releaseHold = harness.sync.hold();
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness); // loop-1 is now stuck in a round

    harness.manager.apply([item(), item({ loopId: "loop-2", artifactDir: path.join(base, "two") })]);
    await waitUntil(() => harness.watchers.handles.length === 2, "loop-2's watcher without waiting for loop-1");
    releaseHold();
  });
});
