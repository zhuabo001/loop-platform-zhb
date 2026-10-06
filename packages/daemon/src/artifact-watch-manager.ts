/**
 * WatchManager (Phase 5 Batch 2 slice 5, ADR-010 决策 25): the daemon-side
 * owner of the artifact watch set. It receives the poll-delivered
 * `ArtifactWatchItem` set (through the runtime), keeps exactly one chokidar
 * subscription per configured loop, and drives the slice-4 sync client:
 *
 *  - SUBSCRIBE BEFORE THE FIRST SCAN: the watcher is opened and awaited
 *    `ready` before the initial full scan. Nothing scans before `ready`: an
 *    event seen during admission is only recorded, and the full scan that
 *    follows `ready` — plus the follow-up round it queues — covers it (AW12);
 *  - events coalesce in a FIXED 250 ms window measured from the first event
 *    (never a reset debounce: a chunked write whose chunks are closer than
 *    the window apart would starve it, AW9);
 *  - every round is driven to completion: work that arrives while a round is
 *    in flight (an event whose window expired mid-round, or a reconcile
 *    request) is recorded as PENDING and the round's own driver starts the
 *    follow-up the moment it ends, so a slow scan can never lose a window or
 *    degrade a reconcile request into the cached-hash event path;
 *  - a material watch-set change (any of the five item fields) performs the
 *    fixed generation swap — abort the old round, CLOSE THE OLD WATCHER, then
 *    subscribe the new root and full-scan (AS7); a removal cancels, closes and
 *    drops the state without any forced commit (AS8). The whole set is
 *    reconciled SYNCHRONOUSLY inside `apply` (no I/O, no await), so a suspended
 *    older set can never overwrite a newer one, and a successor never
 *    subscribes before its predecessor's watcher is closed — even across
 *    LoopWatch objects (removal → re-add);
 *  - one instance-wide 60 s tick re-runs a FULL-rehash scan for every watching
 *    loop (the missed-event compensation, AW11) and locally re-verifies the
 *    ones whose watcher was refused or closed (jail/root failures, including
 *    `directory_missing`: a vanished root closes its subscription and is
 *    re-admitted only after the local re-check succeeds) so a recovered root
 *    is re-admitted without a network round;
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

type LoopStatus = "admitting" | "watching" | "refused" | "config_changed" | "parked";

/** Why a round is due. The event path may reuse cached hashes; startup, the
 *  60 s reconcile and the (slice-6) final sync rehash everything (决策 23/25).
 *  A pending request keeps the STRONGER of the two modes, so a reconcile
 *  request recorded during a round is never downgraded to the cached path. */
type SyncMode = "event" | "full";

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
  /** Runnable work: events seen before `ready`, expired event windows, or
   *  reconcile requests. Events in an unexpired window are not pending yet;
   *  the running round's driver only consumes work already due. */
  pending: SyncMode | null;
  windowCtl: AbortController | null;
  errorWindowCtl: AbortController | null;
  inFlight: Promise<void> | null;
}

/** Root-shaped failures: the subscription is closed and the loop falls back to
 *  the tick's LOCAL re-verification (zero network) until its root is usable
 *  again. `directory_missing` belongs here too — a vanished root must neither
 *  keep a watcher alive nor keep round-tripping to the server. */
const ROOT_FAILURES: ReadonlySet<ArtifactSyncFailure> = new Set(["outside_jail", "directory_missing"]);

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
  /** Per loop, the newest watcher close. A successor NEVER subscribes before
   *  its predecessor is closed — across LoopWatch objects too (removal →
   *  re-add), so AS7's close-then-subscribe order holds for every generation. */
  const closes = new Map<string, Promise<void>>();
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

  /** True while this LoopWatch is still the map's entry for its loop. A new
   *  generation REPLACES the object, so a late admission, round or window of
   *  the predecessor must check this before writing anything. */
  function isCurrent(state: LoopWatch): boolean {
    return states.get(state.item.loopId) === state;
  }

  function canRun(state: LoopWatch): boolean {
    return (
      !draining &&
      !machineStopped &&
      !state.ctl.signal.aborted &&
      state.status === "watching" &&
      isCurrent(state)
    );
  }

  /** Close this generation's watcher and KEEP the close: the next generation
   *  of the same loop awaits it before subscribing, so the AS7 order survives
   *  a hanging close (and a removal → re-add never runs two watchers at once). */
  function closeWatcher(state: LoopWatch): Promise<void> {
    const watcher = state.watcher;
    state.watcher = null;
    const previous = closes.get(state.item.loopId);
    const close = (async (): Promise<void> => {
      if (previous !== undefined) await previous;
      if (watcher !== null) await watcher.close();
    })();
    closes.set(state.item.loopId, close);
    return close;
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

  /** Keep the stronger mode: a reconcile request must never degrade into the
   *  cached-hash event path just because an event is pending as well. */
  function notePending(state: LoopWatch, mode: SyncMode): void {
    state.pending = state.pending === "full" || mode === "full" ? "full" : "event";
  }

  /** One round per mode, then every round that was requested while it ran. The
   *  chain holds `inFlight` for its whole length, so a loop still runs ONE
   *  round at a time; a request that arrives mid-chain only extends it. */
  async function driveRounds(state: LoopWatch, first: SyncMode): Promise<void> {
    let mode = first;
    for (;;) {
      if (!canRun(state)) return;
      const generation = state.generation;
      const target = state.item;
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
      if (state.generation !== generation || !isCurrent(state)) return;
      await handleOutcome(state, outcome);
      const followUp = state.pending;
      if (followUp === null) return;
      state.pending = null;
      mode = followUp;
    }
  }

  function runSync(state: LoopWatch, mode: SyncMode): Promise<void> {
    if (state.inFlight !== null) {
      // A round is already running for this loop: this work is RECORDED and
      // the running round's driver starts the follow-up the moment it ends,
      // so a window that expires mid-round is never lost (决策 25).
      notePending(state, mode);
      return Promise.resolve();
    }
    if (!canRun(state)) return Promise.resolve();
    let run: Promise<void> | null = null;
    run = driveRounds(state, mode).finally(() => {
      if (state.inFlight === run) state.inFlight = null;
    });
    state.inFlight = run;
    return run;
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
    if (draining) return;
    if (state.status === "admitting") {
      // Nothing scans before `ready` (决策 25): the event is only recorded —
      // the admission's own FULL scan (which starts after `ready`) and the
      // follow-up round it queues cover it, with no pre-subscription scan.
      notePending(state, "event");
      return;
    }
    if (state.status !== "watching") return;
    if (state.windowCtl !== null) return; // a fixed window is already running
    openWindow(state);
  }

  function onWatcherError(state: LoopWatch, error: unknown): void {
    if (draining) return;
    if (state.status !== "watching" && state.status !== "admitting") return;
    const detail = error instanceof Error ? error.message : String(error);
    if (state.errorWindowCtl !== null) return; // coalesce: one report per window
    const generation = state.generation;
    const ctl = new AbortController();
    state.errorWindowCtl = ctl;
    void runWork(async () => {
      try {
        await sleep(ARTIFACT_WATCH_EVENT_MERGE_MS, ctl.signal);
        if (ctl.signal.aborted || draining || state.generation !== generation || !isCurrent(state)) {
          return;
        }
        const outcome = await deps.sync.reportLocalFailure({
          target: state.item,
          failure: "watcher_error",
          detail,
          signal: state.ctl.signal,
        });
        if (state.generation !== generation || !isCurrent(state)) return;
        await handleOutcome(state, outcome);
      } finally {
        if (state.errorWindowCtl === ctl) state.errorWindowCtl = null;
      }
    });
  }

  /** The generation start: subscribe (and await ready) BEFORE the full scan,
   *  and never before the PREVIOUS generation's watcher is closed. */
  async function admitAndScan(state: LoopWatch): Promise<void> {
    const generation = state.generation;
    const abandoned = (): boolean =>
      draining ||
      machineStopped ||
      state.ctl.signal.aborted ||
      state.generation !== generation ||
      state.status !== "admitting" ||
      !isCurrent(state);
    if (abandoned()) return;
    const admission = await admit(state.item);
    if (abandoned()) return;
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
      if (draining || state.generation !== generation || !isCurrent(state)) return;
      await handleOutcome(state, outcome);
      return;
    }
    const predecessor = closes.get(state.item.loopId);
    if (predecessor !== undefined) await predecessor;
    if (abandoned()) return;
    const watcher = deps.createWatcher(admission.root);
    state.watcher = watcher;
    watcher.onEvent(() => markDirty(state));
    watcher.onError((error) => onWatcherError(state, error));
    await watcher.ready();
    if (abandoned()) {
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
      status: "admitting", // until the subscription is ready and the scan ran
      ctl: new AbortController(),
      watcher: null,
      reportedRefusal: false,
      pending: null,
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
    state.pending = null;
    state.ctl.abort();
    state.windowCtl?.abort();
    state.errorWindowCtl?.abort();
    await closeWatcher(state);
  }

  async function parkLoop(state: LoopWatch): Promise<void> {
    // Publish the stop before close can suspend: apply may already restore
    // this loop while its predecessor's watcher is still closing.
    state.status = "parked";
    await stopLoop(state);
  }

  async function parkAll(): Promise<void> {
    // Cancel the entire stopped generation synchronously, then join its
    // closes. Never traverse a live map after awaiting an old close.
    const stopped = [...states.values()];
    const results = await Promise.allSettled(stopped.map((state) => parkLoop(state)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  function launchAdmission(state: LoopWatch): void {
    state.status = "admitting";
    void runWork(() => admitAndScan(state));
  }

  /** Reconcile the materialized watch set with the newly applied one.
   *
   *  Everything here is SYNCHRONOUS — no I/O, no `await` — so the whole set is
   *  reconciled inside `apply` before any other task can run. That removes the
   *  stale-pass defect class outright: there is no suspension point at which a
   *  newer set could arrive and be overwritten, so a slow close or a slow
   *  admission can never resurrect a removed loop or substitute an outdated
   *  one. All fallible work (root resolution, the never-sync guard, the
   *  subscription and the scan) lives in the admission task this launches, and
   *  a successor awaits the loop's retained close before it subscribes.
   *
   *  A loop that left the set stops being watched the moment the set says so
   *  (AS8): the state is dropped and its close is started here, in the
   *  background. */
  function reconcileSet(): void {
    const wanted = new Set(appliedItems.map((item) => item.loopId));
    for (const [loopId, state] of [...states]) {
      if (wanted.has(loopId)) continue;
      states.delete(loopId);
      void runWork(() => stopLoop(state));
    }
    for (const item of appliedItems) {
      const state = states.get(item.loopId);
      if (state === undefined) {
        const created = newState(item, 1);
        states.set(item.loopId, created);
        launchAdmission(created);
        continue;
      }
      if (!sameItem(state.item, item)) {
        // stopLoop's synchronous prefix (generation bump, abort) and the close
        // it retains both happen here; the successor below waits for that
        // close before it subscribes.
        void runWork(() => stopLoop(state));
        const replaced = newState(item, state.generation + 1);
        states.set(item.loopId, replaced);
        launchAdmission(replaced);
        continue;
      }
      if (state.status === "parked") {
        // The set changed materially, which clears the stops — a parked loop
        // gets a fresh object too: its old driver may still be in flight.
        const restored = newState(item, state.generation + 1);
        states.set(item.loopId, restored);
        launchAdmission(restored);
      }
    }
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
    reconcileSet();
  }

  /** The 60 s compensation pass: a full-rehash round for every watching loop,
   *  and a LOCAL re-verification for the ones whose watcher was refused. */
  async function reconcileTick(): Promise<void> {
    for (const state of [...states.values()]) {
      if (draining) return;
      const generation = state.generation;
      if (state.status === "watching") {
        await runSync(state, "full");
        continue;
      }
      if (state.status !== "refused" || machineStopped) continue;
      const admission = await admit(state.item);
      if (
        admission.kind === "refused" ||
        draining ||
        state.ctl.signal.aborted ||
        state.generation !== generation ||
        !isCurrent(state)
      ) {
        continue;
      }
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
    const closesInFlight: Array<Promise<void>> = [];
    for (const state of states.values()) {
      state.generation += 1;
      state.pending = null;
      state.ctl.abort();
      state.windowCtl?.abort();
      state.errorWindowCtl?.abort();
      closesInFlight.push(closeWatcher(state));
    }
    const join = (async (): Promise<void> => {
      await Promise.allSettled(closesInFlight);
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
