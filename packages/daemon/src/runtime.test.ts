/**
 * Runtime pins (goal doc test list 2/3/4 + review rulings): runId ownership,
 * dedupe via the activity snapshot (queued ∪ executing ∪ reporting),
 * same-credential same-body retries with 1s→30s backoff that never block
 * poll, the lost-response → coded-401 self-heal, Runner-throw synthesis
 * (sanitized, no outcome), fatal propagation, and shutdown semantics.
 * Phase 2 batch 1 adds the decoupling contract: poll keeps its cadence while
 * the runner executes in the background, availableSlots/progress ride every
 * poll body, an unconfirmed report is occupied capacity (backpressure gate),
 * and shutdown JOINS the active pipeline without draining the report outbox.
 *
 * Time is a manual sleep queue; the client is a stub — transport-level
 * classification lives in client.test.ts. Assertions that depend on the
 * background pipeline synchronize on `executionSettled()`.
 */
import { describe, expect, it } from "vitest";

import type { Delivery, PollRequest, ReportRequest } from "@loopzhb/protocol";

import {
  createMachineClient,
  type MachineClient,
  type PollOutcome,
  type ReportOutcome,
  type SerializedReportRequest,
} from "./client.js";
import type { AgentRunner, RunnerContext, RunnerReport } from "./runner.js";
import {
  ERROR_CAP,
  FatalDaemonError,
  createDaemonRuntime,
  sanitizeRunnerError,
  type SleepFn,
} from "./runtime.js";

const MACHINE_CRED = "dk_test_machine";
const IDENTITY: PollRequest = { host: "h", platform: "linux", arch: "x64", version: "0.1.0" };

function delivery(runId: string): Delivery {
  return {
    runId,
    runToken: `rk_tok_${runId}`,
    role: "exec",
    loop: { id: "loop-1", name: "Loop", workdir: null, taskFile: null, workflow: null, model: null, allowControl: false },
    prevState: null,
    roots: [],
    systemPrompt: "",
    task: "do it",
  };
}

class StubClient implements MachineClient {
  pollQueue: PollOutcome[] = [];
  reportQueue: ReportOutcome[] = [];
  polls: PollRequest[] = [];
  reports: { credential: string; body: SerializedReportRequest }[] = [];
  reportJson: string[] = [];
  poll(body: PollRequest): Promise<PollOutcome> {
    this.polls.push(body);
    return Promise.resolve(this.pollQueue.shift() ?? { kind: "ok", deliveries: [] });
  }
  report(credential: string, body: SerializedReportRequest): Promise<ReportOutcome> {
    this.reports.push({ credential, body });
    this.reportJson.push(body.json);
    return Promise.resolve(this.reportQueue.shift() ?? { kind: "confirmed" });
  }
}

interface SleepCall {
  ms: number;
  resolve: () => void;
}

function manualSleep(): { sleep: SleepFn; calls: SleepCall[]; delays: number[]; fireNext: () => void } {
  const calls: SleepCall[] = [];
  const delays: number[] = [];
  const sleep: SleepFn = (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      delays.push(ms);
      calls.push({ ms, resolve });
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  return { sleep, calls, delays, fireNext: () => calls.shift()?.resolve() };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const OK_RUNNER: RunnerReport = { ok: true, outcome: "exec", message: "fake runner completed", durationMs: 0 };

function captureRunner(impl?: (delivery: Delivery, ctx: RunnerContext) => Promise<RunnerReport>) {
  const calls: { delivery: Delivery; ctx: RunnerContext }[] = [];
  const runner: AgentRunner = {
    run(delivery, ctx) {
      calls.push({ delivery, ctx });
      return impl ? impl(delivery, ctx) : Promise.resolve(OK_RUNNER);
    },
  };
  return { runner, calls };
}

function makeRuntime(overrides: Partial<Parameters<typeof createDaemonRuntime>[0]> = {}) {
  const client = new StubClient();
  const clock = manualSleep();
  const logs: string[] = [];
  const selectedRunner = overrides.runner;
  const { runner, calls: runnerCalls } = captureRunner(
    selectedRunner ? (delivery, ctx) => selectedRunner.run(delivery, ctx) : undefined,
  );
  const rt = createDaemonRuntime({
    client,
    identity: IDENTITY,
    pollMs: 3000,
    machineCredential: MACHINE_CRED,
    sleep: clock.sleep,
    log: (line) => logs.push(line),
    ...overrides,
    runner,
  });
  return { rt, client, clock, logs, runnerCalls };
}

describe("happy path", () => {
  it("poll → runner → report confirmed; both sets drain; logs never carry credentials", async () => {
    const { rt, client, logs, runnerCalls } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce();
    await rt.executionSettled();

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.delivery.runId).toBe("run-1");
    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]!.credential).toBe("rk_tok_run-1");
    expect(JSON.parse(client.reports[0]!.body.json)).toEqual({ ...OK_RUNNER, runId: "run-1" });
    expect(rt.inFlightCount()).toBe(0);
    expect(rt.pendingCount()).toBe(0);
    expect(logs.join("\n")).not.toContain("rk_tok_run-1");
    expect(logs.join("\n")).not.toContain(MACHINE_CRED);
  });

  it("writes delivery.runId unconditionally, even over a Runner type-lie", async () => {
    const { runner } = captureRunner(() =>
      Promise.resolve({ ...OK_RUNNER, runId: "evil" } as RunnerReport),
    );
    const { rt, client } = makeRuntime({ runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce();
    await rt.executionSettled();

    const body = JSON.parse(client.reports[0]!.body.json) as ReportRequest;
    expect(body.runId).toBe("run-1");
  });
});

describe("dedupe", () => {
  it("executes a duplicated runId only once within one poll response", async () => {
    const { rt, client, runnerCalls } = makeRuntime();
    const sameDelivery = delivery("run-1");
    client.pollQueue.push({ kind: "ok", deliveries: [sameDelivery, sameDelivery] });

    await rt.pollOnce();
    await rt.executionSettled();

    expect(runnerCalls).toHaveLength(1);
    expect(client.reports).toHaveLength(1);
  });

  it("a redelivered runId in inFlight or pendingReports never re-executes the Runner", async () => {
    const { rt, client, runnerCalls } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" });
    await rt.pollOnce();
    await rt.executionSettled();
    expect(rt.pendingCount()).toBe(1);

    // Server redelivers the SAME runId while its report is still unconfirmed.
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    await rt.pollOnce();

    expect(runnerCalls).toHaveLength(1);
    expect(client.reports).toHaveLength(1);
  });
});

describe("report retry", () => {
  it("retries the exact wire snapshot when the Runner mutates a retained nested reference", async () => {
    const cost = { usd: 1 };
    const { runner } = captureRunner(() => Promise.resolve({ ...OK_RUNNER, cost }));
    const { rt, client, clock } = makeRuntime({ runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    await rt.pollOnce();
    await rt.executionSettled();
    cost.usd = 9;
    clock.fireNext();
    await flush();
    await flush();

    expect(client.reportJson).toHaveLength(2);
    expect(client.reportJson[1]).toBe(client.reportJson[0]);
    expect(JSON.parse(client.reportJson[1]!)).toMatchObject({ cost: { usd: 1 } });
  });

  it("retries with the same credential/body on 1s→2s→4s backoff, without blocking poll", async () => {
    const { rt, client, clock } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "retry", reason: "HTTP 503" });

    await rt.pollOnce();
    await rt.executionSettled();
    expect(client.reports).toHaveLength(1);
    expect(clock.calls.map((c) => c.ms)).toEqual([1000]);

    // The foreground loop is NOT blocked by the pending retry.
    await rt.pollOnce();
    expect(client.polls).toHaveLength(2);

    clock.fireNext();
    await flush();
    await flush();
    expect(client.reports).toHaveLength(2);
    expect(client.reports[1]).toEqual(client.reports[0]); // same credential, byte-identical body
    expect(clock.calls.map((c) => c.ms)).toEqual([2000]);

    clock.fireNext();
    await flush();
    await flush();
    expect(client.reports).toHaveLength(3);
    expect(rt.pendingCount()).toBe(0); // third attempt confirmed
  });

  it("caps the backoff at 30s", async () => {
    const { rt, client, clock } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push(
      { kind: "retry", reason: "x" },
      { kind: "retry", reason: "x" },
      { kind: "retry", reason: "x" },
      { kind: "retry", reason: "x" },
      { kind: "retry", reason: "x" },
      { kind: "retry", reason: "x" },
    );
    await rt.pollOnce();
    await rt.executionSettled();
    for (let i = 0; i < 5; i += 1) {
      clock.fireNext();
      await flush();
      await flush();
    }
    // Delays scheduled after attempts 1..6: 1s, 2s, 4s, 8s, 16s, then capped 30s.
    expect(clock.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("lost response self-heals: the re-report's coded 401 is a terminal confirmation", async () => {
    const { rt, client, clock } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    // First attempt's response was lost (retry); the re-report meets the
    // already-consumed lease → coded 401 → the CLIENT classifies confirmed.
    client.reportQueue.push({ kind: "retry", reason: "request timeout after 10000ms" }, { kind: "confirmed" });

    await rt.pollOnce();
    await rt.executionSettled();
    expect(rt.pendingCount()).toBe(1);
    clock.fireNext();
    await flush();
    await flush();

    expect(rt.pendingCount()).toBe(0);
    expect(client.reports).toHaveLength(2);
  });
});

describe("Runner failure synthesis", () => {
  it("turns a non-JSON-serializable Runner report into a safe failure report", async () => {
    const { runner } = captureRunner(() => Promise.resolve({ ...OK_RUNNER, cursor: 1n }));
    const { rt, client } = makeRuntime({ runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await expect(rt.pollOnce()).resolves.toBeUndefined();
    await rt.executionSettled();

    const body = JSON.parse(client.reports[0]!.body.json) as ReportRequest;
    expect(body).toEqual({
      runId: "run-1",
      ok: false,
      error: "runner returned a report that could not be serialized",
    });
  });

  it("Runner-thrown errors become { ok:false, error } — sanitized, capped, credential-free, NO outcome", async () => {
    const d = delivery("run-1");
    const { runner } = captureRunner(() =>
      Promise.reject(new Error(`boom\0 with ${d.runToken} and ${MACHINE_CRED}`)),
    );
    const { rt, client } = makeRuntime({ runner });
    client.pollQueue.push({ kind: "ok", deliveries: [d] });

    await rt.pollOnce();
    await rt.executionSettled();

    const body = JSON.parse(client.reports[0]!.body.json) as ReportRequest;
    expect(body.ok).toBe(false);
    expect(body).not.toHaveProperty("outcome");
    expect(body.error).toBeDefined();
    expect(body.error).not.toContain("\0");
    expect(body.error).not.toContain(d.runToken);
    expect(body.error).not.toContain(MACHINE_CRED);
    expect(body.error).toContain("[redacted]");
    expect(body.error!.length).toBeLessThanOrEqual(ERROR_CAP);
  });

  it("sanitizeRunnerError: caps at 2000 chars and falls back on empty/non-Error input", () => {
    expect(sanitizeRunnerError(new Error("x".repeat(5000)))).toHaveLength(ERROR_CAP);
    expect(sanitizeRunnerError("plain string")).toContain("plain string");
    expect(sanitizeRunnerError(new Error("   \0  "))).toBe("runner failed");
  });
});

describe("fatal classification", () => {
  it("poll fatal (401 / malformed 2xx) rejects pollOnce with FatalDaemonError", async () => {
    const { rt, client } = makeRuntime();
    client.pollQueue.push({ kind: "fatal", reason: "machine credential rejected (401)" });
    await expect(rt.pollOnce()).rejects.toThrow(FatalDaemonError);
  });

  it("report fatal (other 4xx / unparseable 401) stops the foreground loop", async () => {
    const { rt, client } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "fatal", reason: "report HTTP 400" });

    const ctl = new AbortController();
    await expect(rt.run(ctl.signal)).rejects.toThrow(FatalDaemonError);
    // The claimed report was NOT dropped — it stays pending for postmortem.
    expect(rt.pendingCount()).toBe(1);
  });
});

describe("shutdown", () => {
  it("propagates shutdown through the runtime into an in-flight HTTP poll", async () => {
    let markStarted: ((signal: AbortSignal) => void) | undefined;
    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve;
    });
    const client = createMachineClient({
      baseUrl: "http://server.test",
      machineCredential: MACHINE_CRED,
      timeoutMs: 60_000,
      fetchImpl: (_input, init) => {
        const requestSignal = init?.signal as AbortSignal;
        markStarted?.(requestSignal);
        return new Promise<Response>((_resolve, reject) => {
          requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        });
      },
    });
    const { rt } = makeRuntime({ client });
    const ctl = new AbortController();

    const done = rt.run(ctl.signal);
    const requestSignal = await started;
    expect(requestSignal.aborted).toBe(false);

    ctl.abort();
    await expect(done).resolves.toBeUndefined();
    expect(requestSignal.aborted).toBe(true);
  });

  it("passes the daemon signal to the Runner; SIGINT resolves run() cleanly", async () => {
    const { rt, client, runnerCalls } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    const ctl = new AbortController();
    const done = rt.run(ctl.signal);
    await flush(); // first pollOnce + confirmed report; loop now sleeping pollMs
    expect(runnerCalls).toHaveLength(1);

    ctl.abort();
    await expect(done).resolves.toBeUndefined();
    expect(runnerCalls[0]!.ctx.signal.aborted).toBe(true); // the Runner seam carries the shutdown
  });

  it("fires no report retry after stop (the pending entry survives, un-dropped)", async () => {
    const { rt, client, clock } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    const ctl = new AbortController();
    const done = rt.run(ctl.signal);
    await flush();
    await flush();
    expect(client.reports).toHaveLength(1);
    expect(rt.pendingCount()).toBe(1);

    ctl.abort();
    await done;
    clock.fireNext(); // even if a stale timer fires…
    await flush();
    expect(client.reports).toHaveLength(1); // …no retry goes out
    expect(rt.pendingCount()).toBe(1);
  });

  it("run() refuses a second start", async () => {
    const { rt } = makeRuntime();
    const ctl = new AbortController();
    const first = rt.run(ctl.signal);
    await expect(rt.run(new AbortController().signal)).rejects.toThrow(/already running/);
    ctl.abort();
    await first;
  });
});

describe("execution decoupling (Phase 2 batch 1)", () => {
  /** A runner whose every call blocks until the test releases it. */
  function gatedRunner() {
    const calls: { delivery: Delivery; ctx: RunnerContext; release: (report: RunnerReport) => void }[] = [];
    const runner: AgentRunner = {
      run: (d: Delivery, ctx: RunnerContext) =>
        new Promise<RunnerReport>((resolve) => {
          calls.push({ delivery: d, ctx, release: resolve });
        }),
    };
    return { runner, calls };
  }

  it("keeps polling while the runner is blocked; busy polls carry availableSlots:0 + progress, idle polls availableSlots:1 with no progress key", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce();
    expect(client.polls[0]).toMatchObject({ availableSlots: 1 });
    expect(client.polls[0]).not.toHaveProperty("progress");
    expect(gated.calls).toHaveLength(1); // the runner started in the BACKGROUND

    // The runner is still blocked — the next poll is not.
    await rt.pollOnce();
    expect(client.polls).toHaveLength(2);
    expect(client.polls[1]).toMatchObject({ availableSlots: 0 });
    expect(client.polls[1]!.progress).toEqual([{ runId: "run-1", step: 1, label: "starting claude-code" }]);

    gated.calls[0]!.release(OK_RUNNER);
    await rt.executionSettled();
    expect(rt.inFlightCount()).toBe(0);
    expect(rt.pendingCount()).toBe(0);

    await rt.pollOnce();
    expect(client.polls[2]).toMatchObject({ availableSlots: 1 });
    expect(client.polls[2]).not.toHaveProperty("progress");
  });

  it("queues a batch delivery locally and runs it FIFO, one at a time — a redelivered queued runId is not enqueued twice (defensive behavior, NO liveness promise)", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1"), delivery("run-2")] });

    await rt.pollOnce();
    expect(gated.calls.map((c) => c.delivery.runId)).toEqual(["run-1"]); // ONE started, one queued

    // An old server may redeliver the still-queued run — it stays ONE entry.
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-2")] });
    await rt.pollOnce();

    gated.calls[0]!.release(OK_RUNNER); // run-1 done → report confirmed → run-2 starts
    await flush();
    await flush();
    expect(gated.calls.map((c) => c.delivery.runId)).toEqual(["run-1", "run-2"]);

    gated.calls[1]!.release(OK_RUNNER);
    await rt.executionSettled();
    expect(gated.calls).toHaveLength(2); // the redelivery never created a second queue entry
    expect(rt.pendingCount()).toBe(0);
  });

  it("does not start the queued run while a report is unconfirmed — capacity is inFlight ∪ queue ∪ pendingReports", async () => {
    const gated = gatedRunner();
    const { rt, client, clock } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1"), delivery("run-2")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    await rt.pollOnce();
    gated.calls[0]!.release(OK_RUNNER); // run-1's first report attempt → retry
    await flush();
    await flush();
    expect(rt.pendingCount()).toBe(1);
    expect(gated.calls).toHaveLength(1); // run-2 held by the backpressure gate

    clock.fireNext(); // the retry confirms → capacity releases → run-2 starts
    await flush();
    await flush();
    expect(gated.calls.map((c) => c.delivery.runId)).toEqual(["run-1", "run-2"]);

    gated.calls[1]!.release(OK_RUNNER);
    await rt.executionSettled();
    expect(rt.pendingCount()).toBe(0);
  });

  it("advertises busy + 'reporting result' while a report retries, then returns to availableSlots:1 with progress gone", async () => {
    const gated = gatedRunner();
    const { rt, client, clock } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    await rt.pollOnce();
    gated.calls[0]!.release(OK_RUNNER);
    await rt.executionSettled(); // settles WITH the report still pending — the outbox is never drained
    expect(rt.pendingCount()).toBe(1);

    await rt.pollOnce();
    expect(client.polls.at(-1)).toMatchObject({ availableSlots: 0 });
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 2, label: "reporting result" }]);

    clock.fireNext();
    await flush();
    await flush();
    expect(rt.pendingCount()).toBe(0);

    await rt.pollOnce();
    expect(client.polls.at(-1)).toMatchObject({ availableSlots: 1 });
    expect(client.polls.at(-1)).not.toHaveProperty("progress");
  });

  it("keeps a run's step non-decreasing and increments it only on state transitions", async () => {
    const gated = gatedRunner();
    const { rt, client, clock } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    await rt.pollOnce(); // body built BEFORE dispatch — idle, no progress yet
    await rt.pollOnce(); // executing — step 1
    await rt.pollOnce(); // still executing — same step, no increment
    gated.calls[0]!.release(OK_RUNNER); // → reporting (retry pending)
    await flush();
    await flush();
    await rt.pollOnce();
    clock.fireNext(); // confirmed
    await flush();
    await flush();
    await rt.pollOnce(); // drained — no progress at all

    const steps = client.polls.flatMap((p) =>
      (p.progress ?? []).filter((e) => e.runId === "run-1").map((e) => e.step),
    );
    expect(steps).toEqual([1, 1, 2]); // non-decreasing; same-state repeats keep the step
  });

  it("round-robins queued progress entries within the 20-entry budget while the executing entry rides every poll (healthy-network, bounded-backlog fairness)", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    const batch = Array.from({ length: 25 }, (_, i) => delivery(`run-${i + 1}`));
    client.pollQueue.push({ kind: "ok", deliveries: batch });

    await rt.pollOnce();
    expect(gated.calls).toHaveLength(1);
    const executingId = gated.calls[0]!.delivery.runId;

    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      await rt.pollOnce();
      const entries = client.polls.at(-1)!.progress ?? [];
      expect(entries.length).toBeLessThanOrEqual(20);
      expect(entries.some((e) => e.runId === executingId)).toBe(true); // executing rides EVERY poll
      for (const e of entries) seen.add(e.runId);
    }
    expect(seen.size).toBe(25); // 24 queued rotate through 19 slots/poll → all refreshed by poll 2
  });

  it("joins the active pipeline on shutdown: run() resolves only after the runner actually exits; queued work never starts; pendingReports is not drained", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1"), delivery("run-2")] });

    const ctl = new AbortController();
    let resolved = false;
    const done = rt.run(ctl.signal).then(() => {
      resolved = true;
    });
    await flush(); // first poll dispatched: run-1 executing (blocked), run-2 queued
    expect(gated.calls).toHaveLength(1);

    ctl.abort();
    await flush();
    expect(resolved).toBe(false); // JOIN: the blocked runner still holds run() open

    gated.calls[0]!.release(OK_RUNNER); // the runner finally exits
    await done;
    expect(resolved).toBe(true);
    expect(gated.calls).toHaveLength(1); // run-2 never started
    expect(client.reports).toHaveLength(0); // the first report is NOT sent during shutdown…
    expect(rt.pendingCount()).toBe(1); // …but the entry is kept, never drained
  });

  it("surfaces a background report fatal on the NEXT pollOnce — a report fatal can no longer reject an already-returned pollOnce", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "fatal", reason: "report HTTP 400" });

    await rt.pollOnce(); // returns BEFORE the background pipeline reports — must NOT throw
    gated.calls[0]!.release(OK_RUNNER);
    await rt.executionSettled(); // the background report ran and classified fatal
    expect(rt.pendingCount()).toBe(1); // the entry stays pending for postmortem

    await expect(rt.pollOnce()).rejects.toThrow(FatalDaemonError);
  });

  it("surfaces a background fatal that lands WHILE a poll is in flight — the REAL client classifies the abort as transient, and pollOnce must still throw (abort-isolation regression)", async () => {
    const gated = gatedRunner();
    // Real MachineClient over a scripted transport that honors the runtime
    // signal exactly like fetch does: an in-flight poll rejects when the
    // signal aborts, and the client maps that to `transient`. A fatal set by
    // the background report must NOT be swallowed by that transient branch.
    let pollCount = 0;
    const client = createMachineClient({
      baseUrl: "http://server.test",
      machineCredential: MACHINE_CRED,
      fetchImpl: (_input, init) => {
        const requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve, reject) => {
          const onAbort = () => reject(requestSignal.reason);
          requestSignal.addEventListener("abort", onAbort, { once: true });
          if (requestSignal.aborted) {
            reject(requestSignal.reason);
            return;
          }
          const url = String(_input);
          if (url.includes("/api/machine/poll")) {
            pollCount += 1;
            if (pollCount === 1) {
              queueMicrotask(() =>
                resolve(new Response(JSON.stringify({ deliveries: [delivery("run-1")] }), { status: 200 })),
              );
            }
            // poll #2: block until the runtime abort lands — the real
            // transport's in-flight behavior.
          } else {
            // /api/machine/report → other 4xx = protocol-fatal.
            queueMicrotask(() =>
              resolve(new Response(JSON.stringify({ error: "bad request" }), { status: 400 })),
            );
          }
        });
      },
    });
    const { rt } = makeRuntime({ client, runner: gated.runner });

    await rt.pollOnce(); // poll #1 delivers run-1 → runner blocked
    expect(gated.calls).toHaveLength(1);

    const inFlightPoll = rt.pollOnce(); // poll #2 blocks on the wire…
    gated.calls[0]!.release(OK_RUNNER); // …run-1's report classifies fatal → runtime aborts
    // The abort rejects poll #2 as transient; the background fatal must still surface.
    await expect(inFlightPoll).rejects.toThrow(FatalDaemonError);
  });

  it("never dispatches a delivery that arrives AFTER a background fatal — an in-flight poll resolving ok past the fatal must not refill the dropped queue (round-2 P2)", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "fatal", reason: "report HTTP 400" });

    await rt.pollOnce(); // claims run-1; runner blocked
    expect(gated.calls).toHaveLength(1);

    // poll #2 stays on the wire until the test releases it — meanwhile run-1's
    // report classifies fatal and the queue is dropped.
    let releasePoll!: (outcome: PollOutcome) => void;
    client.poll = () =>
      new Promise<PollOutcome>((resolve) => {
        releasePoll = resolve;
      });
    const inFlightPoll = rt.pollOnce();

    gated.calls[0]!.release(OK_RUNNER); // report → fatal → setFatal drops the queue
    await rt.executionSettled(); // settles with the queue empty

    // The poll resolves SUCCESSFULLY, one fatal too late.
    releasePoll({ kind: "ok", deliveries: [delivery("run-2")] });
    await expect(inFlightPoll).rejects.toThrow(FatalDaemonError);
    await rt.executionSettled(); // MUST resolve — run-2 must NOT refill the dropped queue
    expect(gated.calls.map((c) => c.delivery.runId)).toEqual(["run-1"]); // run-2 never started
  });

  it("drops the never-started queue on a background fatal so executionSettled() resolves — no permanent hang; the pending report survives as postmortem", async () => {
    const gated = gatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1"), delivery("run-2")] });
    client.reportQueue.push({ kind: "fatal", reason: "report HTTP 400" });

    await rt.pollOnce();
    expect(gated.calls.map((c) => c.delivery.runId)).toEqual(["run-1"]); // run-2 queued

    gated.calls[0]!.release(OK_RUNNER);
    await rt.executionSettled(); // MUST resolve — the fatal drops the never-started queue
    expect(rt.pendingCount()).toBe(1); // postmortem kept, never drained
    expect(gated.calls.map((c) => c.delivery.runId)).toEqual(["run-1"]); // run-2 never started

    await expect(rt.pollOnce()).rejects.toThrow(FatalDaemonError); // and the fatal is visible
  });
});

describe("runner progress events (Phase 2 batch 3 — R group)", () => {
  function ctxGatedRunner() {
    const calls: { delivery: Delivery; ctx: RunnerContext; release: (report: RunnerReport) => void }[] = [];
    const runner: AgentRunner = {
      run: (d: Delivery, ctx: RunnerContext) =>
        new Promise<RunnerReport>((resolve) => {
          calls.push({ delivery: d, ctx, release: resolve });
        }),
    };
    return { runner, calls };
  }

  it("R1: each runner event sanitizes the label (NUL stripped, collapsed to one line, capped at 200 chars) and increments the step", async () => {
    const gated = ctxGatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce(); // dispatch (body built pre-dispatch — no progress yet)
    await rt.pollOnce(); // executing — step 1
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 1, label: "starting claude-code" }]);

    const ctx = gated.calls[0]!.ctx;
    ctx.onProgress("line one\nline two\0 nul");
    await rt.pollOnce();
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 2, label: "line one line two nul" }]);

    ctx.onProgress("x".repeat(500));
    await rt.pollOnce();
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 3, label: "x".repeat(200) }]);

    gated.calls[0]!.release(OK_RUNNER);
    await rt.executionSettled();
  });

  it("R2: starting → runner events → reporting is strictly monotonic; reporting lands at last event step + 1", async () => {
    const gated = ctxGatedRunner();
    const { rt, client, clock } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    await rt.pollOnce();
    const ctx = gated.calls[0]!.ctx;
    ctx.onProgress("event one");
    ctx.onProgress("event two");
    await rt.pollOnce(); // step 3 = 1 (starting) + 2 events
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 3, label: "event two" }]);

    gated.calls[0]!.release(OK_RUNNER); // → reporting at step 4
    await flush();
    await flush();
    await rt.pollOnce();
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 4, label: "reporting result" }]);

    clock.fireNext(); // retry confirms
    await flush();
    await flush();
    await rt.pollOnce();
    expect(client.polls.at(-1)).not.toHaveProperty("progress");
  });

  it("R3: a late onProgress after the runner settled is ignored — neither step nor label changes, before AND after the report confirms", async () => {
    const gated = ctxGatedRunner();
    const { rt, client, clock } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "confirmed" });

    await rt.pollOnce();
    const ctx = gated.calls[0]!.ctx;
    gated.calls[0]!.release(OK_RUNNER); // settle → reporting (step 2, no events)
    await flush();
    await flush();
    await rt.pollOnce();
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 2, label: "reporting result" }]);

    ctx.onProgress("late noise"); // the runner already settled — ignored
    await rt.pollOnce();
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 2, label: "reporting result" }]);

    clock.fireNext(); // confirm → the activity entry is gone entirely
    await flush();
    await flush();
    ctx.onProgress("too late"); // even now: no resurrection
    await rt.pollOnce();
    expect(client.polls.at(-1)).not.toHaveProperty("progress");
  });

  it("R4: labels that sanitize to empty cost no step", async () => {
    const gated = ctxGatedRunner();
    const { rt, client } = makeRuntime({ runner: gated.runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce();
    const ctx = gated.calls[0]!.ctx;
    ctx.onProgress("   \0 \n\t ");
    await rt.pollOnce();
    expect(client.polls.at(-1)!.progress).toEqual([{ runId: "run-1", step: 1, label: "starting claude-code" }]);

    gated.calls[0]!.release(OK_RUNNER);
    await rt.executionSettled();
  });
});
