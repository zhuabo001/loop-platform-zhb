/**
 * Phase 4 Batch 2 Completed-guard pins (plan §2.4/§2.5, §4.1 生命周期):
 * the direct store/tx-level coverage for the Completion guards that the E2E
 * and the L-group only reach end-to-end. Every case runs against file-backed
 * PGlite through the REAL coordinator/store — no HTTP needed at this layer.
 *
 *  G1 finish cancels pending, keeps running (plan §2.5): a legal finish
 *     atomically completes the Loop, cancels the loop's OTHER pending run
 *     with the stable FINISH_CANCELED message, and leaves the other RUNNING
 *     run + its lease untouched. (The pending+running coexistence cannot be
 *     built through the public API — `running_exists` blocks it — so this
 *     seeds the defensive-depth state directly.)
 *  G2 manual Run Now on a Completed loop → `loop_completed`, zero writes.
 *  G3 scheduled trigger (catch-up / stale callback share this exact path)
 *     on a Completed loop → `loop_completed`, watermark NOT advanced.
 *  G4 a PAUSED but not-Completed loop still accepts a manual Run Now
 *     (Phase 3 semantics preserved).
 *  G5 schedule PATCH on a Completed loop: cron/timezone stay editable (the
 *     loop remains paused either way) while `enabled:true` conflicts with
 *     the stable `loop_completed` classification — only Reopen re-arms.
 *  G6/G7 enqueue resolves first, then Finish commits: the enqueue CAS loses
 *     and re-resolves to loop_completed for manual and scheduled triggers.
 *  G8 old callback resolves first, then schedule PATCH commits: the callback
 *     CAS loses and re-resolves to stale_revision.
 *  G9 Finish resolves first: public manual Run Now cannot commit because the
 *     finisher is still running; it returns running_exists with zero writes.
 *  G10 PATCH resolves first, then callback commits: the stale PATCH CAS is
 *      zero-row and a fresh update preserves the committed generation.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./db/index.js";
import { loops } from "./db/schema.js";
import { createRunCoordinator, type RunCoordinator } from "./coordinator/index.js";
import { updateSchedule } from "./schedule/state-machine.js";
import { FINISH_CANCELED_MESSAGE } from "./store/report.js";
import { enqueueExecRunTx } from "./store/runs.js";
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
} from "./testkit/index.js";

const TOKEN = "dk_guard_machine";
const COMPLETED_AT = "2026-07-28T00:00:00.000Z";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let machineId: string;
let coordinator: RunCoordinator;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  machineId = await seedMachineForToken(db, TOKEN);
  coordinator = createRunCoordinator(testDeps(db, clock));
}

/** A legally Completed loop row (the DB CHECK's full triple, paused). */
async function seedCompletedLoop(extra: Partial<Parameters<typeof seedLoop>[1]> = {}): Promise<void> {
  await seedLoop(db, {
    id: "loop-1",
    machineId,
    goal: "done-goal",
    completedAt: COMPLETED_AT,
    completionReason: "goal met earlier",
    enabled: false,
    ...extra,
  });
}

describe("G1 — a legal finish cancels the loop's OTHER pending run but keeps the running one", () => {
  it("finish commits completion + pending-cancel + running-kept in one transaction", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "shared", goalRevision: 0 });

    // run-1: the finishing run (running + v1 lease with canFinish).
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_finishing"),
      runId: "run-1",
      machineId,
      canFinish: true,
      terminalProtocolVersion: 1,
      goalRevision: 0,
    });
    // run-2: a leftover pending run of the same loop.
    await seedRun(db, { id: "run-2", machineId, phase: "pending" });
    // run-3: another RUNNING run with its own live lease.
    await seedRun(db, { id: "run-3", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_running"),
      runId: "run-3",
      machineId,
      canFinish: true,
      terminalProtocolVersion: 1,
      goalRevision: 0,
    });

    const ack = await coordinator.report("rk_finishing", {
      ok: true,
      outcome: "exec",
      durationMs: 1,
      terminal: { kind: "finish", reason: "goal met by run-1" },
      taskFileSyncError: "missing",
    });
    // A legal finish carries the internal schedulerReconcile signal (the
    // HTTP layer consumes it through the seam — it never reaches the wire).
    expect(ack).toMatchObject({ ok: true });
    expect(ack.schedulerReconcile).toBeDefined();

    const [loop] = await snapshotLoops(db);
    expect(loop).toMatchObject({
      completedAt: expect.any(String),
      completionReason: "goal met by run-1",
      enabled: false,
    });

    const runs = await snapshotRuns(db);
    expect(runs.find((r) => r.id === "run-1")).toMatchObject({ phase: "done", outcome: "exec", message: "goal met by run-1" });
    // The sibling PENDING run is canceled with the stable classification…
    expect(runs.find((r) => r.id === "run-2")).toMatchObject({
      phase: "canceled",
      outcome: "skipped",
      message: FINISH_CANCELED_MESSAGE,
    });
    // …while the sibling RUNNING run and its lease survive untouched.
    expect(runs.find((r) => r.id === "run-3")).toMatchObject({ phase: "running", outcome: null });

    const leases = await snapshotLeases(db);
    expect(leases.find((l) => l.runId === "run-1")).toBeUndefined();
    expect(leases.find((l) => l.runId === "run-3")).toMatchObject({ state: "active" });
  });
});

describe("G2 — manual Run Now on a Completed loop is refused with loop_completed and zero writes", () => {
  it("enqueueExecRun (manual) → loop_completed; no run row appears", async () => {
    await fresh();
    await seedCompletedLoop();

    const result = await coordinator.enqueueExecRun("loop-1");
    expect(result).toEqual({ enqueued: false, reason: "loop_completed" });
    expect(await snapshotRuns(db)).toEqual([]);
  });
});

describe("G3 — a scheduled trigger (the catch-up / stale-callback path) on a Completed loop is refused and never advances the watermark", () => {
  it("enqueueExecRun (scheduled) → loop_completed; lastScheduledAt stays null", async () => {
    await fresh();
    await seedCompletedLoop({ cron: "* * * * *", scheduleRevision: 0 });

    const result = await coordinator.enqueueExecRun("loop-1", {
      kind: "scheduled",
      scheduledFor: "2026-07-29T00:01:00.000Z",
      scheduleRevision: 0,
    });
    expect(result).toEqual({ enqueued: false, reason: "loop_completed" });
    const [loop] = await snapshotLoops(db);
    expect(loop!.lastScheduledAt).toBeNull();
    expect(await snapshotRuns(db)).toEqual([]);
  });
});

describe("G4 — a PAUSED (not Completed) loop still accepts a manual Run Now", () => {
  it("enabled=false without a completion triple → the manual enqueue succeeds", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, enabled: false });

    const result = await coordinator.enqueueExecRun("loop-1");
    if (!result.enqueued) throw new Error(`expected the paused loop to enqueue, got ${result.reason}`);
    expect(result.supersededRunIds).toEqual([]);
    const runs = await snapshotRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: result.runId, phase: "pending", role: "exec" });
  });
});

describe("G5 — schedule PATCH on a Completed loop: cron/timezone stay editable, re-enable conflicts", () => {
  it("cron/timezone change commits with the loop still paused; enabled:true → loop_completed conflict", async () => {
    await fresh();
    await seedCompletedLoop({ cron: "0 0 1 1 *", scheduleRevision: 0 });

    // cron/timezone edit: allowed — the loop remains paused either way.
    const edit = await updateSchedule({ db, clock }, "loop-1", { cron: "0 12 1 1 *", timezone: "Asia/Shanghai" });
    expect(edit).toMatchObject({ found: true, changed: true });
    const [afterEdit] = await snapshotLoops(db);
    expect(afterEdit).toMatchObject({
      cron: "0 12 1 1 *",
      timezone: "Asia/Shanghai",
      enabled: false,
      completedAt: COMPLETED_AT,
      scheduleActivatedAt: null,
    });

    // Re-enable: refused with the stable conflict — only Reopen re-arms.
    const enable = await updateSchedule({ db, clock }, "loop-1", { enabled: true });
    expect(enable).toMatchObject({ found: true, conflict: "loop_completed", changed: false });
    const [afterEnable] = await snapshotLoops(db);
    expect(afterEnable!.enabled).toBe(false);
  });
});

describe("G6 — Finish vs manual Run Now: a completion committed after resolve wins the revision guard", () => {
  it("re-resolves to loop_completed and never inserts a post-Completion pending run", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "finish-me", goalRevision: 0 });
    await seedRun(db, { id: "run-finisher", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_finisher"),
      runId: "run-finisher",
      machineId,
      canFinish: true,
      terminalProtocolVersion: 1,
      goalRevision: 0,
    });
    const [loop] = await snapshotLoops(db);
    let hookCalls = 0;
    const result = await enqueueExecRunTx(
      {
        ...testDeps(db, clock),
        hooks: {
          afterEnqueueLoopResolve: async () => {
            hookCalls += 1;
            if (hookCalls > 1) return;
            await coordinator.report("rk_finisher", {
              ok: true,
              outcome: "exec",
              durationMs: 1,
              terminal: { kind: "finish", reason: "done during Run Now" },
              taskFileSyncError: "missing",
            });
          },
        },
      },
      loop!,
      { kind: "manual" },
    );

    expect(result).toEqual({ enqueued: false, reason: "loop_completed" });
    expect(hookCalls).toBe(2);
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-finisher", phase: "done", outcome: "exec" }),
    ]);
  });
});

describe("G7 — Finish vs scheduled callback: an old callback cannot advance the Completed generation", () => {
  it("re-resolves to loop_completed; watermark and pending set stay frozen", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      goal: "finish-me",
      goalRevision: 0,
      cron: "* * * * *",
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-07-27T23:59:00.000Z",
    });
    await seedRun(db, { id: "run-finisher", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_finisher_scheduled"),
      runId: "run-finisher",
      machineId,
      canFinish: true,
      terminalProtocolVersion: 1,
      goalRevision: 0,
    });
    const [loop] = await snapshotLoops(db);
    let hookCalls = 0;
    const result = await enqueueExecRunTx(
      {
        ...testDeps(db, clock),
        hooks: {
          afterEnqueueLoopResolve: async () => {
            hookCalls += 1;
            if (hookCalls > 1) return;
            await coordinator.report("rk_finisher_scheduled", {
              ok: true,
              outcome: "exec",
              durationMs: 1,
              terminal: { kind: "finish", reason: "done during callback" },
              taskFileSyncError: "missing",
            });
          },
        },
      },
      loop!,
      { kind: "scheduled", scheduledFor: "2026-07-28T00:00:00.000Z", scheduleRevision: 0 },
    );

    expect(result).toEqual({ enqueued: false, reason: "loop_completed" });
    expect(hookCalls).toBe(2);
    const [completed] = await snapshotLoops(db);
    expect(completed).toMatchObject({ completedAt: expect.any(String), lastScheduledAt: null });
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-finisher", phase: "done", outcome: "exec" }),
    ]);
  });
});

describe("G8 — schedule PATCH vs scheduled callback: a callback resolved on the old generation loses CAS", () => {
  it("re-resolves to stale_revision without advancing the new schedule watermark", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      cron: "* * * * *",
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-07-27T23:59:00.000Z",
    });
    const [loop] = await snapshotLoops(db);
    let hookCalls = 0;
    const result = await enqueueExecRunTx(
      {
        ...testDeps(db, clock),
        hooks: {
          afterEnqueueLoopResolve: async () => {
            hookCalls += 1;
            if (hookCalls > 1) return;
            const updated = await updateSchedule({ db, clock }, "loop-1", { cron: "0 12 * * *" });
            expect(updated).toMatchObject({ found: true, changed: true });
          },
        },
      },
      loop!,
      { kind: "scheduled", scheduledFor: "2026-07-28T00:00:00.000Z", scheduleRevision: 0 },
    );

    expect(result).toEqual({ enqueued: false, reason: "stale_revision" });
    expect(hookCalls).toBe(2);
    const [updated] = await snapshotLoops(db);
    expect(updated).toMatchObject({ cron: "0 12 * * *", scheduleRevision: 1, lastScheduledAt: null });
    expect(await snapshotRuns(db)).toEqual([]);
  });
});

describe("G9 — Finish vs manual Run Now, reverse direction: the competing Run Now cannot commit", () => {
  it("returns running_exists while the finisher owns the live running phase, then Finish completes", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, goal: "finish-me", goalRevision: 0 });
    await seedRun(db, { id: "run-finisher", machineId, phase: "running" });
    await seedLease(db, {
      tokenHash: sha256("rk_reverse_finish"),
      runId: "run-finisher",
      machineId,
      canFinish: true,
      terminalProtocolVersion: 1,
      goalRevision: 0,
    });

    // Once Finish has resolved its live capability, its Run is necessarily
    // still running. The public Run Now path therefore cannot create the
    // requested "later enqueue commit" window: the authoritative in-tx
    // running probe refuses it before any Loop CAS or Run insert. Pin this
    // unreachable direction explicitly instead of manufacturing an invalid
    // state that the public state machine cannot produce.
    const [finishSnapshot] = await snapshotLoops(db);
    const enqueued = await coordinator.enqueueExecRun("loop-1");
    expect(enqueued).toEqual({ enqueued: false, reason: "running_exists" });
    const [afterRefusal] = await snapshotLoops(db);
    expect(afterRefusal!.revision).toBe(finishSnapshot!.revision);
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-finisher", phase: "running" }),
    ]);

    const ack = await coordinator.report("rk_reverse_finish", {
      ok: true,
      outcome: "exec",
      durationMs: 1,
      terminal: { kind: "finish", reason: "finish won" },
      taskFileSyncError: "missing",
    });

    expect(ack).toMatchObject({ ok: true });
    const [completed] = await snapshotLoops(db);
    expect(completed).toMatchObject({ completedAt: expect.any(String), completionReason: "finish won" });
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: "run-finisher", phase: "done", outcome: "exec" }),
    ]);
  });
});

describe("G10 — schedule PATCH vs scheduled callback, reverse window: PATCH resolved first and its stale CAS loses", () => {
  it("re-applies the PATCH from fresh state without overwriting the committed callback generation", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      cron: "* * * * *",
      scheduleRevision: 0,
      scheduleActivatedAt: "2026-07-27T23:59:00.000Z",
    });

    const [patchSnapshot] = await snapshotLoops(db);
    const callback = await coordinator.enqueueExecRun("loop-1", {
      kind: "scheduled",
      scheduledFor: "2026-07-28T00:00:00.000Z",
      scheduleRevision: 0,
    });
    expect(callback).toMatchObject({ enqueued: true });

    // This is updateSchedule's exact id+observed-revision guard. The real
    // callback bumped the unified revision, so the PATCH planned from the
    // frozen snapshot cannot overwrite its watermark/config state.
    const stalePatchCas = await db
      .update(loops)
      .set({
        cron: "0 12 * * *",
        scheduleRevision: patchSnapshot!.scheduleRevision + 1,
        lastScheduledAt: null,
        revision: sql`${loops.revision} + 1`,
      })
      .where(and(eq(loops.id, "loop-1"), eq(loops.revision, patchSnapshot!.revision)))
      .returning({ id: loops.id });
    expect(stalePatchCas).toEqual([]);

    const retried = await updateSchedule({ db, clock }, "loop-1", { cron: "0 12 * * *" });
    expect(retried).toMatchObject({ found: true, changed: true });
    const [updated] = await snapshotLoops(db);
    expect(updated).toMatchObject({
      cron: "0 12 * * *",
      scheduleRevision: 1,
      lastScheduledAt: null,
      revision: patchSnapshot!.revision + 2,
    });
    expect(await snapshotRuns(db)).toEqual([
      expect.objectContaining({ id: callback.enqueued ? callback.runId : "", phase: "pending" }),
    ]);
  });
});
