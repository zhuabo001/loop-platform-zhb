/**
 * The daemon runtime (plan §3): poll/heartbeat orchestration DECOUPLED from
 * background execution (Phase 2 batch 1), the local queue, the activity
 * snapshot, and the report-retry machinery.
 *
 * Reliability contract (ADR-001, goal doc "可靠性约束"):
 *  - run identity belongs to the ORCHESTRATION layer: the final ReportRequest
 *    always carries `delivery.runId`, whatever the Runner returned;
 *  - a report is retried with the SAME credential and the SAME immutable body
 *    until it is confirmed (valid 2xx or coded 401), a protocol-fatal error
 *    stops the daemon, or the daemon stops — there is NO attempt cap and no
 *    persistence (the post-exit residue is the sweep's job, Day 8–10);
 *  - `pendingReports` has NO size limit: a long server outage grows it, and
 *    that is explicitly accepted — throttling by DROPPING claimed reports is
 *    forbidden (capacity/backpressure is the real-Agent phase's design);
 *  - poll/heartbeat and execution are decoupled: the poll loop keeps its
 *    cadence while the runner executes in the background, and every poll
 *    advertises capacity (`availableSlots` — cooperative backpressure, NOT a
 *    security boundary) plus a progress snapshot of every activity
 *    (queued ∪ executing ∪ reporting);
 *  - capacity is FIXED at 1: a queued run starts only when nothing is
 *    executing AND no report awaits confirmation — an unconfirmed report is
 *    occupied capacity, not idle time (the backpressure gate). A batch
 *    delivery from an old server queues locally and runs FIFO; that queueing
 *    is DEFENSIVE behavior only — against a Phase 1 server (which ignores
 *    `availableSlots` and progress) there is NO liveness promise for queued
 *    or long-running runs;
 *  - shutdown stops the poll sleep, in-flight HTTP and pending retries,
 *    drops the never-started queue, and JOINS the active execution pipeline
 *    (batch 2's real Claude subprocess must not outlive the daemon). It does
 *    NOT drain or persist unconfirmed reports.
 *
 * Time is injectable (`sleep`) so tests drive the backoff deterministically.
 */
import type { Delivery, PollRequest, RunProgress } from "@loopzhb/protocol";

import { serializeReportRequest, type MachineClient, type SerializedReportRequest } from "./client.js";
import type { AgentRunner, RunnerReport } from "./runner.js";

export class FatalDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalDaemonError";
  }
}

export const ERROR_CAP = 2000;
export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 30_000;

/** Progress entries per poll — aligned with the server's defensive cap. */
export const PROGRESS_SEND_CAP = 20;

/** Runtime-owned activity steps (Phase 2 batch 1; batch 3's runner events
 *  continue the counter past STEP_STARTING, and `reporting result` lands at
 *  last-step + 1 instead of a fixed value). NON-DECREASING per run,
 *  incremented only on a state transition or an accepted runner event — a
 *  repeated heartbeat for the same state repeats the same step. */
export const STEP_QUEUED = 0;
export const STEP_STARTING = 1;
/** The reporting step when NO runner events fired (the batch-1 shape). With
 *  runner events it is always lastStep + 1, i.e. ≥ STEP_REPORTING. */
export const STEP_REPORTING = 2;

/** Runner-event label hygiene (plan §2.1): NULs stripped, whitespace runs
 *  collapsed to single spaces (one line), capped at 200 chars. */
export const PROGRESS_LABEL_CAP = 200;

export function sanitizeProgressLabel(label: string): string {
  return label.replace(/\0/g, "").replace(/\s+/g, " ").trim().slice(0, PROGRESS_LABEL_CAP);
}

export interface PendingReport {
  runId: string;
  /** The Delivery's opaque runToken, held only to re-send. */
  credential: string;
  /** Serialized once at construction — every retry sends byte-identical JSON. */
  body: SerializedReportRequest;
  /** Attempts made so far (the immediate first try counts as #1). */
  attempt: number;
}

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export interface DaemonRuntimeDeps {
  client: MachineClient;
  runner: AgentRunner;
  identity: PollRequest;
  pollMs: number;
  /** Held only to scrub it out of Runner-thrown error text. */
  machineCredential: string;
  sleep?: SleepFn;
  log?: (line: string) => void;
}

export interface DaemonRuntime {
  /** Poll + dispatch (Phase 2 contract): sends ONE poll — the progress
   *  heartbeat and the availableSlots backpressure signal ride the body —
   *  enqueues any deliveries, and RETURNS. It does NOT wait for execution or
   *  the first report. A poll-fatal outcome throws immediately; a BACKGROUND
   *  fatal (a report's fatal classification lands after dispatch) surfaces
   *  here on the NEXT pollOnce — BEFORE the poll, and again IMMEDIATELY
   *  after it resolves (before any outcome/delivery handling, since the
   *  fatal aborts the runtime signal and a raced successful response must
   *  never refill the dropped queue) — or via run(). */
  pollOnce(): Promise<void>;
  /** The foreground loop: pollOnce, sleep pollMs, repeat until the signal
   *  aborts (clean return) or a fatal error surfaces (throw). On exit it
   *  aborts in-flight waits, drops the never-started queue, and JOINS the
   *  active execution pipeline — it never drains pendingReports. */
  run(signal: AbortSignal): Promise<void>;
  /** Resolves once the execution pipeline is quiescent (queue empty, nothing
   *  in flight, no active pipeline) — the production shutdown join AND the
   *  deterministic test sync point. Never resolves on abort alone (the
   *  runner must actually exit); never waits on pendingReports. */
  executionSettled(): Promise<void>;
  /** Test/observability accessors. */
  pendingCount(): number;
  inFlightCount(): number;
}

/** Resolve on schedule OR on abort (never rejects) — the loop re-checks its
 *  signals after every wake. */
export const defaultSleep: SleepFn = (ms, signal) =>
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

/** Sanitize a Runner-thrown value into the report's `error` field: the Error
 *  MESSAGE only (stacks are machine-local noise on the wire), NUL bytes
 *  stripped, every known credential redacted, trimmed, capped at ERROR_CAP.
 *  Never carries an `outcome` — Phase 1 derives outcome server-side from `ok`. */
export function sanitizeRunnerError(err: unknown, secrets: string[] = []): string {
  let text = err instanceof Error ? err.message : String(err);
  text = text.replace(/\0/g, "");
  for (const secret of secrets) {
    if (secret !== "") text = text.split(secret).join("[redacted]");
  }
  text = text.trim();
  if (text === "") text = "runner failed";
  return text.slice(0, ERROR_CAP);
}

export function createDaemonRuntime(deps: DaemonRuntimeDeps): DaemonRuntime {
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((): void => {});

  /** Claimed runs waiting for their turn (old-server batch deliveries). */
  const queue: Delivery[] = [];
  /** Runs the Runner has started but not finished (≤ 1 — fixed concurrency). */
  const inFlight = new Set<string>();
  /** Runs the Runner finished but whose report lacks terminal confirmation. */
  const pendingReports = new Map<string, PendingReport>();
  /** THE activity snapshot — queued ∪ executing ∪ reporting — and the ONE
   *  cross-cycle dedupe set (it covers both live sets above). Steps/labels
   *  are runtime-owned; batch 3's runner events keep incrementing them. */
  const activities = new Map<string, { step: number; label: string }>();

  /** The currently active execution pipeline, tracked so shutdown can JOIN
   *  it (and tests can synchronize on real quiescence). */
  let activePipeline: Promise<void> | null = null;
  const settleWaiters = new Set<() => void>();

  /** Round-robin cursor over the QUEUED activity slice (see collectProgress). */
  let rotationCursor = 0;

  /** One controller for EVERYTHING the daemon waits on: the CLI's signal
   *  aborts it via run(); a fatal error aborts it directly. pollOnce() is
   *  standalone-usable precisely because this signal exists pre-run(). */
  const stopCtl = new AbortController();
  const signal = stopCtl.signal;

  let fatal: FatalDaemonError | null = null;
  let running = false;
  const onOuterAbort = (): void => stopCtl.abort();

  function setFatal(err: FatalDaemonError): FatalDaemonError {
    fatal ??= err;
    stopCtl.abort();
    // The never-started queue can never run after a fatal — drop it so the
    // execution seam settles instead of waiting on a pipeline that will
    // never start (code-review round 1, P2). The pending report outbox
    // survives as postmortem.
    dropNeverStartedQueue();
    return fatal;
  }

  /** The claimed-but-never-started backlog: dropped on fatal and on shutdown.
   *  Its server-side residue is the sweep's job (reclaim), never re-run. */
  function dropNeverStartedQueue(): void {
    for (const d of queue) activities.delete(d.runId);
    queue.length = 0;
    notifySettle();
  }

  function pipelineQuiescent(): boolean {
    return queue.length === 0 && inFlight.size === 0 && activePipeline === null;
  }

  function notifySettle(): void {
    if (!pipelineQuiescent()) return;
    const waiters = [...settleWaiters];
    settleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function executionSettled(): Promise<void> {
    if (pipelineQuiescent()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      settleWaiters.add(resolve);
    });
  }

  function scheduleRetry(entry: PendingReport): void {
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (entry.attempt - 1));
    sleep(delay, signal)
      .then(() => {
        if (signal.aborted) return;
        if (pendingReports.get(entry.runId) !== entry) return;
        return attemptReport(entry);
      })
      .catch((err: unknown) => {
        setFatal(new FatalDaemonError(`report retry machinery failed for run ${entry.runId}: ${String(err)}`));
      });
  }

  /** The shared execution-idle sub-predicate: nothing running, no unconfirmed
   *  report. The queue conjunct is deliberately NOT in here — the dispatch
   *  gate needs a non-empty queue (work to start) while the wire signal needs
   *  an empty one (nothing waiting) to advertise a free slot; those two
   *  conjuncts have OPPOSITE polarity by design and must not be merged. */
  function executionIdle(): boolean {
    return inFlight.size === 0 && pendingReports.size === 0;
  }

  /** THE capacity gate (fixed concurrency 1): a queued run starts only when
   *  nothing is executing AND no report awaits confirmation — an unconfirmed
   *  report is occupied capacity, not idle time. Without the pendingReports
   *  conjunct, an old server's batch delivery (or a flaky report route) would
   *  pile up unconfirmed reports while new runs keep starting. */
  function maybeStartNext(): void {
    if (fatal || signal.aborted || !executionIdle() || queue.length === 0) return;
    const next = queue.shift()!;
    inFlight.add(next.runId);
    activities.set(next.runId, { step: STEP_STARTING, label: "starting claude-code" });
    const p = pipeline(next);
    activePipeline = p;
    void p
      .catch((err: unknown) => {
        setFatal(
          new FatalDaemonError(
            `execution pipeline failed for run ${next.runId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      })
      .finally(() => {
        // Identity check: a report confirmed INSIDE p may have re-entered
        // maybeStartNext and installed the next pipeline already.
        if (activePipeline === p) activePipeline = null;
        notifySettle();
      });
  }

  function enqueue(delivery: Delivery): void {
    activities.set(delivery.runId, { step: STEP_QUEUED, label: "queued" });
    queue.push(delivery);
    maybeStartNext();
  }

  async function attemptReport(entry: PendingReport): Promise<void> {
    entry.attempt += 1;
    const outcome = await deps.client.report(entry.credential, entry.body, signal);
    if (pendingReports.get(entry.runId) !== entry) return; // resolved meanwhile
    if (signal.aborted) return; // shutting down — the entry stays pending, never dropped
    switch (outcome.kind) {
      case "confirmed":
        pendingReports.delete(entry.runId);
        activities.delete(entry.runId);
        log(`run ${entry.runId}: report confirmed`);
        // Capacity released — a queued run may start now. (A retry keeps the
        // gate closed; a later confirmation re-enters through here.)
        maybeStartNext();
        break;
      case "retry":
        log(`run ${entry.runId}: report attempt ${entry.attempt} failed (${outcome.reason}) — will retry`);
        scheduleRetry(entry);
        break;
      case "fatal":
        setFatal(new FatalDaemonError(outcome.reason));
        break;
    }
  }

  async function pipeline(delivery: Delivery): Promise<void> {
    let report: RunnerReport;
    /** The runtime-owned progress sink (plan §2.1): accepts events ONLY while
     *  the run is inFlight — a callback that fires after the runner settled
     *  lands past the finally's inFlight.delete and is ignored. Each accepted
     *  event increments the run's step with its sanitized label; a label that
     *  sanitizes to empty carries no information and costs no step. */
    const onProgress = (label: string): void => {
      if (!inFlight.has(delivery.runId)) return;
      const current = activities.get(delivery.runId);
      if (current === undefined) return;
      const clean = sanitizeProgressLabel(label);
      if (clean === "") return;
      activities.set(delivery.runId, { step: current.step + 1, label: clean });
    };
    try {
      report = await deps.runner.run(delivery, { signal, onProgress });
    } catch (err) {
      report = { ok: false, error: sanitizeRunnerError(err, [delivery.runToken, deps.machineCredential]) };
    } finally {
      inFlight.delete(delivery.runId);
    }
    // The runner settled: the run now waits on report confirmation — one more
    // step past wherever the runner's events left it, so the step NEVER
    // regresses even when events fired (batch 3: lastStep + 1, not a fixed 2).
    const settled = activities.get(delivery.runId);
    activities.set(delivery.runId, { step: (settled?.step ?? STEP_STARTING) + 1, label: "reporting result" });
    // runId is the orchestration layer's, ALWAYS — a Runner-supplied value
    // (only possible via a type lie) is overwritten.
    let body: SerializedReportRequest;
    try {
      body = serializeReportRequest({ ...report, runId: delivery.runId });
    } catch {
      // `cursor` is intentionally unknown at the protocol seam and may contain
      // a non-JSON value. Treat an unserializable return as a Runner failure so
      // the claimed Run still reaches a terminal report.
      body = serializeReportRequest({
        runId: delivery.runId,
        ok: false,
        error: "runner returned a report that could not be serialized",
      });
    }
    const entry: PendingReport = { runId: delivery.runId, credential: delivery.runToken, body, attempt: 0 };
    pendingReports.set(entry.runId, entry);
    // Shutdown keeps the first report pending rather than sending it — the
    // entry is never dropped, and skipping the send lets the pipeline settle.
    if (signal.aborted) return;
    await attemptReport(entry);
  }

  /** The per-poll progress snapshot: executing/reporting entries ride EVERY
   *  poll (they carry the highest sweep-misreclaim risk); queued entries
   *  round-robin through the remaining budget so a >cap backlog still
   *  refreshes every entry within ceil(n/budget) polls. The promise holds
   *  under a healthy network and a BOUNDED backlog only — against a Phase 1
   *  server's unbounded batch delivery there is no liveness promise (the
   *  compat matrix). */
  function collectProgress(): RunProgress[] {
    const must: RunProgress[] = [];
    const queued: RunProgress[] = [];
    for (const [runId, a] of activities) {
      (a.step === STEP_QUEUED ? queued : must).push({ runId, step: a.step, label: a.label });
    }
    const out = [...must];
    const room = PROGRESS_SEND_CAP - out.length;
    if (room > 0 && queued.length > 0) {
      const start = rotationCursor % queued.length;
      const count = Math.min(room, queued.length);
      for (let i = 0; i < count; i += 1) {
        out.push(queued[(start + i) % queued.length]!);
      }
      rotationCursor = (start + count) % queued.length;
    }
    return out;
  }

  function buildPollBody(): PollRequest {
    // Idle ⇔ executionIdle AND nothing queued (the wire polarity of the queue
    // conjunct — see executionIdle's comment).
    const availableSlots = executionIdle() && queue.length === 0 ? (1 as const) : (0 as const);
    const progress = collectProgress();
    return { ...deps.identity, availableSlots, ...(progress.length > 0 ? { progress } : {}) };
  }

  async function pollOnce(): Promise<void> {
    // A background fatal set since the last poll surfaces BEFORE touching the
    // wire (code-review round 1, P1).
    if (fatal) throw fatal;
    const outcome = await deps.client.poll(buildPollBody(), signal);
    // A fatal that landed WHILE the poll was in flight surfaces BEFORE any
    // outcome or delivery handling: the real client classifies the abort as
    // transient (round 1, P1), and a SUCCESSFUL response must never dispatch
    // into the dropped queue — refilling it would hang executionSettled()
    // (round 2, P2).
    if (fatal) throw fatal;
    if (outcome.kind === "fatal") throw setFatal(new FatalDaemonError(outcome.reason));
    if (outcome.kind === "transient") {
      log(`poll: ${outcome.reason} — next cycle`);
      return;
    }
    const seenRunIds = new Set<string>();
    for (const delivery of outcome.deliveries) {
      // The protocol accepts a Delivery array, so defend against a duplicated
      // runId within one response even if the first report confirms immediately.
      if (seenRunIds.has(delivery.runId)) continue;
      seenRunIds.add(delivery.runId);
      // Across poll cycles, the server never re-delivers a claimed run; the
      // activity snapshot covers every legitimate unconfirmed window.
      if (activities.has(delivery.runId)) continue;
      enqueue(delivery);
    }
    // Defensive: no suspension point exists between the check above and the
    // dispatch loop, so a fatal cannot interleave here today — keep the
    // trailing check so a future synchronous fatal path still surfaces.
    if (fatal) throw fatal;
  }

  return {
    pollOnce,

    async run(outer: AbortSignal): Promise<void> {
      if (running) throw new Error("daemon runtime already running");
      running = true;
      if (outer.aborted) stopCtl.abort();
      else outer.addEventListener("abort", onOuterAbort, { once: true });
      try {
        for (;;) {
          if (fatal) throw fatal;
          if (signal.aborted) return;
          await pollOnce();
          await sleep(deps.pollMs, signal);
        }
      } finally {
        outer.removeEventListener("abort", onOuterAbort);
        stopCtl.abort();
        // Never start queued work after stop: the backlog is dropped (its
        // server-side residue is the sweep's job) — but the ACTIVE pipeline
        // is joined: batch 2's real Claude subprocess must not outlive the
        // daemon process. Unconfirmed reports are NOT drained (no cap, no
        // persistence — the contract above is unchanged).
        dropNeverStartedQueue();
        await executionSettled();
        running = false;
      }
    },

    executionSettled,

    pendingCount: () => pendingReports.size,
    inFlightCount: () => inFlight.size,
  };
}
