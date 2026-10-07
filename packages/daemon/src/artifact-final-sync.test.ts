/**
 * Slice 6 run-final artifact sync (Batch 2 plan §3 AR1/AR2/AR4/AR5 daemon
 * half + the U1/U2 编号外 evidence) — driven through the in-memory fake
 * server (testkit/artifact-sync-fake.ts) with a REAL ArtifactSyncClient and
 * real temp dirs, plus a stub sync for the outcome-mapping matrix. Time is
 * injected (manual sleep queues); no fake timers.
 *
 * Every test states the mutation that would make it red in its name or its
 * assertion comment.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Delivery } from "@loopzhb/protocol";

import { createArtifactTransport } from "./artifact-client.js";
import {
  createFinalArtifactSync,
  FINAL_SYNC_DEADLINE_MS,
  FINAL_SYNC_TIMEOUT_REPORT_BUDGET_MS,
  type FinalArtifactSync,
} from "./artifact-final-sync.js";
import { createArtifactHashCache } from "./artifact-hash-cache.js";
import {
  createArtifactSyncClient,
  type ArtifactLocalFailureInput,
  type ArtifactSyncClient,
  type ArtifactSyncInput,
  type ArtifactSyncOutcome,
} from "./artifact-sync.js";
import { createFakeArtifactServer, type FakeArtifactServer } from "./testkit/artifact-sync-fake.js";

const CREDENTIAL = "dk_slice6_fixture_credential";
const LOOP_ID = "loop-1";
const DEADLINE_MS = 30; // test-scale deadline (the production constant is pinned below)
const REPORT_BUDGET_MS = 10;

let base: string;
let server: FakeArtifactServer;
let client: ArtifactSyncClient;
let clientDelays: number[];
let logs: string[];

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-final-sync-test-"));
  clientDelays = [];
  logs = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** An injectable manual sleep queue (the artifact-watch-manager.test.ts
 *  precedent): every sleep registers; the test fires by duration. */
function manualSleep(): {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pendingMs: () => number[];
  fire: (ms: number) => number;
} {
  const pending: { ms: number; done: boolean; finish: () => void }[] = [];
  return {
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const entry = { ms, done: false, finish: () => {} };
        const cleanup = (): void => {
          if (entry.done) return;
          entry.done = true;
          signal.removeEventListener("abort", cleanup);
          resolve();
        };
        entry.finish = cleanup;
        if (signal.aborted) {
          cleanup();
          return;
        }
        pending.push(entry);
        signal.addEventListener("abort", cleanup, { once: true });
      }),
    pendingMs: () => pending.filter((e) => !e.done).map((e) => e.ms),
    fire: (ms) => {
      const hits = pending.filter((e) => !e.done && e.ms === ms);
      for (const e of hits) e.finish();
      return hits.length;
    },
  };
}

/** Poll until a condition holds, with a deadline so a regression FAILS
 *  instead of wedging the suite. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startAt > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function write(relativePath: string, content: string): void {
  const absolute = path.join(base, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function delivery(artifact: { dir: string; configRevision: number } | null = { dir: base, configRevision: 1 }): Delivery {
  return {
    runId: "run-1",
    runToken: "rk_test",
    role: "exec",
    loop: {
      id: LOOP_ID,
      name: "loop",
      workdir: null,
      taskFile: null,
      workflow: null,
      model: null,
      allowControl: false,
      ...(artifact === null ? {} : { artifact }),
    },
    prevState: null,
    roots: [],
    systemPrompt: "",
    task: "do it",
  };
}

function realClient(): ArtifactSyncClient {
  server = createFakeArtifactServer({
    machineCredential: CREDENTIAL,
    loops: [{ loopId: LOOP_ID, artifactDir: base }],
  });
  return createArtifactSyncClient({
    transport: createArtifactTransport({
      baseUrl: "http://fake.invalid",
      machineCredential: CREDENTIAL,
      fetchImpl: server.fetchImpl,
    }),
    cache: createArtifactHashCache(),
    sleep: async (ms) => {
      clientDelays.push(ms);
    },
  });
}

function finalSyncWith(sync: ArtifactSyncClient, time: ReturnType<typeof manualSleep>, overrides: { deadlineMs?: number; timeoutReportMs?: number } = {}): FinalArtifactSync {
  return createFinalArtifactSync({
    sync,
    daemonRoots: [base],
    sleep: time.sleep,
    deadlineMs: overrides.deadlineMs ?? DEADLINE_MS,
    timeoutReportMs: overrides.timeoutReportMs ?? REPORT_BUDGET_MS,
    log: (line) => logs.push(line),
  });
}

/** A sync stub capturing every call; the outcome is scripted. */
function stubSync(script: {
  syncLoop: (input: ArtifactSyncInput) => Promise<ArtifactSyncOutcome>;
  reportLocalFailure?: (input: ArtifactLocalFailureInput) => Promise<ArtifactSyncOutcome>;
}): { sync: ArtifactSyncClient; syncInputs: ArtifactSyncInput[]; reportInputs: ArtifactLocalFailureInput[] } {
  const syncInputs: ArtifactSyncInput[] = [];
  const reportInputs: ArtifactLocalFailureInput[] = [];
  const sync: ArtifactSyncClient = {
    syncLoop: (input) => {
      syncInputs.push(input);
      return script.syncLoop(input);
    },
    readBaseline: () => Promise.resolve({ kind: "cancelled" }),
    reportLocalFailure: (input) => {
      reportInputs.push(input);
      return script.reportLocalFailure?.(input) ?? Promise.resolve({ kind: "cancelled" });
    },
    clearStops: () => {},
    settled: () => Promise.resolve(),
  };
  return { sync, syncInputs, reportInputs };
}

describe("constants", () => {
  it("the production budgets are the frozen 30 s deadline + 10 s report budget", () => {
    expect(FINAL_SYNC_DEADLINE_MS).toBe(30_000);
    expect(FINAL_SYNC_TIMEOUT_REPORT_BUDGET_MS).toBe(10_000);
  });
});

describe("fast paths (no sync attempt at all)", () => {
  it("a loop WITHOUT artifact config returns {} and never touches the sync client", async () => {
    const { sync, syncInputs } = stubSync({ syncLoop: () => Promise.resolve({ kind: "unchanged" }) });
    const time = manualSleep();
    const finalSync = finalSyncWith(sync, time);
    const ctl = new AbortController();
    await expect(finalSync.run(delivery(null), ctl.signal)).resolves.toEqual({});
    expect(syncInputs).toEqual([]);
    expect(time.pendingMs()).toEqual([]);
  });

  it("an already-aborted caller signal returns {} fast — a stopping daemon never pays the deadline", async () => {
    const { sync, syncInputs } = stubSync({ syncLoop: () => Promise.resolve({ kind: "unchanged" }) });
    const time = manualSleep();
    const finalSync = finalSyncWith(sync, time);
    const ctl = new AbortController();
    ctl.abort();
    await expect(finalSync.run(delivery(), ctl.signal)).resolves.toEqual({});
    expect(syncInputs).toEqual([]);
  });
});

describe("the sync attempt", () => {
  it("assembles the target from the DELIVERY (决策 20) and forces a fresh session with a full rehash", async () => {
    const { sync, syncInputs } = stubSync({
      syncLoop: () => Promise.resolve({ kind: "synced", manifestRevision: 3, artifactSnapshotId: "snap-1", uploaded: 0 }),
    });
    const time = manualSleep();
    const finalSync = finalSyncWith(sync, time);
    const ctl = new AbortController();
    const configured = delivery({ dir: base, configRevision: 7 });
    const d: Delivery = { ...configured, roots: ["/server-root"], loop: { ...configured.loop, workdir: "/work" } };
    await expect(finalSync.run(d, ctl.signal)).resolves.toEqual({ artifactSnapshotId: "snap-1" });
    expect(syncInputs).toHaveLength(1);
    const input = syncInputs[0]!;
    expect(input.target).toEqual({
      loopId: LOOP_ID,
      artifactDir: base,
      workdir: "/work",
      roots: ["/server-root"],
      configRevision: 7,
    });
    expect(input.daemonRoots).toEqual([base]);
    // Mutations that turn red: freshSession false/absent (content-equal runs
    // mint no snapshot); reuseCachedHashes true (the final sync must rehash).
    expect(input.freshSession).toBe(true);
    expect(input.reuseCachedHashes).toBe(false);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("a real final sync commits and the report carries the minted snapshot id (AR1)", async () => {
    client = realClient();
    write("dist/app.js", "v1");
    const time = manualSleep();
    const finalSync = finalSyncWith(client, time);
    const ctl = new AbortController();

    // The fake mints ids from ONE shared sequence (sync-1, snap-2, sync-3,
    // snap-4, …), so each run's snapshot id is the even number after its
    // session id.
    await expect(finalSync.run(delivery(), ctl.signal)).resolves.toEqual({ artifactSnapshotId: "snap-2" });
    // freshSession bypassed suppression: a second, content-EQUAL run mints a
    // SECOND session and snapshot (决策 11).
    await expect(finalSync.run(delivery(), ctl.signal)).resolves.toEqual({ artifactSnapshotId: "snap-4" });
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(new Set(prepares.map((c) => c.requestId)).size).toBe(2);
    expect(server.sessions.size).toBe(2);
    // No backoff, no deadline sleep left behind.
    expect(clientDelays).toEqual([]);
    expect(time.pendingMs()).toEqual([]);
  });
});

describe("the U2 outcome mapping (every non-synced arm carries a stable literal)", () => {
  it("failed maps to the scan taxonomy value itself", async () => {
    const { sync, reportInputs } = stubSync({
      syncLoop: () => Promise.resolve({ kind: "failed", failure: "unreadable", detail: "EACCES", reported: "recorded" }),
    });
    const time = manualSleep();
    await expect(finalSyncWith(sync, time).run(delivery(), new AbortController().signal)).resolves.toEqual({
      artifactSyncError: "unreadable",
    });
    // A settle inside the budget is the OUTCOME's call: the deadline watcher
    // was disarmed (not fired) and nothing was reported to the loop endpoint.
    expect(time.pendingMs()).toEqual([]);
    expect(reportInputs).toEqual([]);
  });

  it("terminal maps to the wire code (or the bare literal without one)", async () => {
    const withCode = stubSync({
      syncLoop: () => Promise.resolve({ kind: "terminal", code: "artifact_content_mismatch", detail: "x" }),
    });
    await expect(
      finalSyncWith(withCode.sync, manualSleep()).run(delivery(), new AbortController().signal),
    ).resolves.toEqual({ artifactSyncError: "artifact_content_mismatch" });
    const bare = stubSync({ syncLoop: () => Promise.resolve({ kind: "terminal", detail: "x" }) });
    await expect(finalSyncWith(bare.sync, manualSleep()).run(delivery(), new AbortController().signal)).resolves.toEqual({
      artifactSyncError: "terminal",
    });
  });

  it("unavailable / config_changed / stopped map to their fixed literals", async () => {
    const outcomes: ArtifactSyncOutcome[] = [
      { kind: "unavailable", detail: "offline" },
      { kind: "config_changed", detail: "moved" },
      { kind: "stopped", scope: "machine", status: 401, detail: "unauthorized" },
    ];
    for (const [outcome, literal] of [
      [outcomes[0]!, "unavailable"],
      [outcomes[1]!, "config_changed"],
      [outcomes[2]!, "stopped"],
    ] as const) {
      const { sync, reportInputs } = stubSync({ syncLoop: () => Promise.resolve(outcome) });
      await expect(finalSyncWith(sync, manualSleep()).run(delivery(), new AbortController().signal)).resolves.toEqual({
        artifactSyncError: literal,
      });
      // Only the timeout path reports to the loop endpoint (U1).
      expect(reportInputs).toEqual([]);
    }
  });

  it("an unchanged outcome under freshSession is impossible — defensive: no fields, a log line, never a fabricated snapshot", async () => {
    const { sync } = stubSync({ syncLoop: () => Promise.resolve({ kind: "unchanged" }) });
    await expect(finalSyncWith(sync, manualSleep()).run(delivery(), new AbortController().signal)).resolves.toEqual({});
    expect(logs.some((l) => l.includes("unchanged"))).toBe(true);
  });

  it("an internal throw is frozen as internal_error (never propagates, never blocks the report)", async () => {
    const { sync } = stubSync({
      syncLoop: () => Promise.reject(new Error("boom: the gate bookkeeping broke")),
    });
    const time = manualSleep();
    await expect(finalSyncWith(sync, time).run(delivery(), new AbortController().signal)).resolves.toEqual({
      artifactSyncError: "internal_error",
    });
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
    // The throw path disarms the deadline watcher too — no timer outlives the
    // call (#106/P3).
    expect(time.pendingMs()).toEqual([]);
  });

  it("a sync that fails LATE (past the deadline) still freezes timeout and gets the bounded report (#106)", async () => {
    // The reviewer's counterexample: the scan's lstat hangs past the deadline
    // and only THEN rejects EACCES, so the client settles as
    // failed{unreadable}. The expiry is recorded by the deadline watcher, not
    // inferred from the outcome — the report must carry "timeout", and the U1
    // report must go out on its OWN budget (the client's own local-failure
    // report could only try an already-aborted signal).
    let enteredStat!: () => void;
    const statEntered = new Promise<void>((resolve) => {
      enteredStat = resolve;
    });
    let rejectStat!: (error: Error) => void;
    const reports: { failure: string; signalAborted: boolean }[] = [];
    const sync: ArtifactSyncClient = createArtifactSyncClient({
      cache: createArtifactHashCache(),
      transport: {
        readLoop: async () => ({
          kind: "ok",
          value: { loopId: LOOP_ID, configRevision: 1, manifestRevision: 0, artifactDir: base },
        }),
        reportSyncError: async (_loopId, body, signal) => {
          reports.push({ failure: body.failure, signalAborted: signal?.aborted === true });
          return signal?.aborted === true
            ? { kind: "unreachable", reason: "request aborted" }
            : { kind: "ok", value: { ok: true, recorded: true } };
        },
        prepare: async () => ({ kind: "unreachable", reason: "unexpected prepare" }),
        putBlob: async () => ({ kind: "unreachable", reason: "unexpected put" }),
        commit: async () => ({ kind: "unreachable", reason: "unexpected commit" }),
      },
      io: {
        lstat: () => {
          enteredStat();
          return new Promise<never>((_resolve, reject) => {
            rejectStat = reject;
          });
        },
      },
      sleep: async () => {},
    });
    write("dist/app.js", "v1");
    const time = manualSleep();
    const pending = finalSyncWith(sync, time).run(delivery(), new AbortController().signal);

    await statEntered; // the scan is parked inside its lstat
    expect(time.pendingMs()).toEqual([DEADLINE_MS]);
    time.fire(DEADLINE_MS); // the deadline expires FIRST
    rejectStat(Object.assign(new Error("controlled EACCES after the deadline"), { code: "EACCES" }));

    await expect(pending).resolves.toEqual({ artifactSyncError: "timeout" });
    expect(reports).toEqual([
      { failure: "unreadable", signalAborted: true }, // the client's own late, aborted attempt
      { failure: "timeout", signalAborted: false }, // …then the independent-budget U1 report
    ]);
    expect(time.pendingMs()).toEqual([]); // no watcher left armed
  });
});

describe("the 30 s deadline (AR4)", () => {
  it("expiry cancels an in-flight sync, freezes timeout, and the loop gets ONE bounded timeout report (U1)", async () => {
    client = realClient();
    write("dist/app.js", "v1");
    const release = server.holdPuts();
    const time = manualSleep();
    const finalSync = finalSyncWith(client, time);
    const ctl = new AbortController();

    const pending = finalSync.run(delivery(), ctl.signal);
    await until(() => server.stepCalls("put").length >= 1);
    // The deadline sleep is parked; the sync is still in flight.
    expect(time.pendingMs()).toEqual([DEADLINE_MS]);

    time.fire(DEADLINE_MS); // the deadline expires — the abort reaches the client
    release(); // the fake lets the aborted PUT settle
    await expect(pending).resolves.toEqual({ artifactSyncError: "timeout" });

    // U1: the loop-level timeout report went out (baseline read + one report).
    const reports = server.stepCalls("report");
    expect(reports).toHaveLength(1);
    // …and no commit ever happened (the manifest was not minted).
    expect(server.stepCalls("commit")).toEqual([]);
    expect(time.pendingMs()).toEqual([]); // both watches cleaned up
  });

  it("the deadline covers the QUEUE WAIT — a final sync parked behind another caller is cancelled before its first request", async () => {
    client = realClient();
    write("a.txt", "a");
    const release = server.holdPuts();
    const time = manualSleep();
    const finalSync = finalSyncWith(client, time);
    const ctl = new AbortController();

    // Occupy the loop's serial queue with a held sync of the SAME loop.
    const occupant = client.syncLoop({
      target: { loopId: LOOP_ID, artifactDir: base, workdir: null, roots: [], configRevision: 1 },
      daemonRoots: [base],
    });
    await until(() => server.stepCalls("put").length >= 1);
    const preparesBefore = server.stepCalls("prepare").length;

    const pending = finalSync.run(delivery(), ctl.signal);
    await until(() => time.pendingMs().includes(DEADLINE_MS));
    time.fire(DEADLINE_MS); // the queued wait is signal-cancellable (#93)
    release(); // let the occupant finish so the cancelled call + the timeout report can drain the serial queue
    await expect(pending).resolves.toEqual({ artifactSyncError: "timeout" });
    await occupant;

    // The cancelled queued call never sent its own prepare; the occupant's
    // commit landed normally; the timeout report followed on the queue.
    expect(server.stepCalls("prepare")).toHaveLength(preparesBefore);
    expect(server.stepCalls("report")).toHaveLength(1);
  });

  it("a commit that genuinely raced the deadline still binds — a settled synced outcome is a legal snapshot", async () => {
    const { sync, reportInputs } = stubSync({
      syncLoop: (input) =>
        new Promise<ArtifactSyncOutcome>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => resolve({ kind: "synced", manifestRevision: 4, artifactSnapshotId: "snap-race", uploaded: 1 }),
            { once: true },
          );
        }),
    });
    const time = manualSleep();
    const finalSync = finalSyncWith(sync, time);
    const pending = finalSync.run(delivery(), new AbortController().signal);
    await until(() => time.pendingMs().includes(DEADLINE_MS));
    time.fire(DEADLINE_MS);
    await expect(pending).resolves.toEqual({ artifactSnapshotId: "snap-race" });
    // A synced outcome never triggers the timeout report.
    expect(reportInputs).toEqual([]);
  });

  it("the timeout REPORT has its own budget — an over-budget report is abandoned and the frozen fields stand", async () => {
    const { sync, reportInputs } = stubSync({
      syncLoop: (input) =>
        new Promise<ArtifactSyncOutcome>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
        }),
      // The report hangs until its OWN signal aborts (the production
      // reportLocalFailure honours it at the queue wait and the fetch).
      reportLocalFailure: (input) =>
        new Promise<ArtifactSyncOutcome>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
        }),
    });
    const time = manualSleep();
    const finalSync = finalSyncWith(sync, time);
    const pending = finalSync.run(delivery(), new AbortController().signal);
    await until(() => time.pendingMs().includes(DEADLINE_MS));
    time.fire(DEADLINE_MS);
    await until(() => reportInputs.length === 1 && time.pendingMs().includes(REPORT_BUDGET_MS));
    expect(reportInputs[0]).toMatchObject({ failure: "timeout" });
    // The deadline sleep is gone; only the report budget remains.
    expect(time.pendingMs()).toEqual([REPORT_BUDGET_MS]);

    time.fire(REPORT_BUDGET_MS); // the report blows its budget → aborted
    await expect(pending).resolves.toEqual({ artifactSyncError: "timeout" });
    expect(time.pendingMs()).toEqual([]);
  });
});

describe("shutdown semantics", () => {
  it("a caller abort mid-sync freezes NO fields (the report stays unsent)", async () => {
    const { sync, reportInputs } = stubSync({
      syncLoop: (input) =>
        new Promise<ArtifactSyncOutcome>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
        }),
    });
    const time = manualSleep();
    const finalSync = finalSyncWith(sync, time);
    const ctl = new AbortController();
    const pending = finalSync.run(delivery(), ctl.signal);
    await until(() => time.pendingMs().includes(DEADLINE_MS));
    ctl.abort(); // daemon shutdown — NOT the deadline
    await expect(pending).resolves.toEqual({});
    // No timeout report: the loop endpoint is not informed from a shutting-down daemon.
    expect(reportInputs).toEqual([]);
  });
});
