/**
 * The inactivity sweep (Day 8–10 plan §1, Slice A) — the vanished-machine
 * guard that turns a stale `running` run into an OBSERVABLE error with the
 * ADR-001 T5 single-wake-report window, and prunes dead terminal-grace
 * leases. These tests pin the plan's fixed behaviors:
 *
 *  - candidates are ONLY `running` runs, read with an explicit column
 *    projection and keyset-bounded pages;
 *  - last activity = max(run.ts, progress.at) over VALID stamps only: garbage
 *    is no evidence, near-future skew (≤5min) is tolerated, and far-future
 *    pollution grants NO immortality (fail closed → reclaim);
 *  - the machine heartbeat watermark (classifyHeartbeatWatermark /
 *    heartbeatAgeMs) is DIAGNOSTIC ONLY — a fresh machine never vetoes the
 *    reclaim of its own timed-out run (ADR-001 delivery-loss convergence);
 *  - reclaim delegates to the store's reclaimStaleRunTx (the ONLY
 *    terminal-grace producer); one anomalous candidate never blocks the batch;
 *  - prune: expired / missing / invalid-expiry terminal-grace leases are
 *    deleted (fail closed); unexpired windows and ACTIVE leases are kept;
 *  - overlapping runOnce() calls coalesce into ONE in-flight pass.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines, runs } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { RECLAIM_RUN_ERROR, TERMINAL_GRACE_MS } from "../store/runs.js";
import { FakeClock, seedLease, seedLoop, seedMachine, seedRun, snapshotLeases, snapshotRuns } from "../testkit/index.js";
import {
  armInactivitySweep,
  createInactivitySweep,
  DEFAULT_RUN_INACTIVITY_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  type InactivitySweep,
  type SweepStats,
} from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let logs: string[];
let sweep: InactivitySweep;

const TWENTY_MIN = 20 * 60 * 1000;

async function fresh(sweepOverrides: { runInactivityMs?: number; pageSize?: number } = {}): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  logs = [];
  await seedLoop(db, { id: "loop-1" });
  sweep = createInactivitySweep({ db, clock, log: (line) => logs.push(line), ...sweepOverrides });
}

const nowMs = () => clock.now().getTime();
const iso = (ms: number) => new Date(ms).toISOString();

/** A running run with an active lease — the well-formed sweep candidate. */
async function seedRunningCandidate(id: string, ts: string, progressAt?: string): Promise<void> {
  await seedRun(db, {
    id,
    phase: "running",
    ts,
    progress: progressAt === undefined ? null : { step: 1, label: "working", at: progressAt },
  });
  await seedLease(db, { tokenHash: sha256(`rk_${id}`), runId: id });
}

async function setMachineHeartbeat(id: string, lastSeen: string | null): Promise<void> {
  await seedMachine(db, id);
  await db.update(machines).set({ lastSeen }).where(eq(machines.id, id));
}

describe("production defaults", () => {
  it("pins the 20-minute inactivity timeout and the 30-second sweep interval", () => {
    expect(DEFAULT_RUN_INACTIVITY_MS).toBe(1_200_000);
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(30_000);
  });
});

describe("run inactivity boundary", () => {
  it("keeps a run one millisecond before the timeout and reclaims AT the boundary", async () => {
    await fresh();
    await seedRunningCandidate("run-keep", iso(nowMs() - (TWENTY_MIN - 1)));
    await seedRunningCandidate("run-reap", iso(nowMs() - TWENTY_MIN));

    const stats = await sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 2, reclaimed: 1, failed: 0 } satisfies Partial<SweepStats>);

    const rows = await snapshotRuns(db);
    expect(rows.find((r) => r.id === "run-keep")).toMatchObject({ phase: "running", outcome: null });
    expect(rows.find((r) => r.id === "run-reap")).toMatchObject({
      phase: "error",
      outcome: "error",
      error: RECLAIM_RUN_ERROR,
      ts: clock.iso(),
    });
  });

  it("a newer progress.at postpones the reclaim past the run.ts timeout", async () => {
    await fresh();
    // run.ts is 30min stale, but the runner checked in 5min ago.
    await seedRunningCandidate("run-1", iso(nowMs() - 30 * 60_000), iso(nowMs() - 5 * 60_000));
    const first = await sweep.runOnce();
    expect(first).toMatchObject({ scanned: 1, reclaimed: 0 });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "running" });

    // Once the progress stamp itself ages out, the run reclaims.
    clock.advance(16 * 60_000);
    const second = await sweep.runOnce();
    expect(second).toMatchObject({ scanned: 1, reclaimed: 1 });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "error", outcome: "error" });
  });

  it("a far-future or garbage activity stamp is NO liveness evidence (fail closed)", async () => {
    await fresh();
    await seedRunningCandidate("run-far-future", iso(nowMs() + 24 * 60 * 60_000)); // pollution, not life
    await seedRunningCandidate("run-near-future", iso(nowMs() + 4 * 60_000)); // within 5min skew slack
    await seedRunningCandidate("run-garbage-progress", iso(nowMs() - 30 * 60_000), "not-a-date"); // falls back to stale ts
    await seedRunningCandidate("run-garbage-ts", "not-a-date", iso(nowMs() - 60_000)); // fresh progress saves it

    const stats = await sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 4, reclaimed: 2, failed: 0 });

    const rows = await snapshotRuns(db);
    expect(rows.find((r) => r.id === "run-far-future")?.phase).toBe("error");
    expect(rows.find((r) => r.id === "run-near-future")?.phase).toBe("running");
    expect(rows.find((r) => r.id === "run-garbage-progress")?.phase).toBe("error");
    expect(rows.find((r) => r.id === "run-garbage-ts")?.phase).toBe("running");
  });

  it("a fresh machine heartbeat never vetoes reclaiming the machine's own stale run (delivery-loss convergence)", async () => {
    await fresh();
    await setMachineHeartbeat("m-test", clock.iso()); // machine polling RIGHT NOW
    await seedRunningCandidate("run-1", iso(nowMs() - 25 * 60_000));

    const stats = await sweep.runOnce();
    expect(stats.reclaimed).toBe(1);
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "error", outcome: "error" });
    // …but the freshness IS recorded as diagnostics.
    expect(logs.some((l) => l.includes("run-1") && l.includes("machineHeartbeat=valid"))).toBe(true);
  });

  it("an anomalous-future machine watermark is pollution, not proof of life", async () => {
    await fresh();
    await setMachineHeartbeat("m-test", iso(nowMs() + 24 * 60 * 60_000));
    await seedRunningCandidate("run-1", iso(nowMs() - 25 * 60_000));

    const stats = await sweep.runOnce();
    expect(stats.reclaimed).toBe(1);
    expect(logs.some((l) => l.includes("machineHeartbeat=anomalous-future"))).toBe(true);
  });
});

describe("reclaim semantics through the sweep", () => {
  it("stamps error/error with the generic reason and the FIRST now+24h terminal-grace window", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));
    await sweep.runOnce();

    expect((await snapshotRuns(db))[0]).toMatchObject({
      phase: "error",
      outcome: "error",
      error: RECLAIM_RUN_ERROR,
      ts: clock.iso(),
    });
    expect((await snapshotLeases(db))[0]).toMatchObject({
      state: "terminal-grace",
      expiresAt: iso(nowMs() + TERMINAL_GRACE_MS),
    });
  });

  it("a repeated sweep never extends the first grace window", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));
    await sweep.runOnce();
    const firstWindow = (await snapshotLeases(db))[0]!.expiresAt;

    clock.advance(60 * 60_000);
    const second = await sweep.runOnce();
    expect(second.scanned).toBe(0); // the run already left `running`
    expect((await snapshotLeases(db))[0]!.expiresAt).toBe(firstWindow);
  });

  it("one anomalous candidate (running without an active lease) fails WITHOUT blocking the batch", async () => {
    await fresh();
    // Sorts FIRST by id: if it blocked, the healthy candidate would never run.
    await seedRun(db, { id: "run-a-bad", phase: "running", ts: iso(nowMs() - TWENTY_MIN) });
    await seedRunningCandidate("run-b-good", iso(nowMs() - TWENTY_MIN));

    const stats = await sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 2, reclaimed: 1, failed: 1 });

    const rows = await snapshotRuns(db);
    // Zero writes on the invariant-violating row (the guard rolled back).
    expect(rows.find((r) => r.id === "run-a-bad")).toMatchObject({ phase: "running", outcome: null });
    expect(rows.find((r) => r.id === "run-b-good")).toMatchObject({ phase: "error", outcome: "error" });
    expect(logs.some((l) => l.includes("run-a-bad") && l.includes("FAILED"))).toBe(true);
  });

  it("a THROWING diagnostic read never aborts the pass — the reclaim proceeds with the hole marked unavailable (review: candidate-level isolation)", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));
    const broken = createInactivitySweep({
      db,
      clock,
      log: (line) => logs.push(line),
      readMachineForDiagnostic: () => Promise.reject(new Error("password=rk_should_not_log\ninjected")),
    });

    const stats = await broken.runOnce();
    // The diagnostic failure is NOT the candidate's reclaim failure: the
    // reclaim ran, `failed` stayed 0, and the pass completed normally.
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 1, failed: 0 });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "error", outcome: "error" });
    expect(logs.some((l) => l.includes("run-1") && l.includes("machineHeartbeat=unavailable"))).toBe(true);
    expect(logs.join("\n")).not.toContain("rk_should_not_log");
  });

  it("a progress heartbeat landing BETWEEN scan and reclaim turns the reclaim into a benign skip (review: scan/reclaim TOCTOU)", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));
    const interposed = createInactivitySweep({
      db,
      clock,
      log: (line) => logs.push(line),
      // The diagnostic read fires after the scan's stale decision and before
      // the reclaim transaction — the deterministic seam for the window a
      // Phase 2 progress write would race through.
      readMachineForDiagnostic: async () => {
        await db
          .update(runs)
          .set({ progress: { step: 2, label: "working", at: clock.iso() } })
          .where(eq(runs.id, "run-1"));
        return undefined;
      },
    });

    const stats = await interposed.runOnce();
    // Benign skip: NOT reclaimed, NOT failed — the just-proven-live run is
    // left running with its active lease intact.
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 0, failed: 0 });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "running", outcome: null });
    expect((await snapshotLeases(db))[0]).toMatchObject({ state: "active", expiresAt: null });
  });

  it("never scans non-running phases (pending waits for T7 supersede, terminals are settled)", async () => {
    await fresh();
    await seedRun(db, { id: "run-pending", phase: "pending" });
    await seedRun(db, { id: "run-done", phase: "done", outcome: "exec" });
    await seedRun(db, { id: "run-error", phase: "error", outcome: "error", error: "real failure" });
    await seedRun(db, { id: "run-canceled", phase: "canceled" });
    const before = await snapshotRuns(db);

    const stats = await sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 0, reclaimed: 0, failed: 0 });
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it("reads candidates in page-bounded keyset batches (pageSize smaller than the batch)", async () => {
    await fresh({ pageSize: 2 });
    for (const id of ["run-1", "run-2", "run-3"]) {
      await seedRunningCandidate(id, iso(nowMs() - TWENTY_MIN));
    }
    const stats = await sweep.runOnce();
    expect(stats).toMatchObject({ scanned: 3, reclaimed: 3, failed: 0 });
  });

  it("coalesces overlapping runOnce() calls into ONE in-flight pass", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));

    const p1 = sweep.runOnce();
    const p2 = sweep.runOnce();
    expect(p2).toBe(p1); // the same promise — no second scan stacked on top

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(s1.reclaimed).toBe(1); // reclaimed ONCE, not once per caller
  });
});

describe("terminal-grace lease prune", () => {
  it("deletes expired / missing / invalid expiries (fail closed); keeps live windows and NEVER time-prunes an active lease", async () => {
    await fresh();
    const tg = (runId: string, expiresAt: string | null) =>
      seedLease(db, { tokenHash: sha256(`rk_${runId}`), runId, state: "terminal-grace", expiresAt });

    await tg("run-expired", iso(nowMs() - 1)); // past window
    await tg("run-boundary", iso(nowMs())); // dies AT its expiresAt
    await tg("run-missing", null); // fail closed
    await tg("run-garbage", "not-a-date"); // fail closed
    await tg("run-live", iso(nowMs() + 60 * 60_000)); // still inside the window
    await seedLease(db, { tokenHash: sha256("rk_active"), runId: "run-active", state: "active", expiresAt: null });

    const stats = await sweep.runOnce();
    expect(stats.pruned).toBe(4);

    const remaining = (await snapshotLeases(db)).map((l) => l.runId).sort();
    expect(remaining).toEqual(["run-active", "run-live"]);
  });
});

describe("armInactivitySweep timer wiring", () => {
  it("runs one pass immediately, swallows a failing pass into the log, keeps ticking, and stopAndDrain() ends it", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const errors: string[] = [];
      const stub: InactivitySweep = {
        runOnce: vi.fn(async () => {
          calls += 1;
          if (calls === 2) throw new Error("boom");
          return { scanned: 0, reclaimed: 0, pruned: 0, failed: 0 };
        }),
      };
      const timer = armInactivitySweep(stub, 1000, (line) => errors.push(line));
      expect(calls).toBe(1); // the immediate pass starts synchronously

      await vi.advanceTimersByTimeAsync(1000); // tick 2 rejects — caught, logged
      expect(calls).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("classification=sweep_pass_failed");
      expect(errors[0]).not.toContain("boom");

      await vi.advanceTimersByTimeAsync(1000); // a failed pass never kills later ticks
      expect(calls).toBe(3);

      await timer.stopAndDrain();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopAndDrain blocks new ticks and waits for the IN-FLIGHT pass before resolving (review: shutdown drain)", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      let calls = 0;
      const stub: InactivitySweep = {
        runOnce: vi.fn(
          () =>
            new Promise<SweepStats>((resolve) => {
              calls += 1;
              release = () => resolve({ scanned: 0, reclaimed: 0, pruned: 0, failed: 0 });
            }),
        ),
      };
      const timer = armInactivitySweep(stub, 1000, () => {});
      expect(calls).toBe(1); // the immediate pass is IN FLIGHT

      let drained = false;
      const draining = timer.stopAndDrain().then(() => {
        drained = true;
      });
      // The drain must NOT resolve while the pass hangs — closeDb comes later.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(drained).toBe(false);

      release(); // the in-flight pass settles → the drain resolves
      await draining;
      expect(drained).toBe(true);

      await vi.advanceTimersByTimeAsync(5000); // and no tick ever fires again
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains an error logger failure so shutdown can still drain and close", async () => {
    vi.useFakeTimers();
    try {
      const stub: InactivitySweep = {
        runOnce: vi.fn(async () => {
          throw new Error("runner failed");
        }),
      };
      const timer = armInactivitySweep(stub, 1000, () => {
        throw new Error("logger failed");
      });

      await vi.advanceTimersByTimeAsync(0);
      await expect(timer.stopAndDrain()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Issue #10: reclaim error classification (Batch 4)", () => {
  it("classifies ReclaimGuardLostError as reclaim_guard_lost", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));

    // Inject a throwing reclaim that simulates the guard loss
    const { ReclaimGuardLostError } = await import("../store/runs.js");
    const brokenSweep = createInactivitySweep({
      db,
      clock,
      log: (line) => logs.push(line),
    });

    // Patch reclaimStaleRunTx to throw ReclaimGuardLostError
    const originalReclaim = (await import("../store/runs.js")).reclaimStaleRunTx;
    const { reclaimStaleRunTx } = await import("../store/runs.js");
    vi.spyOn(await import("../store/runs.js"), "reclaimStaleRunTx").mockRejectedValueOnce(
      new ReclaimGuardLostError("run-1")
    );

    const stats = await brokenSweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 0, failed: 1 });
    expect(logs.some((l) => l.includes("run-1") && l.includes("classification=reclaim_guard_lost"))).toBe(true);
  });

  it("classifies other errors as reclaim_failed and never logs error message", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));

    const brokenSweep = createInactivitySweep({
      db,
      clock,
      log: (line) => logs.push(line),
    });

    // Inject an error with credential-like content
    vi.spyOn(await import("../store/runs.js"), "reclaimStaleRunTx").mockRejectedValueOnce(
      new Error("password=rk_secret123\nconnection failed")
    );

    const stats = await brokenSweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 0, failed: 1 });
    expect(logs.some((l) => l.includes("run-1") && l.includes("classification=reclaim_failed"))).toBe(true);
    // Must not log the error message content
    expect(logs.join("\n")).not.toContain("rk_secret123");
    expect(logs.join("\n")).not.toContain("connection failed");
  });

  it("classifies non-Error throws as reclaim_failed", async () => {
    await fresh();
    await seedRunningCandidate("run-1", iso(nowMs() - TWENTY_MIN));

    const brokenSweep = createInactivitySweep({
      db,
      clock,
      log: (line) => logs.push(line),
    });

    // Inject a non-Error throw (string, object, etc.)
    vi.spyOn(await import("../store/runs.js"), "reclaimStaleRunTx").mockRejectedValueOnce(
      "some string error with credential=rk_token"
    );

    const stats = await brokenSweep.runOnce();
    expect(stats).toMatchObject({ scanned: 1, reclaimed: 0, failed: 1 });
    expect(logs.some((l) => l.includes("run-1") && l.includes("classification=reclaim_failed"))).toBe(true);
    expect(logs.join("\n")).not.toContain("rk_token");
  });
});
