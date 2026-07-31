/**
 * The daemon runtime (plan §3): single-poll orchestration plus the foreground
 * loop, the two dedupe sets, and the background report-retry machinery.
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
 *  - background retries never block the poll loop;
 *  - shutdown stops the poll sleep, in-flight HTTP and pending retries. It
 *    does NOT drain or persist unconfirmed reports.
 *
 * Time is injectable (`sleep`) so tests drive the backoff deterministically.
 */
import type { Delivery, PollRequest } from "@loopzhb/protocol";

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
  /** One poll → execute → report cycle. Throws FatalDaemonError on a
   *  protocol-fatal outcome (poll 401/malformed, report fatal 4xx). */
  pollOnce(): Promise<void>;
  /** The foreground loop: pollOnce, sleep pollMs, repeat until the signal
   *  aborts (clean return) or a fatal error surfaces (throw). */
  run(signal: AbortSignal): Promise<void>;
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

  /** Runs the Runner has started but not finished. */
  const inFlight = new Set<string>();
  /** Runs the Runner finished but whose report lacks terminal confirmation. */
  const pendingReports = new Map<string, PendingReport>();

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
    return fatal;
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

  async function attemptReport(entry: PendingReport): Promise<void> {
    entry.attempt += 1;
    const outcome = await deps.client.report(entry.credential, entry.body, signal);
    if (pendingReports.get(entry.runId) !== entry) return; // resolved meanwhile
    if (signal.aborted) return; // shutting down — the entry stays pending, never dropped
    switch (outcome.kind) {
      case "confirmed":
        pendingReports.delete(entry.runId);
        log(`run ${entry.runId}: report confirmed`);
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

  async function execute(delivery: Delivery): Promise<void> {
    inFlight.add(delivery.runId);
    let report: RunnerReport;
    try {
      report = await deps.runner.run(delivery, signal);
    } catch (err) {
      report = { ok: false, error: sanitizeRunnerError(err, [delivery.runToken, deps.machineCredential]) };
    } finally {
      inFlight.delete(delivery.runId);
    }
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
    await attemptReport(entry);
  }

  async function pollOnce(): Promise<void> {
    const outcome = await deps.client.poll(deps.identity, signal);
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
      // Across poll cycles, the server never re-delivers a claimed run; these
      // two live sets cover the only legitimate unconfirmed windows.
      if (inFlight.has(delivery.runId) || pendingReports.has(delivery.runId)) continue;
      await execute(delivery);
      if (fatal) throw fatal;
    }
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
        running = false;
      }
    },

    pendingCount: () => pendingReports.size,
    inFlightCount: () => inFlight.size,
  };
}
