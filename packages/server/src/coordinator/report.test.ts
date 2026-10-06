/**
 * Report — the run-finalize state machine (ADR-001 T3/T5, plan §3).
 *
 *  T3  effect-idempotent: first report finalizes + retires the lease in one
 *      transaction; a second report with the same credential gets the unified
 *      401 with ZERO side effects.
 *  T5  terminal-grace reconcile: a swept run (error + terminal-grace lease)
 *      accepts exactly ONE wake-report — ok flips error→done, failure replaces
 *      the generic reclaim reason with the real one (never keeping the sweep
 *      timeout text) — then the lease is gone and further reports 401.
 *
 * The credential is OPAQUE on the read side (a legacy bare-UUID lease keeps
 * resolving); `body.runId` is a mere echo — the lease's run is authoritative.
 * Everything Phase 1 doesn't consume (cursor, taskFileContent, artifacts,
 * transcript, cost, attempts, non-exec outcome) parses but never writes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Delivery, ReportRequest } from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";

import { createMachineAttributionResolver } from "../artifact/attribution-machine.js";
import { updateArtifactConfig } from "../artifact/config.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactManifests, loops, runLeases, type NewArtifactManifest, type NewRun, type Run } from "../db/schema.js";
import { buildReportWriteSet, GENERIC_RUN_ERROR } from "../store/report.js";
import { cancelRunTx, RECLAIM_RUN_ERROR } from "../store/runs.js";
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
import { createRunCoordinator, type RunCoordinator, type RunCoordinatorDependencies } from "./index.js";

const TOKEN = "dk_test_machine_alpha";
const BARE_UUID_TOKEN = "9f0b2c4d-1a2b-4c3d-8e9f-0123456789ab";

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
  await seedLoop(db, { id: "loop-1", name: "react-doctor", state: { cursor: 1 }, taskFileContent: "spec v1", taskFileSyncedAt: "2026-07-02T00:00:00.000Z" });
  coordinator = createRunCoordinator(testDeps(db, clock, depsOverrides));
}

/** Seed a pending exec run on this machine and claim it through a real poll
 *  (Phase 4: the poll declares terminal-journal-v1, so the claim mints a v1
 *  lease and the report below exercises the v1 branch). */
async function claimViaPoll(runId: string): Promise<Delivery> {
  await seedRun(db, { id: runId, machineId });
  const { deliveries } = await coordinator.poll(TOKEN, { capabilities: ["terminal-journal-v1"] });
  expect(deliveries).toHaveLength(1);
  return deliveries[0]!;
}

/** Direct fixture: a running run + its active lease (bypasses poll). */
async function seedActiveRun(runOverrides: Partial<NewRun> = {}, token = "rk_seed_token"): Promise<string> {
  const id = runOverrides.id ?? "run-1";
  await seedRun(db, { id, machineId, phase: "running", ...runOverrides });
  await seedLease(db, { tokenHash: sha256(token), runId: id, machineId });
  return token;
}

/** Direct fixture: a swept run — error/error + terminal-grace lease. */
async function seedSweptRun(runOverrides: Partial<NewRun> = {}, token = "rk_swept_token"): Promise<string> {
  await seedRun(db, {
    id: "run-1",
    machineId,
    phase: "error",
    outcome: "error",
    error: RECLAIM_RUN_ERROR,
    progress: { step: 3, label: "mid-work", at: "2026-07-02T00:00:00.000Z" },
    ...runOverrides,
  });
  await seedLease(db, {
    tokenHash: sha256(token),
    runId: "run-1",
    machineId,
    state: "terminal-grace",
    expiresAt: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  return token;
}

describe("report: T3 effect-idempotent finalize", () => {
  it("first report finalizes (done/exec + base fields + lease retire), second 401s with zero side effects", async () => {
    await fresh();
    const delivery = await claimViaPoll("run-1");

    const result = await coordinator.report(delivery.runToken, {
      ok: true,
      durationMs: 1234,
      sessionId: "sess-abc",
      terminal: { kind: "report", status: "resolved", message: "shipped the fix" },
      taskFileContent: "spec v2",
    });
    expect(result).toEqual({ ok: true });

    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({
      id: "run-1",
      phase: "done",
      outcome: "exec",
      message: "shipped the fix",
      error: null,
      durationMs: 1234,
      sessionId: "sess-abc",
      progress: null,
      ts: clock.iso(),
    });
    expect(await snapshotLeases(db)).toEqual([]);

    // Second report with the same credential: unified invalid, ZERO changes.
    const runsBefore = await snapshotRuns(db);
    const loopsBefore = await snapshotLoops(db);
    await expect(coordinator.report(delivery.runToken, { ok: true, message: "again" })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
    });
    expect(await snapshotRuns(db)).toEqual(runsBefore);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("clears progress and stamps ts from the injected clock on every accepted report", async () => {
    await fresh();
    const token = await seedActiveRun({ progress: { step: 9, label: "working", at: "2026-07-02T00:00:00.000Z" } });
    await coordinator.report(token, { ok: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({ progress: null, ts: clock.iso() });
  });

  it("failure writes error/error with the cleaned body.error", async () => {
    await fresh();
    const token = await seedActiveRun();
    const result = await coordinator.report(token, { ok: false, error: "  boom\0 happened  " });
    expect(result).toEqual({ ok: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({
      phase: "error",
      outcome: "error",
      error: "boom happened",
      ts: clock.iso(),
    });
  });

  it("failure without a usable error falls back to the stable generic reason", async () => {
    await fresh();
    // Sub-cases share ONE database (seeding distinct runs) — each fresh()
    // boots a whole PGlite instance, which is the suite's scarcest resource.
    const cases: Array<{ error?: string }> = [{}, { error: "" }, { error: "   \n  " }];
    let n = 0;
    for (const c of cases) {
      n += 1;
      const token = `rk_missing_${n}`;
      await seedRun(db, { id: `run-${n}`, machineId, phase: "running" });
      await seedLease(db, { tokenHash: sha256(token), runId: `run-${n}`, machineId });
      await coordinator.report(token, { ok: false, ...c });
      expect((await snapshotRuns(db)).find((r) => r.id === `run-${n}`)!.error).toBe(GENERIC_RUN_ERROR);
    }
  });

  it("success explicitly clears a stale error on the run", async () => {
    await fresh();
    const token = await seedActiveRun({ error: "stale earlier failure" });
    await coordinator.report(token, { ok: true });
    expect((await snapshotRuns(db))[0]!.error).toBeNull();
  });
});

describe("report: message priority (A-08)", () => {
  it("1. explicit body.message wins over existing run message and finalText", async () => {
    await fresh();
    const token = await seedActiveRun({ message: "existing" });
    await coordinator.report(token, { ok: true, message: "explicit", finalText: "fallback" });
    expect((await snapshotRuns(db))[0]!.message).toBe("explicit");
  });

  it("1b. an explicitly-carried empty message is honored (reference semantics)", async () => {
    await fresh();
    const token = await seedActiveRun({ message: "existing" });
    await coordinator.report(token, { ok: true, message: "" });
    expect((await snapshotRuns(db))[0]!.message).toBe("");
  });

  it("2. without body.message the run's existing non-empty message is kept (finalText ignored)", async () => {
    await fresh();
    const token = await seedActiveRun({ message: "existing" });
    await coordinator.report(token, { ok: true, finalText: "fallback" });
    expect((await snapshotRuns(db))[0]!.message).toBe("existing");
  });

  it("2b. a reused existing message is cleaned uniformly — capped, and NUL-stripped (review #5)", async () => {
    await fresh();
    // Cap arm, through the full report path:
    const token = await seedActiveRun({ message: `kept-${"k".repeat(3000)}` });
    await coordinator.report(token, { ok: true });
    expect((await snapshotRuns(db))[0]!.message).toBe(`kept-${"k".repeat(1995)}`);

    // NUL arm, at the pure builder (Postgres refuses 0x00 in text columns, so
    // a NUL-bearing message can't be seeded — assert the write-set directly).
    const ws = buildReportWriteSet({ ok: true }, { message: "a\0b" } as unknown as Run, clock.iso());
    expect(ws.message).toBe("ab");
  });

  it("3. finalText is the fallback only when the run has no message", async () => {
    await fresh();
    const token = await seedActiveRun({ message: null });
    await coordinator.report(token, { ok: true, finalText: "fallback text" });
    expect((await snapshotRuns(db))[0]!.message).toBe("fallback text");
  });

  it("4. all absent → message stays null", async () => {
    await fresh();
    const token = await seedActiveRun({ message: null });
    await coordinator.report(token, { ok: true });
    expect((await snapshotRuns(db))[0]!.message).toBeNull();
  });
});

describe("report: text hygiene + optional fields", () => {
  it("NUL-strips and caps message/finalText/error at 2000 and sessionId at 200", async () => {
    await fresh();
    const token = await seedActiveRun();
    await coordinator.report(token, {
      ok: false,
      error: `e\0${"x".repeat(3000)}`,
      sessionId: `s\0${"y".repeat(300)}`,
    });
    const run = (await snapshotRuns(db))[0]!;
    expect(run.error).toBe(`e${"x".repeat(1999)}`);
    expect(run.sessionId).toBe(`s${"y".repeat(199)}`);

    // Same DB, second run — PGlite instances are the suite's scarcest resource.
    await seedRun(db, { id: "run-2", machineId, phase: "running" });
    await seedLease(db, { tokenHash: sha256("rk_second"), runId: "run-2", machineId });
    await coordinator.report("rk_second", { ok: true, message: `m${"z".repeat(3000)}` });
    expect((await snapshotRuns(db)).find((r) => r.id === "run-2")!.message).toBe(`m${"z".repeat(1999)}`);
  });

  it("durationMs/sessionId save when present and overwrite with null when absent", async () => {
    await fresh();
    const token = await seedActiveRun({ durationMs: 42, sessionId: "old-session" });
    await coordinator.report(token, { ok: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({ durationMs: null, sessionId: null });
  });

  it("pre-declared fields parse but never write Run/Loop (cursor, taskFile, artifacts, transcript, cost, attempts, outcome)", async () => {
    await fresh();
    const token = await seedActiveRun({
      state: { metric: 1 },
      costUsd: 0.42,
      usage: { numTurns: 3 },
      artifacts: [{ path: "a.ts", kind: "edited" }],
      transcript: [{ kind: "text", text: "hi" }],
    });
    const body: ReportRequest = {
      ok: true,
      outcome: "direct", // non-exec outcome: parse-only in Phase 1
      cursor: { cursor: 99 },
      taskFileContent: "rewritten spec",
      artifacts: [{ path: "evil.ts", kind: "created" }],
      transcript: [{ kind: "tool", name: "bash" }],
      cost: { usd: 9.99, numTurns: 42 },
      attempts: 5,
    };
    await coordinator.report(token, body);

    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({
      phase: "done",
      outcome: "exec", // fixed — never the daemon-claimed outcome
      state: { metric: 1 },
      costUsd: 0.42,
      usage: { numTurns: 3 },
      artifacts: [{ path: "a.ts", kind: "edited" }],
      transcript: [{ kind: "text", text: "hi" }],
    });
    const loop = (await snapshotLoops(db))[0]!;
    expect(loop).toMatchObject({ state: { cursor: 1 }, taskFileContent: "spec v1" });
  });
});

describe("report: credential resolution", () => {
  it("resolves a legacy bare-UUID credential (reader side never shape-filters)", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    await seedLease(db, { tokenHash: sha256(BARE_UUID_TOKEN), runId: "run-1", machineId });
    const result = await coordinator.report(BARE_UUID_TOKEN, { ok: true });
    expect(result).toEqual({ ok: true });
    expect((await snapshotRuns(db))[0]!.phase).toBe("done");
  });

  it("ignores a forged body.runId — the lease's run is authoritative", async () => {
    await fresh();
    const token = await seedActiveRun();
    await seedRun(db, { id: "run-other", machineId, phase: "running" });
    await coordinator.report(token, { ok: true, runId: "run-other" });
    const byId = new Map((await snapshotRuns(db)).map((r) => [r.id, r]));
    expect(byId.get("run-1")!.phase).toBe("done");
    expect(byId.get("run-other")!.phase).toBe("running");
  });

  it("rejects an unknown credential with zero writes", async () => {
    await fresh();
    await seedActiveRun();
    const before = await snapshotRuns(db);
    await expect(coordinator.report("rk_nope_nope_nope", { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
    expect(await snapshotRuns(db)).toEqual(before);
    expect(await snapshotLeases(db)).toHaveLength(1); // the OTHER lease is untouched
  });

  it("fails closed on a stale phase (done run + residual active lease): lease dropped, run untouched, 401", async () => {
    await fresh();
    const token = await seedActiveRun({ phase: "done", outcome: "exec" });
    await expect(coordinator.report(token, { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "stale_phase",
    });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "done", outcome: "exec" });
    expect(await snapshotLeases(db)).toEqual([]); // residual lease cleaned up
  });

  it("fails closed on an orphaned lease (run row missing): lease dropped, 401", async () => {
    await fresh();
    await seedLease(db, { tokenHash: sha256("rk_orphan"), runId: "run-ghost", machineId });
    await expect(coordinator.report("rk_orphan", { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "orphaned_run",
    });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("lazily drops an expired terminal-grace lease and rejects the report", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });
    await seedLease(db, {
      tokenHash: sha256("rk_expired"),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: new Date(clock.now().getTime() - 1000).toISOString(), // already past
    });
    await expect(coordinator.report("rk_expired", { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
    expect(await snapshotLeases(db)).toEqual([]);
    expect((await snapshotRuns(db))[0]!.phase).toBe("error"); // untouched
  });

  it("pins the expiry boundary: a lease dies AT its expiresAt", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });
    await seedLease(db, {
      tokenHash: sha256("rk_boundary"),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: clock.iso(), // exactly now
    });
    await expect(coordinator.report("rk_boundary", { ok: true })).rejects.toMatchObject({
      reason: "unknown_or_expired",
    });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("re-checks expiry INSIDE the write transaction — a window that closes after resolve still denies (review #4)", async () => {
    await fresh({
      hooks: {
        afterReportResolve: () => {
          // The grace window closes between the read-side resolve and the
          // write transaction.
          clock.advance(2 * 60 * 60 * 1000); // +2h
        },
      },
    });
    await seedRun(db, { id: "run-1", machineId, phase: "error", outcome: "error", error: RECLAIM_RUN_ERROR });
    await seedLease(db, {
      tokenHash: sha256("rk_expiring_midflight"),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString(), // +1h: live at resolve
    });
    await expect(coordinator.report("rk_expiring_midflight", { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "unknown_or_expired",
    });
    // Lease cleaned up, run NOT reconciled.
    expect(await snapshotLeases(db)).toEqual([]);
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "error", error: RECLAIM_RUN_ERROR });
  });
});

describe("report: T5 terminal-grace reconcile (exactly once)", () => {
  it("ok=true flips error→done, clears the reclaim reason, returns reconciled:true; second report 401s", async () => {
    await fresh();
    const token = await seedSweptRun();
    const result = await coordinator.report(token, { ok: true, message: "woke up and finished", durationMs: 900 });
    expect(result).toEqual({ ok: true, reconciled: true });

    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({
      phase: "done",
      outcome: "exec",
      error: null, // reclaim reason cleared
      message: "woke up and finished",
      durationMs: 900,
      progress: null,
      ts: clock.iso(),
    });
    expect(await snapshotLeases(db)).toEqual([]);

    const before = await snapshotRuns(db);
    await expect(coordinator.report(token, { ok: true })).rejects.toMatchObject({ name: "RunCapabilityInvalidError" });
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it("ok=false keeps error/error and replaces the sweep reason with the daemon's real error", async () => {
    await fresh();
    const token = await seedSweptRun();
    const result = await coordinator.report(token, { ok: false, error: "tests failed: 3 red" });
    expect(result).toEqual({ ok: true, reconciled: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({
      phase: "error",
      outcome: "error",
      error: "tests failed: 3 red",
      ts: clock.iso(),
    });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("ok=false without a usable error uses the stable fallback — NEVER keeps the sweep timeout reason", async () => {
    await fresh();
    const token = await seedSweptRun();
    await coordinator.report(token, { ok: false, error: "  " });
    const run = (await snapshotRuns(db))[0]!;
    expect(run.error).toBe(GENERIC_RUN_ERROR);
    expect(run.error).not.toBe(RECLAIM_RUN_ERROR);
    // Loop cursor/state is never advanced by a report.
    expect((await snapshotLoops(db))[0]!.state).toEqual({ cursor: 1 });
  });

  it("a terminal-grace lease on a NON-error run is stale-phase fail-closed", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_weird"),
      runId: "run-1",
      machineId,
      state: "terminal-grace",
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    await expect(coordinator.report("rk_weird", { ok: true })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
      reason: "stale_phase",
    });
    expect((await snapshotRuns(db))[0]!.phase).toBe("running");
    expect(await snapshotLeases(db)).toEqual([]);
  });
});

describe("report: race + transaction integrity", () => {
  it("two concurrent reports for one credential: exactly one finalizes, the loser gets the unified 401", async () => {
    await fresh();
    const token = await seedActiveRun();
    const [winner, loser] = await Promise.allSettled([
      coordinator.report(token, { ok: true, message: "first" }),
      coordinator.report(token, { ok: false, error: "second" }),
    ]);
    const fulfilled = [winner, loser].filter((r) => r.status === "fulfilled");
    const rejected = [winner, loser].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ name: "RunCapabilityInvalidError" });
    expect((await snapshotRuns(db))[0]!.phase).toBe("done");
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("a failure between run update and lease delete rolls the WHOLE transaction back (both paths)", async () => {
    // Normal finalize path.
    await fresh({
      hooks: {
        insideReportTx: () => {
          throw new Error("injected finalize failure");
        },
      },
    });
    const token = await seedActiveRun();
    await expect(coordinator.report(token, { ok: true, message: "lost" })).rejects.toThrow("injected finalize failure");
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "running", message: null });
    expect(await snapshotLeases(db)).toHaveLength(1);

    // Reconcile path.
    await fresh({
      hooks: {
        insideReportTx: () => {
          throw new Error("injected reconcile failure");
        },
      },
    });
    const swept = await seedSweptRun();
    await expect(coordinator.report(swept, { ok: true })).rejects.toThrow("injected reconcile failure");
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "error", error: RECLAIM_RUN_ERROR });
    expect((await snapshotLeases(db))[0]).toMatchObject({ state: "terminal-grace" });
  });
});

describe("slice 6: report-carried artifact binding (ADR-010 决策 16 片 6 条目 / 决策 19)", () => {
  /** The production attribution seam (start.ts), re-derived on the tx handle. */
  const artifactBinding: RunCoordinatorDependencies["artifactBinding"] = {
    resolveAttribution: (id, handle) => createMachineAttributionResolver({ db: handle }).resolve({ machineId: id }),
  };

  /** Arm loop-1 for binding: the attribution chain needs loop.machineId ==
   *  the run's machine, and the bind guard needs a config generation. */
  async function seedBindableLoop(configRevision = 1): Promise<void> {
    await db
      .update(loops)
      .set({ machineId, artifactDir: "/data", artifactConfigRevision: configRevision })
      .where(eq(loops.id, "loop-1"));
  }

  async function seedCommittedManifest(overrides: Partial<NewArtifactManifest> = {}) {
    const row: NewArtifactManifest = {
      id: "amf-1",
      namespaceId: machineId,
      machineId,
      loopId: "loop-1",
      configRevision: 1,
      manifestRevision: 1,
      entries: [],
      fileCount: 0,
      totalBytes: 0,
      committedAt: clock.iso(),
      ...overrides,
    };
    await db.insert(artifactManifests).values(row);
    return row;
  }

  it("a legal finalize carrying a committed snapshot id binds it in the report transaction (AR1 server half)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedActiveRun();

    const result = await coordinator.report(token, { ok: true, durationMs: 42, artifactSnapshotId: "amf-1" });
    expect(result).toEqual({ ok: true });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({
      phase: "done",
      outcome: "exec",
      durationMs: 42,
      artifactSnapshotId: "amf-1",
      artifactSyncError: null,
      ts: clock.iso(),
    });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("a sync-error-only report records the daemon's classification verbatim — the run outcome is unaffected (AR5 server half)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    const token = await seedActiveRun();

    await coordinator.report(token, { ok: true, artifactSyncError: "timeout" });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "done", outcome: "exec", artifactSnapshotId: null, artifactSyncError: "timeout" });

    // …and on a failure report the classification lands beside the legal
    // terminal error (sync failure never rewrites the run outcome).
    const token2 = await seedActiveRun({ id: "run-2" }, "rk_seed_token_2");
    await coordinator.report(token2, { ok: false, error: "agent crashed", artifactSyncError: "unreadable" });
    const failed = (await snapshotRuns(db)).find((r) => r.id === "run-2")!;
    expect(failed).toMatchObject({ phase: "error", outcome: "error", error: "agent crashed", artifactSyncError: "unreadable" });
  });

  it("a report carrying BOTH fields records ambiguous_artifact_report, binds nothing, and still commits the legal terminal state", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest(); // a VALID reference — ambiguity still wins
    const token = await seedActiveRun();

    await coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1", artifactSyncError: "timeout" });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({
      phase: "done",
      artifactSnapshotId: null,
      artifactSyncError: "ambiguous_artifact_report",
    });
  });

  it("illegal snapshot references record their stable rejection and never bind (AR6)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest(); // the consistent "amf-1" for contrast
    await db.insert(artifactManifests).values({
      id: "amf-other-loop",
      namespaceId: machineId,
      machineId,
      loopId: "loop-other",
      configRevision: 1,
      manifestRevision: 1,
      entries: [],
      fileCount: 0,
      totalBytes: 0,
      committedAt: clock.iso(),
    });
    await db.insert(artifactManifests).values({
      id: "amf-stale",
      namespaceId: machineId,
      machineId,
      loopId: "loop-1",
      configRevision: 0, // behind the loop's generation 1
      manifestRevision: 2,
      entries: [],
      fileCount: 0,
      totalBytes: 0,
      committedAt: clock.iso(),
    });

    const cases: Array<[string, string, string]> = [
      // [runId, referenced id, expected rejection]
      ["run-ghost", "amf-ghost", "snapshot_not_committed"],
      ["run-loop", "amf-other-loop", "cross_loop"],
      ["run-ns", "amf-foreign", "snapshot_not_committed"], // no row at all — existence never leaks
      ["run-stale", "amf-stale", "stale_config_generation"],
    ];
    for (const [runId, snapshotId, expected] of cases) {
      const token = await seedActiveRun({ id: runId }, `rk_${runId}`);
      await coordinator.report(token, { ok: true, artifactSnapshotId: snapshotId });
      const run = (await snapshotRuns(db)).find((r) => r.id === runId)!;
      expect(run).toMatchObject({ phase: "done", outcome: "exec", artifactSnapshotId: null, artifactSyncError: expected });
    }
  });

  it("a legal terminal-grace reconcile binds the carried snapshot (AR9, 决策 19 末段)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedSweptRun();

    const result = await coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1" });
    expect(result).toEqual({ ok: true, reconciled: true });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "done", outcome: "exec", artifactSnapshotId: "amf-1", artifactSyncError: null });
    expect(await snapshotLeases(db)).toEqual([]);
  });

  it("a config generation committed in the resolve window turns the bind into stale_config_generation (AR10)", async () => {
    await fresh({
      artifactBinding,
      hooks: {
        afterReportResolve: async () => {
          await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data/moved" });
        },
      },
    });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedActiveRun();

    // The hook commits generation 2 between the read-side resolve and the
    // write transaction; the tx's coherent snapshot sees it, so the plan
    // records the stable rejection — the run still finalizes.
    await coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1" });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "done", artifactSnapshotId: null, artifactSyncError: "stale_config_generation" });
  });

  it("the binding write rolls back WITH the run phase write (AR11)", async () => {
    await fresh({
      artifactBinding,
      hooks: {
        insideReportTx: () => {
          throw new Error("injected finalize failure");
        },
      },
    });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedActiveRun();

    await expect(coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1" })).rejects.toThrow(
      "injected finalize failure",
    );
    const run = (await snapshotRuns(db))[0]!;
    // The binding UPDATE lands BEFORE the hook seam; the rollback covers it.
    expect(run).toMatchObject({ phase: "running", artifactSnapshotId: null, artifactSyncError: null });
    expect(await snapshotLeases(db)).toHaveLength(1);
  });

  it("a canceled run's late report is denied and the artifact columns stay null (AR7)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedActiveRun();

    const canceled = await cancelRunTx({ db, clock }, "run-1");
    expect(canceled).toBe(true);
    await expect(coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1" })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
    });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "canceled", artifactSnapshotId: null, artifactSyncError: null });
  });

  it("a reclaimed run never binds without its ONE wake-report — and after the grace window the late report is denied (AR8)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    await seedSweptRun(); // never reported
    let run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "error", artifactSnapshotId: null, artifactSyncError: null });

    // Grace expired: the wake-report arrives too late — 401, columns stay null.
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedSweptRun({}, "rk_expired_grace");
    await db
      .update(runLeases)
      .set({ expiresAt: new Date(clock.now().getTime() - 1000).toISOString() })
      .where(eq(runLeases.tokenHash, sha256(token)));
    await expect(coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1" })).rejects.toMatchObject({
      name: "RunCapabilityInvalidError",
    });
    run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "error", artifactSnapshotId: null, artifactSyncError: null });
  });

  it("a v0 lease carrying the fields binds through the SAME shared path (U3/AR12)", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    await seedLease(db, { tokenHash: sha256("rk_v0"), runId: "run-1", machineId, terminalProtocolVersion: 0 });

    await coordinator.report("rk_v0", { ok: true, artifactSnapshotId: "amf-1" });
    const run = (await snapshotRuns(db))[0]!;
    expect(run).toMatchObject({ phase: "done", outcome: "exec", artifactSnapshotId: "amf-1", artifactSyncError: null });
  });

  it("a second report carrying the fields gets the unified 401 with zero side effects", async () => {
    await fresh({ artifactBinding });
    await seedBindableLoop();
    await seedCommittedManifest();
    const token = await seedActiveRun();
    await coordinator.report(token, { ok: true, artifactSnapshotId: "amf-1" });
    const runsBefore = await snapshotRuns(db);
    const loopsBefore = await snapshotLoops(db);
    await expect(
      coordinator.report(token, { ok: true, artifactSnapshotId: "amf-2", artifactSyncError: "y" }),
    ).rejects.toMatchObject({ name: "RunCapabilityInvalidError" });
    expect(await snapshotRuns(db)).toEqual(runsBefore);
    expect(await snapshotLoops(db)).toEqual(loopsBefore);
  });

  it("unit pin: the report write-set never carries the artifact keys (the binding writes them through its OWN guarded UPDATE)", () => {
    const ws = buildReportWriteSet(
      { ok: true, artifactSnapshotId: "amf-1", artifactSyncError: "artifact_storage_error" },
      {} as unknown as Run,
      "2026-07-29T00:00:00.000Z",
    );
    expect(Object.keys(ws).sort()).toEqual([
      "durationMs",
      "error",
      "message",
      "outcome",
      "phase",
      "progress",
      "sessionId",
      "ts",
    ]);
  });
});
