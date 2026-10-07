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

/** Give the manager a bounded window to (mis)behave before asserting on the
 *  absence of an effect whose admission needs real fs I/O to reach. */
async function settleFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeWatcherHandle {
  root: string;
  watcher: ArtifactWatcher;
  /** The close was called and has not completed yet. */
  closing: boolean;
  /** The close COMPLETED (chokidar's close is async: this is the only honest
   *  "the old subscription is gone" signal). */
  closed: boolean;
  holdClose: () => void;
  releaseClose: () => void;
  emit: () => void;
  emitError: (error: unknown) => void;
  releaseReady: () => void;
}

interface WatcherHarness {
  factory: ArtifactWatcherFactory;
  handles: FakeWatcherHandle[];
  /** For each created watcher, how many watchers were still OPEN at creation:
       the successor of a swap must never see a live predecessor. */
  openAtCreate: number[];
  log: string[];
  autoReady: { value: boolean };
}

function createWatcherHarness(): WatcherHarness {
  const handles: FakeWatcherHandle[] = [];
  const openAtCreate: number[] = [];
  const log: string[] = [];
  const autoReady = { value: true };
  const factory: ArtifactWatcherFactory = (root) => {
    const eventListeners: Array<() => void> = [];
    const errorListeners: Array<(error: unknown) => void> = [];
    let releaseReady: (() => void) | null = null;
    let released = false;
    let holdClose = false;
    let releaseCloseLatch: (() => void) | null = null;
    let closePromise: Promise<void> | null = null;
    const handle: FakeWatcherHandle = {
      root,
      closing: false,
      closed: false,
      holdClose: () => {
        holdClose = true;
      },
      releaseClose: () => {
        const release = releaseCloseLatch;
        releaseCloseLatch = null;
        release?.();
      },
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
        // Idempotent like the chokidar adapter: a second caller joins the
        // close already in flight instead of starting a second one.
        close: () => {
          if (closePromise !== null) return closePromise;
          handle.closing = true;
          log.push(`close:${root}`);
          releaseReady?.(); // a caller parked on ready() must not hang
          releaseReady = null;
          closePromise = (async (): Promise<void> => {
            if (holdClose) await new Promise<void>((resolve) => {
              releaseCloseLatch = resolve;
            });
            handle.closing = false;
            handle.closed = true;
          })();
          return closePromise;
        },
      },
    };
    log.push(`create:${root}`);
    openAtCreate.push(handles.filter((entry) => !entry.closed).length);
    handles.push(handle);
    return handle.watcher;
  };
  return { factory, handles, openAtCreate, log, autoReady };
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
    // Ending a round does not mature the next fixed window (#103).
    expect(harness.sync.calls).toHaveLength(2);
    harness.watchers.handles[0]!.emit(); // another event in that same window
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

    // A new generation with a legal dir is admitted normally. The directory
    // exists BEFORE the apply: admission resolves the root as soon as it is
    // launched, so a later mkdir would race the realpath (threadpool op).
    mkdirSync(path.join(base, "legal"));
    harness.manager.apply([item({ artifactDir: path.join(base, "legal"), configRevision: 2 })]);
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

  it("restores an unchanged loop and a newly added loop while the old machine-stop close is held (#102)", async () => {
    const harness = createHarness();
    mkdirSync(path.join(base, "two"));
    harness.manager.apply([item()], "d1");
    await waitForFirstScan(harness);
    const old = harness.watchers.handles[0]!;
    old.holdClose();
    harness.sync.setOutcome({ kind: "stopped", scope: "machine", status: 401, detail: "401" });
    old.emit();
    await fireWindow(harness);
    await waitUntil(() => old.closing, "the old machine-stop close");

    harness.sync.setOutcome({ kind: "unchanged" });
    harness.manager.apply([item(), item({ loopId: "loop-2", artifactDir: path.join(base, "two") })], "d2");
    await waitUntil(() => harness.sync.calls.some((call) => call.target.loopId === "loop-2"), "the new loop's scan");
    old.releaseClose();
    await harness.manager.settled();

    // The old stop owns only its snapshot. It must neither park the successor
    // nor miss restoring loop-1 just because its close was still pending.
    expect(harness.watchers.handles.filter((handle) => !handle.closed)).toHaveLength(2);
    expect(harness.sync.calls.filter((call) => call.target.loopId === "loop-1")).toHaveLength(3);
    expect(harness.manager.currentDigest()).toBe("d2");
    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
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

  it.each([false, true])("keeps recovered peers alive across an old machine stop (replace peer: %s, #102)", async (replacePeer) => {
    const harness = createHarness();
    const peer = item({ loopId: "loop-2", artifactDir: path.join(base, "two") });
    mkdirSync(peer.artifactDir!);
    harness.manager.apply([item(), peer]);
    await harness.manager.settled();
    const old = harness.watchers.handles.find((handle) => handle.root === base)!;
    old.holdClose();
    harness.sync.setOutcome({ kind: "stopped", scope: "machine", status: 401, detail: "401" });
    old.emit();
    await fireWindow(harness);
    await waitUntil(() => old.closing, "the machine-stop close");

    harness.sync.setOutcome({ kind: "unchanged" });
    harness.manager.apply([item({ configRevision: 2 }), { ...peer, configRevision: replacePeer ? 2 : 1 }]);
    await waitUntil(() => harness.watchers.handles.filter((handle) => handle.root === peer.artifactDir).length === 2, "the recovered peer");
    old.releaseClose();
    await harness.manager.settled();
    expect(harness.watchers.handles.filter((handle) => !handle.closed)).toHaveLength(2);
    expect(harness.sync.calls.filter((call) => call.target.loopId === "loop-2").map((call) => call.target.configRevision)).toEqual([1, replacePeer ? 2 : 1]);
    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
  });

  it("restores a stopped peer independently of its aborted in-flight driver (#102)", async () => {
    const harness = createHarness();
    const peer = item({ loopId: "loop-2", artifactDir: path.join(base, "two") });
    mkdirSync(peer.artifactDir!);
    harness.manager.apply([item(), peer]);
    await harness.manager.settled();
    let releasePeer!: () => void;
    const heldPeer = new Promise<void>((resolve) => { releasePeer = resolve; });
    harness.sync.client.syncLoop = async (input) => {
      harness.sync.calls.push(input);
      if (input.target.loopId === "loop-2" && input.target.configRevision === 1) {
        await heldPeer;
        return { kind: "stopped", scope: "machine", status: 401, detail: "late 401" };
      }
      return input.target.configRevision === 1
        ? { kind: "stopped", scope: "machine", status: 401, detail: "401" }
        : { kind: "unchanged" };
    };
    harness.watchers.handles.find((handle) => handle.root === peer.artifactDir)!.emit();
    await fireWindow(harness);
    harness.watchers.handles.find((handle) => handle.root === base)!.emit();
    await fireWindow(harness);
    await waitUntil(() => harness.watchers.handles.every((handle) => handle.closed), "both stopped watchers");

    // The unchanged peer must start a full scan despite its old held driver.
    // Returning a stale machine stop afterward must not park the new set.
    harness.sync.client.syncLoop = async (input) => {
      harness.sync.calls.push(input);
      return { kind: "unchanged" };
    };
    harness.manager.apply([item({ configRevision: 2 }), peer]);
    await waitUntil(() => harness.sync.calls.length === 6, "both recovery scans without the old driver");
    releasePeer();
    await harness.manager.settled();
    expect(harness.watchers.handles.filter((handle) => !handle.closed)).toHaveLength(2);
    expect(harness.sync.calls.slice(-2).every((call) => call.reuseCachedHashes === false)).toBe(true);
    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
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

  // ---- round-2 review fixes: the concurrently-updated watch set (P1) ----

  it("discards a superseded reconcile pass: the newest set wins, one watcher per loop (P1)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()], "d1");
    await waitForFirstScan(harness);

    // The swap to rev 2 stalls INSIDE the old watcher's close.
    harness.watchers.handles[0]!.holdClose();
    harness.manager.apply([item({ configRevision: 2 })], "d2");
    await waitUntil(() => harness.watchers.handles[0]!.closing, "the held close");

    // A third set arrives while that pass is still winding down.
    harness.manager.apply([item({ configRevision: 3 })], "d3");
    await tick();
    // Mutation: run passes concurrently ⇒ the stalled rev-2 pass would already
    // have subscribed a successor before the old watcher was closed.
    expect(harness.watchers.handles).toHaveLength(1);
    expect(harness.sync.calls).toHaveLength(1);

    harness.watchers.handles[0]!.releaseClose();
    await waitUntil(() => harness.sync.calls.length === 2, "the newest generation's scan");
    await harness.manager.settled();

    // rev 2 was never scanned and never substituted: the LATEST set is what
    // materialized (mutation: no epoch check ⇒ [1, 3, 2] and two live roots).
    expect(harness.sync.calls.map((call) => call.target.configRevision)).toEqual([1, 3]);
    expect(harness.manager.currentDigest()).toBe("d3");
    expect(harness.watchers.handles).toHaveLength(2);
    expect(harness.watchers.handles.filter((handle) => !handle.closed)).toHaveLength(1);
    // The successor subscribed only AFTER the predecessor was closed.
    expect(harness.watchers.openAtCreate).toEqual([0, 0]);
    expect(harness.sync.calls[1]!.reuseCachedHashes).toBe(false);
  });

  it("keeps the newest (empty) set: a stalled swap is discarded, never revived (P1/AS8)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()], "d1");
    await waitForFirstScan(harness);

    harness.watchers.handles[0]!.holdClose();
    harness.manager.apply([item({ configRevision: 2 })], "d2");
    await waitUntil(() => harness.watchers.handles[0]!.closing, "the held close");

    harness.manager.apply([], "empty");
    // AS8 is synchronous: the loop is out of the set the moment it says so,
    // even though the close (and the stalled pass) are still winding down.
    expect(harness.manager.watchedLoopIds()).toEqual([]);

    harness.watchers.handles[0]!.releaseClose();
    await harness.manager.settled();
    await tick();

    expect(harness.manager.watchedLoopIds()).toEqual([]);
    expect(harness.manager.currentDigest()).toBe("empty");
    // Mutation: let the stalled pass continue ⇒ rev 2 is subscribed and scanned.
    expect(harness.sync.calls.map((call) => call.target.configRevision)).toEqual([1]);
    expect(harness.watchers.handles).toHaveLength(1);
    expect(harness.watchers.handles[0]!.closed).toBe(true);
  });

  it("re-adds a loop only after its predecessor's watcher is closed (P1/AS8)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    harness.watchers.handles[0]!.holdClose();
    harness.manager.apply([]);
    await waitUntil(() => harness.watchers.handles[0]!.closing, "the held close");
    await tick();
    expect(harness.manager.watchedLoopIds()).toEqual([]);

    harness.manager.apply([item({ configRevision: 2 })]);
    expect(harness.manager.watchedLoopIds()).toEqual(["loop-1"]);
    // Give the admission every chance to subscribe early (the admission's own
    // root resolution is real fs I/O): with the retained close still in
    // flight, nothing may subscribe for this loop yet.
    // Mutation: subscribe without awaiting the retained close ⇒ a second live
    // watcher for the same loop before the first one is gone.
    await settleFor(150);
    expect(harness.watchers.handles).toHaveLength(1);

    harness.watchers.handles[0]!.releaseClose();
    await waitUntil(() => harness.watchers.handles.length === 2, "the re-added watcher");
    await waitUntil(() => harness.sync.calls.length === 2, "the re-added loop's full scan");
    expect(harness.watchers.openAtCreate).toEqual([0, 0]);
    expect(harness.sync.calls[1]!.reuseCachedHashes).toBe(false);
  });

  it("drains a stalled swap and leaves no live watcher behind (P1/AS12)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()], "d1");
    await waitForFirstScan(harness);

    harness.watchers.handles[0]!.holdClose();
    harness.manager.apply([item({ configRevision: 2 })], "d2");
    await waitUntil(() => harness.watchers.handles[0]!.closing, "the held close");

    const draining = harness.manager.drain(1_000);
    await tick();
    expect(harness.time.fire(1_000)).toBe(1); // the deadline fires: the close is still held
    expect(await draining).toEqual({ settled: false });
    expect(harness.logs.some((line) => line.includes("drain exceeded"))).toBe(true);

    harness.watchers.handles[0]!.releaseClose(); // the OS finally answers
    await harness.manager.settled();
    await tick();

    expect(harness.watchers.handles.filter((handle) => !handle.closed)).toHaveLength(0);
    expect(harness.watchers.handles).toHaveLength(1); // no successor was ever subscribed
    expect(harness.sync.calls.map((call) => call.target.configRevision)).toEqual([1]);
  });

  // ---- round-2 review fixes: the round/scan interleavings (P2) ----

  it("queues a follow-up round when the window expires while a round is in flight (P2)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    const releaseHold = harness.sync.hold();
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness); // round 2 is held
    expect(harness.sync.calls).toHaveLength(2);

    harness.watchers.handles[0]!.emit(); // the event that lands mid-round
    await fireWindow(harness); // its window expires BEFORE that round ends
    expect(harness.sync.calls).toHaveLength(2);
    expect(harness.time.pendingMs().filter((ms) => ms === ARTIFACT_WATCH_EVENT_MERGE_MS)).toHaveLength(0);

    // No new event, no new tick: the round that ends starts the catch-up.
    // Mutation: keep only a dirty flag and never re-check it ⇒ stays at 2.
    releaseHold();
    await waitUntil(() => harness.sync.calls.length === 3, "the catch-up round");
    await harness.manager.settled();
    expect(harness.sync.calls[2]!.reuseCachedHashes).toBe(true);
  });

  it("keeps a reconcile request at FULL rehash when it lands during a round (P2/AW11)", async () => {
    const harness = createHarness();
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    const releaseHold = harness.sync.hold();
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness); // an event round is held
    expect(harness.sync.calls).toHaveLength(2);

    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS); // the tick lands mid-round
    await tick();
    releaseHold();
    await waitUntil(() => harness.sync.calls.length === 3, "the tick's follow-up round");
    // Mutation: a plain boolean dirty flag ⇒ the follow-up would reuse the cache.
    expect(harness.sync.calls[2]!.reuseCachedHashes).toBe(false);
  });

  it("keeps an event window that expires exactly as the previous driver returns (#103)", async () => {
    const harness = createHarness();
    harness.manager.apply([item()]);
    await harness.manager.settled();
    let release!: (outcome: ArtifactSyncOutcome) => void;
    const held = new Promise<ArtifactSyncOutcome>((resolve) => { release = resolve; });
    harness.sync.client.syncLoop = (input) => {
      harness.sync.calls.push(input);
      return harness.sync.calls.length === 2 ? held : Promise.resolve({ kind: "unchanged" });
    };
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    harness.watchers.handles[0]!.emit();

    release({ kind: "unchanged" });
    // The round's continuation is already queued. Resolve the next window
    // one microtask later, at the driver's return / cleanup boundary.
    queueMicrotask(() => harness.time.fire(ARTIFACT_WATCH_EVENT_MERGE_MS));
    await tick();
    await harness.manager.settled();
    expect(harness.sync.calls).toHaveLength(3);
    expect(harness.sync.calls[2]!.reuseCachedHashes).toBe(true);
    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
  });

  it("never scans before `ready`: a pre-ready event is only recorded (P2/AW12)", async () => {
    const harness = createHarness();
    harness.watchers.autoReady.value = false;
    harness.manager.apply([item()]);
    await waitUntil(() => harness.watchers.handles.length === 1, "the watcher");

    harness.watchers.handles[0]!.emit();
    await tick();
    // Mutation: default the state to "watching" ⇒ a window opens and a scan
    // starts against a subscription that is not established yet.
    expect(harness.time.pendingMs().filter((ms) => ms === ARTIFACT_WATCH_EVENT_MERGE_MS)).toHaveLength(0);
    expect(harness.sync.calls).toHaveLength(0);

    harness.watchers.handles[0]!.releaseReady();
    await waitForFirstScan(harness);
    expect(harness.sync.calls[0]!.reuseCachedHashes).toBe(false); // the first scan rehashes
    await waitUntil(() => harness.sync.calls.length === 2, "the follow-up round for the pre-ready event");
    expect(harness.sync.calls[1]!.reuseCachedHashes).toBe(true);
  });

  it.each([false, true])("preserves FULL priority with a concurrent event window (expired: %s, #103)", async (expired) => {
    const harness = createHarness();
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);
    const release = harness.sync.hold();
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await tick();
    harness.watchers.handles[0]!.emit();
    if (expired) await fireWindow(harness);
    release();
    await waitUntil(() => harness.sync.calls.length === 3, "the queued full reconcile");
    expect(harness.sync.calls[2]!.reuseCachedHashes).toBe(false);
    if (!expired) {
      await tick();
      expect(harness.sync.calls).toHaveLength(3);
      await fireWindow(harness);
      await waitUntil(() => harness.sync.calls.length === 4, "the later event window");
      expect(harness.sync.calls[3]!.reuseCachedHashes).toBe(true);
    }
    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
  });

  it("waits for a first-scan event window to expire and cancels an unexpired window on drain (#103)", async () => {
    const harness = createHarness();
    const release = harness.sync.hold();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);
    harness.watchers.handles[0]!.emit();
    release();
    await tick();
    expect(harness.sync.calls).toHaveLength(1);
    await fireWindow(harness);
    expect(harness.sync.calls).toHaveLength(2);
    harness.watchers.handles[0]!.emit();
    expect(await harness.manager.drain(1_000)).toEqual({ settled: true });
    expect(harness.time.fire(ARTIFACT_WATCH_EVENT_MERGE_MS)).toBe(0);
    expect(harness.sync.calls).toHaveLength(2);
  });

  it("catches up when a window expires while the FIRST scan is in flight (P2)", async () => {
    const harness = createHarness();
    const releaseHold = harness.sync.hold();
    harness.manager.apply([item()]);
    await waitUntil(() => harness.sync.calls.length === 1, "the held first scan");

    harness.watchers.handles[0]!.emit();
    await fireWindow(harness); // the event's window expires mid-first-scan
    expect(harness.sync.calls).toHaveLength(1);

    releaseHold();
    await waitUntil(() => harness.sync.calls.length === 2, "the catch-up round");
    await harness.manager.settled();
    expect(harness.sync.calls[1]!.reuseCachedHashes).toBe(true);
  });

  it("does not scan on a reconcile tick that lands during admission (P2)", async () => {
    const harness = createHarness();
    harness.watchers.autoReady.value = false;
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitUntil(() => harness.watchers.handles.length === 1, "the watcher");

    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await tick();
    await tick();
    // The tick must ignore a loop that is still admitting. The structural
    // guard is `canRun` (a scan requires status `watching`), so no single-line
    // un-fix flips this; the interleaving is pinned because the review asked
    // for it explicitly.
    expect(harness.sync.calls).toHaveLength(0);
    expect(harness.watchers.handles).toHaveLength(1);

    harness.watchers.handles[0]!.releaseReady();
    await waitForFirstScan(harness);
    await tick();
    expect(harness.sync.calls).toHaveLength(1); // exactly the one full scan
    expect(harness.sync.calls[0]!.reuseCachedHashes).toBe(false);
  });

  it("never scans a generation that left the set while it was admitting (P2/AS8)", async () => {
    const harness = createHarness();
    harness.watchers.autoReady.value = false;
    harness.manager.apply([item()]);
    await waitUntil(() => harness.watchers.handles.length === 1, "the watcher");

    harness.manager.apply([]); // removed before `ready`
    expect(harness.manager.watchedLoopIds()).toEqual([]);

    harness.watchers.handles[0]!.releaseReady();
    await harness.manager.settled();
    await tick();
    // Requested interleaving (removal BEFORE `ready`). Structural guards: the
    // abort in `stopLoop` plus `canRun`, so no single-line un-fix flips it —
    // the assertions pin the behaviour, not one mutation.
    expect(harness.sync.calls).toHaveLength(0);
    expect(harness.watchers.handles[0]!.closed).toBe(true);
  });

  it("replaces a generation that was still admitting without scanning the old one (P2/AS7)", async () => {
    const harness = createHarness();
    harness.watchers.autoReady.value = false;
    harness.manager.apply([item()]);
    await waitUntil(() => harness.watchers.handles.length === 1, "the first watcher");

    harness.manager.apply([item({ configRevision: 2 })]);
    harness.watchers.handles[0]!.releaseReady(); // the superseded generation's `ready`
    await tick();
    // Same requested interleaving as the removal case, for a SWAP (AS7): the
    // superseded generation must not scan once its `ready` arrives late.
    expect(harness.sync.calls).toHaveLength(0); // the old generation never scanned

    harness.watchers.autoReady.value = true;
    harness.watchers.handles[1]?.releaseReady();
    await waitForFirstScan(harness);
    await harness.manager.settled();
    expect(harness.sync.calls).toHaveLength(1);
    expect(harness.sync.calls[0]!.target.configRevision).toBe(2);
    expect(harness.watchers.handles[0]!.closed).toBe(true);
  });

  it("closes the watcher when the root disappears and re-verifies locally (P2)", async () => {
    const harness = createHarness();
    harness.manager.start();
    harness.manager.apply([item()]);
    await waitForFirstScan(harness);

    harness.sync.setOutcome({
      kind: "failed",
      failure: "directory_missing",
      detail: "root vanished",
      reported: "recorded",
    });
    harness.watchers.handles[0]!.emit();
    await fireWindow(harness);
    // Mutation: only `outside_jail` counts as root-shaped ⇒ the watcher stays
    // open over a directory that is not there any more.
    await waitUntil(() => harness.watchers.handles[0]!.closed, "the vanished root's close");
    const callsAfterFailure = harness.sync.calls.length;

    // The tick re-verifies LOCALLY: with the root still gone it adds no request.
    rmSync(base, { recursive: true, force: true });
    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await tick();
    await tick();
    expect(harness.sync.calls).toHaveLength(callsAfterFailure);
    expect(harness.watchers.handles).toHaveLength(1);

    // Recovery: the root comes back ⇒ re-subscribe and FULL rehash.
    mkdirSync(base, { recursive: true });
    harness.sync.setOutcome({ kind: "unchanged" });
    await waitUntil(() => harness.time.pendingMs().includes(ARTIFACT_WATCH_RECONCILE_MS), "the re-armed tick");
    harness.time.fire(ARTIFACT_WATCH_RECONCILE_MS);
    await waitUntil(() => harness.watchers.handles.length === 2, "the recovered subscription");
    await waitUntil(() => harness.sync.calls.length === callsAfterFailure + 1, "the re-admission scan");
    expect(harness.sync.calls.at(-1)!.reuseCachedHashes).toBe(false);
  });
});
