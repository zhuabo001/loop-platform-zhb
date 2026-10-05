/**
 * WatchManager (Phase 5 Batch 2 slice 5, ADR-010 决策 25): the daemon-side
 * owner of the artifact watch set. It receives the poll-delivered
 * `ArtifactWatchItem` set (through the runtime), keeps exactly one chokidar
 * subscription per configured loop, and drives the slice-4 sync client:
 *
 *  - SUBSCRIBE BEFORE THE FIRST SCAN: the watcher is opened and awaited
 *    `ready` before the initial full scan, and events arriving during that
 *    scan merely mark the loop dirty — nothing is lost (AW12);
 *  - events coalesce in a FIXED 250 ms window measured from the first event
 *    (never a reset debounce: a chunked write whose chunks are closer than
 *    the window apart would starve it, AW9), and a round that ends still
 *    dirty opens a fresh window;
 *  - a material watch-set change (any of the five item fields) performs the
 *    fixed generation swap — abort the old round, CLOSE THE OLD WATCHER, then
 *    subscribe the new root and full-scan (AS7); a removal cancels, closes and
 *    drops the state without any forced commit (AS8);
 *  - one instance-wide 60 s tick re-runs a FULL-rehash scan for every watching
 *    loop (the missed-event compensation, AW11) and locally re-verifies the
 *    ones whose watcher was refused or closed (jail/root failures) so a
 *    recovered root is re-admitted without a network round;
 *  - `drain` stops new events and timers, aborts every round, closes every
 *    watcher and joins the sync client's own settled() under a deadline —
 *    it NEVER issues a final commit and keeps no persistent outbox (AS12).
 *
 * Everything time-related goes through the injectable sleep seam (the
 * daemon's "time is injected, never faked" convention); the watcher factory
 * is injected so the whole state machine is testable without chokidar.
 */
import type { ArtifactSyncFailure, ArtifactWatchItem } from "@loopzhb/protocol";

import { guardArtifactRoot } from "./artifact-root-guard.js";
import { resolveArtifactRoot } from "./artifact-jail.js";
import type {
  ArtifactLocalFailureInput,
  ArtifactSyncInput,
  ArtifactSyncOutcome,
  ArtifactSyncSleepFn,
} from "./artifact-sync.js";
import type { ArtifactWatcher, ArtifactWatcherFactory } from "./artifact-watcher.js";

/** The event-merge window: a FIXED window from the first event (决策 25). */
export const ARTIFACT_WATCH_EVENT_MERGE_MS = 250;
/** The missed-event compensation cadence (批次计划 §1: 每 60 秒完整核对). */
export const ARTIFACT_WATCH_RECONCILE_MS = 60_000;

/** The watch-sync surface the manager needs — the slice-4 client satisfies it
 *  structurally, and tests inject a stub. */
export interface ArtifactWatchSync {
  syncLoop(input: ArtifactSyncInput): Promise<ArtifactSyncOutcome>;
  reportLocalFailure(input: ArtifactLocalFailureInput): Promise<ArtifactSyncOutcome>;
  clearStops(): void;
  settled(): Promise<void>;
}

export interface ArtifactWatchController {
  /** The digest echoed to the server on the next poll. Stored the moment a
   *  watch set is APPLIED (not when its watchers are up): the server compares
   *  digests, so re-sending the full set every poll would be pure waste. */
  currentDigest(): string | undefined;
  /** Synchronous, zero-I/O bookkeeping: the runtime calls this on the poll
   *  path, and all real work is launched in background tasks (the heartbeat
   *  is never blocked by a scan or an upload). */
  apply(items: readonly ArtifactWatchItem[], digest?: string): void;
  /** Starts the 60 s reconcile cadence. */
  start(): void;
  /** AS12: stop intake, close watchers, cancel rounds, join under a deadline. */
  drain(deadlineMs: number): Promise<{ settled: boolean }>;
  settled(): Promise<void>;
  /** Observability/test accessor: the loops currently in the watch set. */
  watchedLoopIds(): string[];
}

export interface ArtifactWatchManagerDeps {
  sync: ArtifactWatchSync;
  /** The daemon's canonical allowed roots (jail.daemonRoots) — the same set
   *  the sync client intersects every server-provided roots list with. */
  daemonRoots: readonly string[];
  createWatcher: ArtifactWatcherFactory;
  /** TEST-ONLY seam (the daemon's injectable time). */
  sleep?: ArtifactSyncSleepFn;
  log?: (line: string) => void;
}

type LoopStatus = "watching" | "refused" | "config_changed" | "parked";

interface LoopWatch {
  item: ArtifactWatchItem;
  /** Bumped on every swap/removal so a late window or round can never act on
   *  a generation that has been replaced. */
  generation: number;
  status: LoopStatus;
  /** Per-generation cancellation: aborted on swap, removal, park and drain. */
  ctl: AbortController;
  watcher: ArtifactWatcher | null;
  /** True once this generation's admission refusal has been reported (one
   *  report per generation, never one per tick). */
  reportedRefusal: boolean;
  dirty: boolean;
  windowCtl: AbortController | null;
  errorWindowCtl: AbortController | null;
  inFlight: Promise<void> | null;
}

const ROOT_FAILURES: ReadonlySet<ArtifactSyncFailure> = new Set(["outside_jail"]);

const defaultWatchSleep: ArtifactSyncSleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

function sameItem(a: ArtifactWatchItem, b: ArtifactWatchItem): boolean {
  if (
    a.loopId !== b.loopId ||
    a.artifactDir !== b.artifactDir ||
    a.workdir !== b.workdir ||
    a.configRevision !== b.configRevision ||
    a.roots.length !== b.roots.length
  ) {
    return false;
  }
  for (let index = 0; index < a.roots.length; index += 1) {
    if (a.roots[index] !== b.roots[index]) return false;
  }
  return true;
}

function sameWatchSet(a: readonly ArtifactWatchItem[], b: readonly ArtifactWatchItem[]): boolean {
  if (a.length !== b.length) return false;
  const previous = new Map(a.map((item) => [item.loopId, item]));
  for (const item of b) {
    const match = previous.get(item.loopId);
    if (match === undefined || !sameItem(match, item)) return false;
  }
  return true;
}

export function createArtifactWatchManager(deps: ArtifactWatchManagerDeps): ArtifactWatchController {
  const sleep = deps.sleep ?? defaultWatchSleep;
  const log = deps.log ?? ((): void => {});

  const states = new Map<string, LoopWatch>();
  let appliedItems: readonly ArtifactWatchItem[] = [];
  let appliedDigest: string | undefined;
  let machineStopped = false;
  let started = false;
  let draining = false;
  let reconcileCtl: AbortController | null = null;
  let outstanding = 0;
  const settleWaiters = new Set<() => void>();

  function enterWork(): void {
    outstanding += 1;
  }

  function leaveWork(): void {
    outstanding -= 1;
    if (outstanding !== 0) return;
    const waiters = [...settleWaiters];
    settleWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  /** Every background task runs through here: counted for drain, and its
   *  failure logged instead of becoming an unhandled rejection (one broken
   *  loop must never take the manager down). */
  function runWork(task: () => Promise<void>): Promise<void> {
    enterWork();
    return (async () => {
      try {
        await task();
      } catch (error) {
        log(`artifact watch: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        leaveWork();
      }
    })();
  }

  function settled(): Promise<void> {
    if (outstanding === 0) return Promise.resolve();
    return new Promise<void>((resolve) => settleWaiters.add(resolve));
  }

  async function closeWatcher(state: LoopWatch): Promise<void> {
    const watcher = state.watcher;
    state.watcher = null;
    if (watcher !== null) await watcher.close();
  }

  /** Local admission (zero network): the root must resolve inside the jail
   *  intersection AND pass the never-sync root guard (#91) before anything —
   *  not even a subscription — may look at it. */
  async function admit(
    item: ArtifactWatchItem,
  ): Promise<{ kind: "ok"; root: string } | { kind: "refused"; failure: ArtifactSyncFailure; detail: string }> {
    const resolution = await resolveArtifactRoot({
      artifactDir: item.artifactDir,
      workdir: item.workdir,
      serverRoots: item.roots,
      daemonRoots: deps.daemonRoots,
    });
    if (resolution.kind === "failed") {
      return { kind: "refused", failure: resolution.failure, detail: resolution.detail };
    }
    const guard = await guardArtifactRoot(resolution.resolved.root);
    if (guard.kind === "refused") {
      return { kind: "refused", failure: "outside_jail", detail: guard.detail };
    }
    return { kind: "ok", root: resolution.resolved.root };
  }

  async function handleOutcome(state: LoopWatch, outcome: ArtifactSyncOutcome): Promise<void> {
    if (outcome.kind === "stopped") {
      if (outcome.scope === "machine") {
        machineStopped = true;
        await parkAll();
        return;
      }
      await parkLoop(state);
      return;
    }
    if (outcome.kind === "config_changed") {
      // The server's config moved under this watch item; the next poll's drift
      // will re-deliver the set. Until then, do not keep syncing stale config.
      state.status = "config_changed";
      await closeWatcher(state);
      return;
    }
    if (outcome.kind === "failed" && ROOT_FAILURES.has(outcome.failure)) {
      // Jail/never-sync failures close the subscription; the 60 s tick locally
      // re-verifies and re-admits once the root is usable again (AW14).
      state.status = "refused";
      state.reportedRefusal = true;
      await closeWatcher(state);
    }
  }

  async function runSync(state: LoopWatch, mode: "event" | "full"): Promise<void> {
    if (state.inFlight !== null) {
      // A round is already running for this loop: the event merge collapses
      // into it and the fresh-window rule picks the change up afterwards.
      state.dirty = true;
      return;
    }
    if (state.ctl.signal.aborted || draining || machineStopped) return;
    const generation = state.generation;
    const target = state.item;
    let run!: Promise<void>;
    run = (async () => {
      try {
        const outcome = await deps.sync.syncLoop({
          target,
          daemonRoots: deps.daemonRoots,
          signal: state.ctl.signal,
          // The EVENT path is the only one allowed to reuse cached hashes
          // (决策 23/25); startup, this 60 s tick and slice 6 keep rehashing.
          reuseCachedHashes: mode === "event",
        });
        // A round that belongs to a REPLACED generation is void: its abort
        // raced its completion, and acting on it could close the successor's
        // watcher or park a healthy loop.
        if (state.generation !== generation) return;
        await handleOutcome(state, outcome);
      } finally {
        if (state.inFlight === run) state.inFlight = null;
      }
    })();
    state.inFlight = run;
    await run;
  }

  function openWindow(state: LoopWatch): void {
    const ctl = new AbortController();
    state.windowCtl = ctl;
    const generation = state.generation;
    void runWork(async () => {
      try {
        await sleep(ARTIFACT_WATCH_EVENT_MERGE_MS, ctl.signal);
        if (ctl.signal.aborted || draining || state.generation !== generation) return;
        state.windowCtl = null;
        if (!state.dirty) return;
        state.dirty = false;
        // Events that arrive DURING this round re-arm through markDirty: the
        // window controller is already null here, so the next event opens a
        // FRESH window instead of being folded into the finished one (AW12).
        await runSync(state, "event");
      } finally {
        if (state.windowCtl === ctl) state.windowCtl = null;
      }
    });
  }

  function markDirty(state: LoopWatch): void {
    if (draining || state.status !== "watching") return;
    state.dirty = true;
    if (state.windowCtl !== null) return; // a fixed window is already running
    openWindow(state);
  }

  function onWatcherError(state: LoopWatch, error: unknown): void {
    if (draining || state.status !== "watching") return;
    const detail = error instanceof Error ? error.message : String(error);
    if (state.errorWindowCtl !== null) return; // coalesce: one report per window
    const ctl = new AbortController();
    state.errorWindowCtl = ctl;
    void runWork(async () => {
      try {
        await sleep(ARTIFACT_WATCH_EVENT_MERGE_MS, ctl.signal);
        if (ctl.signal.aborted || draining) return;
        const outcome = await deps.sync.reportLocalFailure({
          target: state.item,
          failure: "watcher_error",
          detail,
          signal: state.ctl.signal,
        });
        await handleOutcome(state, outcome);
      } finally {
        if (state.errorWindowCtl === ctl) state.errorWindowCtl = null;
      }
    });
  }

  /** The generation start: subscribe (and await ready) BEFORE the full scan. */
  async function admitAndScan(state: LoopWatch): Promise<void> {
    if (draining || state.ctl.signal.aborted || machineStopped) return;
    const admission = await admit(state.item);
    if (draining || state.ctl.signal.aborted) return;
    if (admission.kind === "refused") {
      state.status = "refused";
      if (state.reportedRefusal) return;
      state.reportedRefusal = true;
      // Reuse the attempt path's reporting rules (baseline read, tri-state,
      // stop recording) through the sync client — one such probe per
      // generation, never one per tick.
      const outcome = await deps.sync.reportLocalFailure({
        target: state.item,
        failure: admission.failure,
        detail: admission.detail,
        signal: state.ctl.signal,
      });
      await handleOutcome(state, outcome);
      return;
    }
    const watcher = deps.createWatcher(admission.root);
    state.watcher = watcher;
    watcher.onEvent(() => markDirty(state));
    watcher.onError((error) => onWatcherError(state, error));
    await watcher.ready();
    if (draining || state.ctl.signal.aborted) {
      await closeWatcher(state);
      return;
    }
    state.status = "watching";
    await runSync(state, "full");
  }

  function newState(item: ArtifactWatchItem, generation: number): LoopWatch {
    return {
      item,
      generation,
      status: "watching", // until admission decides otherwise
      ctl: new AbortController(),
      watcher: null,
      reportedRefusal: false,
      dirty: false,
      windowCtl: null,
      errorWindowCtl: null,
      inFlight: null,
    };
  }

  /** AS7/AS8's fixed order: cancel the old generation, CLOSE the old watcher,
   *  and only then start the new one. The old ROUND is aborted but NOT awaited
   *  — its abort lands at the next boundary (a scan checks per frame/entry),
   *  and the generation guard makes a late outcome void either way; waiting
   *  here would let one slow round stall the swap indefinitely. */
  async function stopLoop(state: LoopWatch): Promise<void> {
    state.generation += 1;
    state.dirty = false;
    state.ctl.abort();
    state.windowCtl?.abort();
    state.errorWindowCtl?.abort();
    await closeWatcher(state);
  }

  async function parkLoop(state: LoopWatch): Promise<void> {
    await stopLoop(state);
    state.status = "parked";
  }

  async function parkAll(): Promise<void> {
    for (const state of states.values()) await parkLoop(state);
  }

  function launchAdmission(state: LoopWatch): void {
    void runWork(() => admitAndScan(state));
  }

  function reconcileSet(items: readonly ArtifactWatchItem[]): Promise<void> {
    return runWork(async () => {
      const wanted = new Map(items.map((item) => [item.loopId, item]));
      for (const [loopId, state] of [...states]) {
        if (wanted.has(loopId)) continue;
        // Drop it from the watch set FIRST: the loop is no longer watched the
        // moment the set says so, even while its resources wind down.
        states.delete(loopId);
        await stopLoop(state);
      }
      for (const item of items) {
        const state = states.get(item.loopId);
        if (state === undefined) {
          const created = newState(item, 1);
          states.set(item.loopId, created);
          launchAdmission(created);
          continue;
        }
        if (!sameItem(state.item, item)) {
          await stopLoop(state);
          const replaced = newState(item, state.generation + 1);
          states.set(item.loopId, replaced);
          launchAdmission(replaced);
          continue;
        }
        if (state.status === "parked") {
          // The set changed materially, which clears the stops — a parked loop
          // gets a fresh generation (and a fresh controller: the parked one
          // was aborted).
          state.generation += 1;
          state.ctl = new AbortController();
          state.status = "watching";
          launchAdmission(state);
        }
      }
    });
  }

  function apply(items: readonly ArtifactWatchItem[], digest?: string): void {
    if (draining) return;
    if (digest !== undefined) appliedDigest = digest;
    if (sameWatchSet(appliedItems, items)) return;
    appliedItems = items.map((item) => ({ ...item, roots: [...item.roots] }));
    // A material watch-set change IS the documented clearStops trigger
    // (决策 24/25: config generation swap / credential rotation).
    deps.sync.clearStops();
    machineStopped = false;
    void reconcileSet(appliedItems);
  }

  /** The 60 s compensation pass: a full-rehash round for every watching loop,
   *  and a LOCAL re-verification for the ones whose watcher was refused. */
  async function reconcileTick(): Promise<void> {
    for (const state of [...states.values()]) {
      if (draining) return;
      if (state.status === "watching") {
        await runSync(state, "full");
        continue;
      }
      if (state.status !== "refused" || machineStopped) continue;
      const admission = await admit(state.item);
      if (admission.kind === "refused" || draining || state.ctl.signal.aborted) continue;
      state.reportedRefusal = false;
      state.generation += 1;
      state.ctl = new AbortController();
      launchAdmission(state);
    }
  }

  function start(): void {
    if (started || draining) return;
    started = true;
    const ctl = new AbortController();
    reconcileCtl = ctl;
    void (async () => {
      while (!ctl.signal.aborted && !draining) {
        await sleep(ARTIFACT_WATCH_RECONCILE_MS, ctl.signal);
        if (ctl.signal.aborted || draining) return;
        await runWork(() => reconcileTick());
      }
    })();
  }

  async function drain(deadlineMs: number): Promise<{ settled: boolean }> {
    draining = true;
    reconcileCtl?.abort();
    const closes: Array<Promise<void>> = [];
    for (const state of states.values()) {
      state.generation += 1;
      state.dirty = false;
      state.ctl.abort();
      state.windowCtl?.abort();
      state.errorWindowCtl?.abort();
      closes.push(closeWatcher(state));
    }
    const join = (async (): Promise<void> => {
      await Promise.allSettled(closes);
      for (const state of states.values()) {
        if (state.inFlight !== null) await state.inFlight.catch(() => {});
      }
      await settled();
      await deps.sync.settled();
    })();
    // The deadline timer MUST be cleared when the join wins: a pending ref'd
    // timer would hold the process open for the rest of the budget after a
    // clean shutdown (the daemon would look hung to its supervisor).
    const deadlineCtl = new AbortController();
    const settledInTime = await Promise.race([
      join.then(() => true),
      sleep(deadlineMs, deadlineCtl.signal).then(() => false),
    ]);
    deadlineCtl.abort();
    if (!settledInTime) log(`artifact watch: drain exceeded its ${deadlineMs}ms deadline`);
    return { settled: settledInTime };
  }

  return {
    currentDigest: () => appliedDigest,
    apply,
    start,
    drain,
    settled,
    watchedLoopIds: () => [...states.keys()].sort(),
  };
}
