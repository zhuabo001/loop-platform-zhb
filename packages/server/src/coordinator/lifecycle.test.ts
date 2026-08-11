/**
 * Lifecycle primitives: owner cancel + sweep reclaim (plan §1) and the
 * transaction guards around them.
 *
 *  - cancelRun: run → canceled + lease DELETE in ONE transaction (a deliberate
 *    reference deviation — no "canceled but lease still live" window). No
 *    HTTP route in Phase 1; the future owner adapter calls the store
 *    primitive directly (A-02 keeps it off the coordinator interface).
 *  - reclaimStaleRun: SWEEP-ONLY. running → error/error with the generic
 *    reclaim reason + lease → terminal-grace (first window = now+24h), one
 *    transaction. The lease terminalize step is store-PRIVATE — there is no
 *    general-purpose terminalizeLease on any public surface, so report,
 *    cancel, normal failure and admin paths can never manufacture reconcile
 *    eligibility.
 *  - report/cancel interleaving: orchestrated at the APP level (pglite is
 *    single-connection) — the report parks after its read-side resolve, the
 *    cancel commits for real, then the report's in-transaction re-resolve
 *    must catch it (unified 401, zero terminal writes).
 */
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { runLeases, type NewRun } from "../db/schema.js";
import { cancelRunTx, RECLAIM_RUN_ERROR, reclaimStaleRunTx } from "../store/runs.js";
import { isActiveLeaseAnomalous, isLeaseDead } from "../store/leases.js";
import * as leasesStore from "../store/leases.js";
import * as reportStore from "../store/report.js";
import * as runsStore from "../store/runs.js";
import {
  FakeClock,
  seedLease,
  seedLoop,
  seedMachineForToken,
  seedRun,
  snapshotLeases,
  snapshotLoops,
  snapshotRuns,
  testDeps,
} from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "./index.js";

const TOKEN = "dk_test_machine_alpha";
const SEED_CRED = "rk_seed_token";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let machineId: string;
let coordinator: RunCoordinator;

async function fresh(depsOverrides: Parameters<typeof testDeps>[2] = {}): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  machineId = await seedMachineForToken(db, TOKEN);
  await seedLoop(db, { id: "loop-1" });
  coordinator = createRunCoordinator(testDeps(db, clock, depsOverrides));
}

/** Store-level lifecycle primitives under test (deliberately NOT on the
 *  coordinator interface — A-02). */
const cancel = (runId: string) => cancelRunTx({ db, clock }, runId);
// Threshold 0: any activity age reads as stale — these tests drive the
// transition directly; the threshold semantics are pinned at the sweep level.
const reclaim = (runId: string) => reclaimStaleRunTx({ db, clock }, { runId, runInactivityMs: 0 });

async function seedActiveRun(runOverrides: Partial<NewRun> = {}): Promise<string> {
  await seedRun(db, { id: "run-1", machineId, phase: "running", ...runOverrides });
  await seedLease(db, { tokenHash: sha256(SEED_CRED), runId: "run-1", machineId });
  return SEED_CRED;
}

describe("coordinator interface (A-02)", () => {
  it("exposes EXACTLY enqueueExecRun / poll / report — cancel and reclaim stay store-level", async () => {
    await fresh();
    expect(Object.keys(coordinator).sort()).toEqual(["enqueueExecRun", "poll", "report"]);
  });
});

describe("cancelRun primitive", () => {
  it("cancels a running run and deletes its lease in one transaction", async () => {
    await fresh();
    await seedActiveRun();
    const result = await cancel("run-1");
    expect(result).toBe(true);

    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "canceled", ts: clock.iso(), outcome: null });
    // The store-layer pin: after cancel there is NO active lease.
    expect(await snapshotLeases(db)).toEqual([]);
    // The retired credential is dead: report gets the unified 401.
    await expect(coordinator.report(SEED_CRED, { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
  });

  it("cancels a pending run (no lease existed) and stamps the transition", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "pending" });
    expect(await cancel("run-1")).toBe(true);
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "canceled", ts: clock.iso() });
  });

  it("is a no-op for terminal or missing runs", async () => {
    await fresh();
    await seedRun(db, { id: "run-done", machineId, phase: "done", outcome: "exec" });
    await seedRun(db, { id: "run-canceled", machineId, phase: "canceled" });
    const before = await snapshotRuns(db);
    expect(await cancel("run-done")).toBe(false);
    expect(await cancel("run-canceled")).toBe(false);
    expect(await cancel("run-ghost")).toBe(false);
    expect(await snapshotRuns(db)).toEqual(before);
  });
});

describe("reclaimStaleRun primitive (sweep-only)", () => {
  it("atomically errors the run and terminalizes the lease with the first now+24h window", async () => {
    await fresh();
    await seedActiveRun({ progress: { step: 2, label: "working" } });
    expect(await reclaim("run-1")).toBe("reclaimed");

    expect((await snapshotRuns(db))[0]).toMatchObject({
      phase: "error",
      outcome: "error",
      error: RECLAIM_RUN_ERROR,
      ts: clock.iso(),
    });
    const lease = (await snapshotLeases(db))[0]!;
    // "terminalize 必带 expiresAt" — the transition ALWAYS writes the window.
    expect(lease).toMatchObject({
      state: "terminal-grace",
      expiresAt: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("a repeat reclaim does NOT extend the first window", async () => {
    await fresh();
    await seedActiveRun();
    await reclaim("run-1");
    const first = (await snapshotLeases(db))[0]!;

    clock.advance(60_000);
    expect(await reclaim("run-1")).toBe("not_running");
    const again = (await snapshotLeases(db))[0]!;
    expect(again.expiresAt).toBe(first.expiresAt); // untouched first window
  });

  it("refuses non-running runs — a normal failure never earns a terminal-grace window", async () => {
    await fresh();
    await seedRun(db, { id: "run-pending", machineId, phase: "pending" });
    await seedRun(db, { id: "run-done", machineId, phase: "done", outcome: "exec" });
    await seedRun(db, { id: "run-failed", machineId, phase: "error", outcome: "error", error: "real failure" });
    const before = await snapshotRuns(db);

    for (const id of ["run-pending", "run-done", "run-failed", "run-ghost"]) {
      expect(await reclaim(id)).toBe("not_running");
    }
    expect(await snapshotRuns(db)).toEqual(before); // zero writes
    expect(await snapshotLeases(db)).toEqual([]); // no terminal-grace created
  });

  it("vetoes the reclaim when the in-transaction recheck finds FRESH activity (review: scan/reclaim TOCTOU)", async () => {
    await fresh();
    // ts seeded NOW: with a real inactivity threshold the in-tx re-validation
    // sees a live run — the scan's stale hint is only a hint, and a Phase 2
    // progress heartbeat that landed in between turns the reclaim into a
    // benign skip (NOT reclaimed, NOT failed).
    await seedActiveRun({ ts: clock.iso() });
    await expect(
      reclaimStaleRunTx(testDeps(db, clock), { runId: "run-1", runInactivityMs: 20 * 60_000 }),
    ).resolves.toBe("activity_fresh");
    // Zero writes: no error-ization, no terminal-grace window.
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "running", outcome: null });
    expect((await snapshotLeases(db))[0]).toMatchObject({ state: "active", expiresAt: null });
  });

  it("refuses a running run with NO lease: guard error, the whole transaction rolls back (review #6)", async () => {
    await fresh();
    await seedRun(db, { id: "run-no-lease", machineId, phase: "running" });
    await expect(reclaimStaleRunTx(testDeps(db, clock), { runId: "run-no-lease", runInactivityMs: 0 })).rejects.toMatchObject({
      name: "ReclaimGuardLostError",
    });
    // Zero writes: the run was NOT error-ized without a grace window.
    expect((await snapshotRuns(db))[0]).toMatchObject({ id: "run-no-lease", phase: "running", outcome: null });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("refuses a running run whose lease is NOT active: guard error, zero writes (review #6)", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    const expiry = new Date(clock.now().getTime() + 60_000).toISOString();
    await seedLease(db, { tokenHash: sha256("rk_tg"), runId: "run-1", machineId, state: "terminal-grace", expiresAt: expiry });
    await expect(reclaimStaleRunTx(testDeps(db, clock), { runId: "run-1", runInactivityMs: 0 })).rejects.toMatchObject({
      name: "ReclaimGuardLostError",
    });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "running", outcome: null });
    expect((await snapshotLeases(db))[0]).toMatchObject({ state: "terminal-grace", expiresAt: expiry });
  });

  it("has NO general-purpose terminalizeLease on any store surface", () => {
    // The structural pin (plan §1): the lease-terminalize step exists only as
    // reclaimStaleRun's private in-transaction step. Nothing may import a
    // standalone terminalize to manufacture reconcile eligibility.
    for (const mod of [runsStore, leasesStore, reportStore]) {
      expect(Object.keys(mod)).not.toContain("terminalizeLease");
    }
  });
});

describe("terminal-grace fail-closed expiry (Day 8–10 plan §1)", () => {
  it("a terminal-grace lease with a MISSING expiresAt is dead: 401 + lazy cleanup, zero run writes", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });
    await seedLease(db, {
      tokenHash: sha256(SEED_CRED),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: null,
    });
    const runsBefore = await snapshotRuns(db);

    await expect(coordinator.report(SEED_CRED, { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
    expect(await snapshotLeases(db)).toEqual([]); // fail-closed cleanup committed
    expect(await snapshotRuns(db)).toEqual(runsBefore);
  });

  it("a terminal-grace lease with an UNPARSEABLE expiresAt is dead: 401 + lazy cleanup", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });
    await seedLease(db, {
      tokenHash: sha256(SEED_CRED),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: "not-a-date",
    });

    await expect(coordinator.report(SEED_CRED, { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("the in-transaction re-check catches a window corrupted AFTER the read-side resolve", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let markResolved!: () => void;
    const resolved = new Promise<void>((resolve) => {
      markResolved = resolve;
    });
    await fresh({
      hooks: {
        afterReportResolve: async () => {
          markResolved();
          await gate;
        },
      },
    });
    // A HEALTHY swept run: terminal-grace well inside its 24h window.
    await seedRun(db, { id: "run-1", machineId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });
    await seedLease(db, {
      tokenHash: sha256(SEED_CRED),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: new Date(clock.now().getTime() + 24 * 60 * 60_000).toISOString(),
    });
    const runsBefore = await snapshotRuns(db);

    const reportPromise = coordinator.report(SEED_CRED, { ok: true });
    await resolved;
    // The window stamp is corrupted while the report is parked: the write
    // transaction's re-check must apply the SAME fail-closed rule.
    await db.update(runLeases).set({ expiresAt: "corrupted" }).where(eq(runLeases.runId, "run-1"));
    openGate();

    await expect(reportPromise).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
    expect(await snapshotLeases(db)).toEqual([]); // cleanup commits, the 401 rides after
    expect(await snapshotRuns(db)).toEqual(runsBefore);
  });
});

describe("active lease is never time-killed (review)", () => {
  it("the shared predicate: active stays LIVE with past, future or null expiresAt; only the anomaly flag differs", () => {
    const nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2030-01-01T00:00:00.000Z";
    expect(isLeaseDead({ state: "active", expiresAt: past }, nowMs)).toBe(false);
    expect(isLeaseDead({ state: "active", expiresAt: future }, nowMs)).toBe(false);
    expect(isLeaseDead({ state: "active", expiresAt: null }, nowMs)).toBe(false);
    // …while terminal-grace keeps its fail-closed rule.
    expect(isLeaseDead({ state: "terminal-grace", expiresAt: past }, nowMs)).toBe(true);
    expect(isLeaseDead({ state: "terminal-grace", expiresAt: null }, nowMs)).toBe(true);
    expect(isLeaseDead({ state: "terminal-grace", expiresAt: future }, nowMs)).toBe(false);
    expect(isActiveLeaseAnomalous({ state: "active", expiresAt: past })).toBe(true);
    expect(isActiveLeaseAnomalous({ state: "active", expiresAt: null })).toBe(false);
  });

  it("an active lease with an anomalous expiresAt stays live: the report self-heals and emits one safe invariant log", async () => {
    const logs: string[] = [];
    await fresh({ log: (line) => logs.push(line) });
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    // Anomalous legacy data: an ACTIVE lease carrying an expiry (the schema
    // doesn't forbid it; every normal writer stores null). Time-killing it
    // would orphan the running run forever — instead it stays LIVE.
    await seedLease(db, {
      tokenHash: sha256(SEED_CRED),
      runId: "run-1",
      machineId,
      state: "active",
      expiresAt: "untrusted-expiry\nrk_should_not_log",
    });

    await expect(coordinator.report(SEED_CRED, { ok: true, message: "recovered" })).resolves.toEqual({ ok: true });

    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "done", outcome: "exec", message: "recovered" });
    expect(await snapshotLeases(db)).toEqual([]); // the REPORT retired it — never time
    const violations = logs.filter((l) => l.includes("invariant violation") && l.includes("run-1"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("classification=active_lease_has_expiry");
    expect(violations.every((l) => !l.includes(SEED_CRED) && !l.includes(sha256(SEED_CRED)) && !l.includes("rk_should_not_log"))).toBe(
      true,
    );
  });
});

describe("transaction guards", () => {
  it("rolls the whole claim back when the lease INSERT fails (mint collides an existing hash)", async () => {
    await fresh();
    // The deterministic factory's first mint is rk_testcred_1 — pre-seed a
    // lease with THAT hash so the claim's lease INSERT violates the PK.
    await seedLease(db, { tokenHash: sha256("rk_testcred_1"), runId: "run-unrelated", machineId });
    await seedRun(db, { id: "run-1", machineId, phase: "pending" });

    const before = await snapshotRuns(db);
    await expect(coordinator.poll(TOKEN, {})).rejects.toThrow();
    // Claim rolled back: the run is STILL pending (not running), no delivery.
    expect(await snapshotRuns(db)).toEqual(before);
    expect(await snapshotLeases(db)).toHaveLength(1); // only the pre-seeded one
  });

  it("delivery lost + machine vanished: claim → (response dropped) → reclaim → poll stays empty, exactly one wake-report", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "pending" });
    const first = await coordinator.poll(TOKEN, {});
    expect(first.deliveries).toHaveLength(1);
    const droppedToken = first.deliveries[0]!.runToken; // "lost" — daemon never saw it

    // The machine vanishes; the sweep reclaims the orphaned running run.
    clock.advance(15 * 60_000);
    expect(await reclaim("run-1")).toBe("reclaimed");

    // Still no re-dispatch — the run left the surface at claim time.
    const after = await coordinator.poll(TOKEN, {});
    expect(after.deliveries).toEqual([]);

    // …and the run is reconcilable exactly once via the original credential.
    const wake = await coordinator.report(droppedToken, { ok: true, message: "actually finished before dying" });
    expect(wake).toEqual({ ok: true, reconciled: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "done", outcome: "exec", error: null });
  });

  it("report/cancel interleaving: report parked after resolve loses to a committed cancel (app-level gate)", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let markResolved!: () => void;
    const resolved = new Promise<void>((resolve) => {
      markResolved = resolve;
    });
    await fresh({
      hooks: {
        afterReportResolve: async () => {
          markResolved();
          await gate; // parked: initial resolve done, write tx not yet open
        },
      },
    });
    await seedActiveRun();
    const loopsBefore = await snapshotLoops(db);

    const reportPromise = coordinator.report(SEED_CRED, { ok: true, message: "too late" });
    await resolved;
    // The cancel's transaction commits FOR REAL while the report is parked.
    expect(await cancel("run-1")).toBe(true);
    openGate();

    // The report's in-transaction re-resolve catches the revoked capability:
    // unified 401, no terminal write, no loop write.
    await expect(reportPromise).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "consumed_or_revoked",
    });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "canceled", message: null });
    expect(await snapshotLeases(db)).toEqual([]);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });
});
