/**
 * Runtime pins (goal doc test list 2/3/4 + review rulings): runId ownership,
 * dedupe across inFlight/pendingReports, same-credential same-body retries
 * with 1s→30s backoff that never block poll, the lost-response → coded-401
 * self-heal, Runner-throw synthesis (sanitized, no outcome), fatal
 * propagation, and shutdown semantics.
 *
 * Time is a manual sleep queue; the client is a stub — transport-level
 * classification lives in client.test.ts.
 */
import { describe, expect, it } from "vitest";

import type { Delivery, PollRequest, ReportRequest } from "@loopzhb/protocol";

import type { MachineClient, PollOutcome, ReportOutcome } from "./client.js";
import type { AgentRunner, RunnerReport } from "./runner.js";
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
  reports: { credential: string; body: ReportRequest }[] = [];
  poll(body: PollRequest): Promise<PollOutcome> {
    this.polls.push(body);
    return Promise.resolve(this.pollQueue.shift() ?? { kind: "ok", deliveries: [] });
  }
  report(credential: string, body: ReportRequest): Promise<ReportOutcome> {
    this.reports.push({ credential, body });
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

function captureRunner(impl?: (delivery: Delivery, signal: AbortSignal) => Promise<RunnerReport>) {
  const calls: { delivery: Delivery; signal: AbortSignal }[] = [];
  const runner: AgentRunner = {
    run(delivery, signal) {
      calls.push({ delivery, signal });
      return impl ? impl(delivery, signal) : Promise.resolve(OK_RUNNER);
    },
  };
  return { runner, calls };
}

function makeRuntime(overrides: Partial<Parameters<typeof createDaemonRuntime>[0]> = {}) {
  const client = new StubClient();
  const clock = manualSleep();
  const logs: string[] = [];
  const { runner, calls: runnerCalls } = captureRunner(overrides.runner ? undefined : undefined);
  const rt = createDaemonRuntime({
    client,
    runner: overrides.runner ?? runner,
    identity: IDENTITY,
    pollMs: 3000,
    machineCredential: MACHINE_CRED,
    sleep: clock.sleep,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { rt, client, clock, logs, runnerCalls };
}

describe("happy path", () => {
  it("poll → runner → report confirmed; both sets drain; logs never carry credentials", async () => {
    const { rt, client, logs, runnerCalls } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce();

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.delivery.runId).toBe("run-1");
    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]).toEqual({ credential: "rk_tok_run-1", body: { ...OK_RUNNER, runId: "run-1" } });
    expect(rt.inFlightCount()).toBe(0);
    expect(rt.pendingCount()).toBe(0);
    expect(logs.join("\n")).not.toContain("rk_tok_run-1");
    expect(logs.join("\n")).not.toContain(MACHINE_CRED);
  });

  it("writes delivery.runId unconditionally, even over a Runner type-lie; the body is frozen", async () => {
    const { runner } = captureRunner(() =>
      Promise.resolve({ ...OK_RUNNER, runId: "evil" } as RunnerReport),
    );
    const { rt, client } = makeRuntime({ runner });
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    await rt.pollOnce();

    expect(client.reports[0]!.body.runId).toBe("run-1");
    expect(Object.isFrozen(client.reports[0]!.body)).toBe(true);
  });
});

describe("dedupe", () => {
  it("a redelivered runId in inFlight or pendingReports never re-executes the Runner", async () => {
    const { rt, client, runnerCalls } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" });
    await rt.pollOnce();
    expect(rt.pendingCount()).toBe(1);

    // Server redelivers the SAME runId while its report is still unconfirmed.
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    await rt.pollOnce();

    expect(runnerCalls).toHaveLength(1);
    expect(client.reports).toHaveLength(1);
  });
});

describe("report retry", () => {
  it("retries with the same credential/body on 1s→2s→4s backoff, without blocking poll", async () => {
    const { rt, client, clock } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });
    client.reportQueue.push({ kind: "retry", reason: "HTTP 503" }, { kind: "retry", reason: "HTTP 503" });

    await rt.pollOnce();
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
    expect(rt.pendingCount()).toBe(1);
    clock.fireNext();
    await flush();
    await flush();

    expect(rt.pendingCount()).toBe(0);
    expect(client.reports).toHaveLength(2);
  });
});

describe("Runner failure synthesis", () => {
  it("Runner-thrown errors become { ok:false, error } — sanitized, capped, credential-free, NO outcome", async () => {
    const d = delivery("run-1");
    const { runner } = captureRunner(() =>
      Promise.reject(new Error(`boom\0 with ${d.runToken} and ${MACHINE_CRED}`)),
    );
    const { rt, client } = makeRuntime({ runner });
    client.pollQueue.push({ kind: "ok", deliveries: [d] });

    await rt.pollOnce();

    const body = client.reports[0]!.body;
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
  it("passes the daemon signal to the Runner; SIGINT resolves run() cleanly", async () => {
    const { rt, client, runnerCalls } = makeRuntime();
    client.pollQueue.push({ kind: "ok", deliveries: [delivery("run-1")] });

    const ctl = new AbortController();
    const done = rt.run(ctl.signal);
    await flush(); // first pollOnce + confirmed report; loop now sleeping pollMs
    expect(runnerCalls).toHaveLength(1);

    ctl.abort();
    await expect(done).resolves.toBeUndefined();
    expect(runnerCalls[0]!.signal.aborted).toBe(true); // the Runner seam carries the shutdown
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
