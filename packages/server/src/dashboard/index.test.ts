/**
 * D-group (Phase 4 Batch 3 Dashboard, slice 1): the read model and the page
 * model built from it.
 *
 * D1  empty list
 * D2  sort + 100-row cap, and the reads are bounded by the PAGE ids
 * D3  lifecycle combinations (ADR-009 决策 1 priority) with a late Run
 * D4  active state is read separately from `lastRun`, in batch, all roles
 * D5  sync warning / capability hint / no sensitive column in the projection
 *
 * The `D-group (Batch 3 Dashboard …)` prefix disambiguates these ids from the
 * D1–D6 in schedule/time-semantics.test.ts and D1–D8 in loop-lifecycle/.
 */
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import { createLoopAdmin, LOOP_LIST_CAP, type LoopAdmin } from "../admin/index.js";
import { FakeClock, seedLoop, seedRun } from "../testkit/index.js";
import { createDashboardRead, type DashboardRead, type DashboardSnapshot } from "./index.js";
import { buildDashboardPageModel, NONE_TEXT } from "./view.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let admin: LoopAdmin;
let read: DashboardRead;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  let n = 0;
  admin = createLoopAdmin({ db, clock, newLoopId: () => `loop-${++n}` });
  read = createDashboardRead({ admin, db, clock });
}

/** Machines with an explicit capability snapshot (testkit's seedMachine
 *  leaves `capabilities` at its null default). */
async function seedMachineCapabilities(id: string, capabilities: string[] | null): Promise<void> {
  await db.insert(machines).values({
    id,
    name: "",
    tokenHash: `hash-${id}`,
    capabilities,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
}

const iso = (seconds: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + seconds * 1000).toISOString();

const loopById = (snapshot: DashboardSnapshot, id: string) => {
  const found = snapshot.loops.find((l) => l.loop.id === id);
  if (found === undefined) throw new Error(`loop ${id} not in snapshot`);
  return found;
};

describe("D-group (Batch 3 Dashboard): read model and page model", () => {
  it("D1: an empty database yields an empty snapshot and the empty-list notice", async () => {
    await fresh();
    const snapshot = await read.snapshot();

    expect(snapshot.loops).toEqual([]);
    expect(snapshot.listCap).toBe(LOOP_LIST_CAP);
    expect(snapshot.generatedAt).toBe(clock.iso());

    const model = buildDashboardPageModel(snapshot);
    expect(model.emptyNotice).not.toBeNull();
    expect(model.loops).toEqual([]);
    expect(model.truncationNotice).toBeNull();
    expect(model.rangeNotice).toContain(String(LOOP_LIST_CAP));
  });

  it("D2: keeps updatedAt DESC / id ASC and truncates at the cap AFTER sorting", async () => {
    await fresh();
    // Same updatedAt: the id decides (ASC).
    await seedLoop(db, { id: "loop-b", updatedAt: iso(500) });
    await seedLoop(db, { id: "loop-a", updatedAt: iso(500) });
    for (let i = 0; i < LOOP_LIST_CAP - 2; i += 1) {
      await seedLoop(db, { id: `loop-${String(i).padStart(3, "0")}`, updatedAt: iso(i + 1) });
    }
    // Inserted LAST but sorts LAST — this is the row the cap must drop, and it
    // owns an active Run that must therefore never reach the page.
    await seedLoop(db, { id: "loop-oldest", updatedAt: iso(0) });
    await seedRun(db, { id: "run-offpage", loopId: "loop-oldest", phase: "running", ts: iso(1) });

    const snapshot = await read.snapshot();

    expect(snapshot.loops).toHaveLength(LOOP_LIST_CAP);
    expect(snapshot.loops[0]!.loop.id).toBe("loop-a");
    expect(snapshot.loops[1]!.loop.id).toBe("loop-b");
    expect(snapshot.loops.at(-1)!.loop.id).toBe("loop-000");
    expect(snapshot.loops.some((l) => l.loop.id === "loop-oldest")).toBe(false);
    // Every active-Run read is bounded by the page ids, not by history.
    expect(snapshot.loops.flatMap((l) => [...l.pending, ...l.running])).toEqual([]);

    const model = buildDashboardPageModel(snapshot);
    expect(model.truncationNotice).not.toBeNull();
    expect(model.rangeNotice).toContain(`当前 ${LOOP_LIST_CAP} 条`);
    expect(model.emptyNotice).toBeNull();
  });

  it("D3: classifies the lifecycle combinations, keeping a late Run visible", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-open", goal: null, enabled: true });
    await seedLoop(db, { id: "loop-closed", goal: "目标", enabled: true });
    await seedLoop(db, { id: "loop-paused-open", goal: null, enabled: false });
    await seedLoop(db, { id: "loop-paused-closed", goal: "目标", enabled: false });
    // Complete loops must satisfy the DB completion triple.
    await seedLoop(db, {
      id: "loop-completed",
      goal: "目标",
      completedAt: iso(40),
      completionReason: "已达成",
      enabled: false,
    });
    // A Run can still be running after completion (late Run) — lifecycle and
    // activity are two independent facts and must both be shown.
    await seedLoop(db, {
      id: "loop-completed-late",
      goal: "目标",
      completedAt: iso(40),
      completionReason: "已达成",
      enabled: false,
    });
    await seedRun(db, { id: "run-late", loopId: "loop-completed-late", phase: "running", ts: iso(41) });

    const snapshot = await read.snapshot();

    expect(loopById(snapshot, "loop-open").lifecycle).toBe("open");
    expect(loopById(snapshot, "loop-closed").lifecycle).toBe("closed");
    expect(loopById(snapshot, "loop-paused-open").lifecycle).toBe("paused");
    expect(loopById(snapshot, "loop-paused-closed").lifecycle).toBe("paused");
    // Completed outranks Paused (ADR-009 决策 1).
    expect(loopById(snapshot, "loop-completed").lifecycle).toBe("completed");
    expect(loopById(snapshot, "loop-completed-late").lifecycle).toBe("completed");
    expect(loopById(snapshot, "loop-completed-late").running.map((r) => r.id)).toEqual(["run-late"]);

    const model = buildDashboardPageModel(snapshot);
    const byId = new Map(model.loops.map((c) => [c.id, c]));
    expect(byId.get("loop-open")!.lifecycleLabel).toBe("Open");
    expect(byId.get("loop-closed")!.lifecycleLabel).toBe("Closed");
    expect(byId.get("loop-paused-closed")!.lifecycleLabel).toBe("Paused");
    expect(byId.get("loop-completed")!.lifecycleLabel).toBe("Completed");
    // The goal dimension stays independently readable.
    expect(byId.get("loop-paused-closed")!.typeLabel).toBe("Closed");
    expect(byId.get("loop-paused-open")!.typeLabel).toBe("Open");
    expect(byId.get("loop-open")!.goalLabel).toBe(NONE_TEXT);
    expect(byId.get("loop-completed-late")!.completionReasonLabel).toBe("已达成");
    // A completed loop with a late Run shows BOTH facts, not one instead of the other.
    expect(byId.get("loop-completed-late")!.lifecycleLabel).toBe("Completed");
    expect(byId.get("loop-completed-late")!.running).toHaveLength(1);
  });

  it("D4: reads active state separately from lastRun, in one batch across all roles", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1" });
    // Latest EXEC run is already finished…
    await seedRun(db, { id: "run-newer", loopId: "loop-1", role: "exec", phase: "done", ts: iso(30), status: "resolved" });
    // …while an OLDER exec run is still running. It can never appear in
    // `lastRun`, so inferring activity from `lastRun` would silently hide it.
    await seedRun(db, {
      id: "run-older",
      loopId: "loop-1",
      role: "exec",
      phase: "running",
      ts: iso(10),
      progress: { step: 2, label: "editing", at: iso(11) },
    });
    // Non-exec roles are covered too.
    await seedRun(db, { id: "run-evolve", loopId: "loop-1", role: "evolve", phase: "running", ts: iso(20) });

    // A second loop with pending and running coexisting.
    await seedLoop(db, { id: "loop-2" });
    await seedRun(db, {
      id: "run-pending",
      loopId: "loop-2",
      phase: "pending",
      ts: iso(1),
      // The persisted row may predate the `at` stamp — the shared mapper must
      // normalize it to an explicit null.
      progress: { step: 1, label: "queued" },
    });
    await seedRun(db, { id: "run-running", loopId: "loop-2", phase: "running", ts: iso(2) });

    const snapshot = await read.snapshot();
    const one = loopById(snapshot, "loop-1");
    const two = loopById(snapshot, "loop-2");

    expect(one.loop.lastRun?.id).toBe("run-newer");
    expect(one.pending).toEqual([]);
    expect(one.running.map((r) => r.id)).toEqual(["run-evolve", "run-older"]);
    expect(one.running.map((r) => r.role)).toEqual(["evolve", "exec"]);
    expect(one.running.find((r) => r.id === "run-older")!.progress).toEqual({
      step: 2,
      label: "editing",
      at: iso(11),
    });

    // `lastRun` is the latest EXEC run in ANY phase — here the running one. It
    // still cannot stand in for activity: the pending run below is invisible to
    // it, which is exactly why the page reads active state separately.
    expect(two.loop.lastRun?.id).toBe("run-running");
    expect(two.pending.map((r) => r.id)).toEqual(["run-pending"]);
    expect(two.running.map((r) => r.id)).toEqual(["run-running"]);
    expect(two.pending[0]!.progress).toEqual({ step: 1, label: "queued", at: null });
  });

  it("D5: sync warnings, capability hint, and no sensitive column in the projection", async () => {
    await fresh();
    await seedMachineCapabilities("m-capable", ["terminal-journal-v1"]);
    await seedMachineCapabilities("m-other", ["something-else"]);
    await seedMachineCapabilities("m-empty", null);

    await seedLoop(db, { id: "loop-capable", machineId: "m-capable" });
    await seedLoop(db, { id: "loop-other", machineId: "m-other" });
    await seedLoop(db, { id: "loop-empty", machineId: "m-empty" });
    // No machine row at all — must fail safe to the same hint.
    await seedLoop(db, { id: "loop-no-machine", machineId: "m-absent" });

    // A failed sync: the attempt stamp IS the failure time while an error is set.
    await seedLoop(db, {
      id: "loop-sync-failed",
      machineId: "m-capable",
      taskFile: "/tmp/task.md",
      taskFileSyncedAt: iso(1),
      taskFileSyncAttemptedAt: iso(9),
      taskFileSyncError: "too_large",
    });
    // Never synced.
    await seedLoop(db, { id: "loop-never-synced", machineId: "m-capable" });
    // A SUCCESSFUL attempt also advances attemptedAt — with no error it is not
    // a failure time and must not be shown as one.
    await seedLoop(db, {
      id: "loop-synced-ok",
      machineId: "m-capable",
      taskFileSyncedAt: iso(3),
      taskFileSyncAttemptedAt: iso(3),
      taskFileSyncError: null,
    });

    // Scheduled loop: nextFireAt is inherited from the existing computation.
    await seedLoop(db, { id: "loop-scheduled", machineId: "m-capable", cron: "0 0 * * *", timezone: "UTC" });

    // Sentinels in every column the Dashboard must never touch.
    await seedLoop(db, {
      id: "loop-secrets",
      machineId: "m-capable",
      state: { cursor: "loop-state-secret" },
      workflow: "loop-workflow-secret",
      model: "loop-model-secret",
      taskFileContent: "loop-task-file-content-secret",
    });
    // This same row is deliberately both the latest EXEC Run and an active
    // Run, so the sentinels exercise BOTH Dashboard read paths.
    await seedRun(db, {
      id: "run-active-secrets",
      loopId: "loop-secrets",
      phase: "running",
      ts: iso(6),
      state: { a: "run-state-secret" },
      sessionId: "run-session-secret",
      costUsd: 987654.321,
      usage: { inputTokens: 999991, outputTokens: 999992 },
      artifacts: [{ path: "run-artifact-secret", kind: "created" }],
      transcript: [{ kind: "text", text: "run-transcript-secret" }],
    });

    const snapshot = await read.snapshot();
    const model = buildDashboardPageModel(snapshot);

    // The Run holding all sentinels was selected by both reads above: latest
    // EXEC Run and the all-role active-Run batch. The leak assertions below
    // therefore fail if either projection grows a sensitive column.
    const secretLoop = loopById(snapshot, "loop-secrets");
    expect(secretLoop.loop.lastRun?.id).toBe("run-active-secrets");
    expect(secretLoop.running.map((run) => run.id)).toEqual(["run-active-secrets"]);

    expect(loopById(snapshot, "loop-capable").terminalJournalV1).toBe(true);
    expect(loopById(snapshot, "loop-other").terminalJournalV1).toBe(false);
    expect(loopById(snapshot, "loop-empty").terminalJournalV1).toBe(false);
    expect(loopById(snapshot, "loop-no-machine").terminalJournalV1).toBe(false);

    const cards = new Map(model.loops.map((c) => [c.id, c]));
    expect(cards.get("loop-capable")!.capabilityWarning).toBeNull();
    expect(cards.get("loop-other")!.capabilityWarning).not.toBeNull();
    expect(cards.get("loop-empty")!.capabilityWarning).not.toBeNull();
    expect(cards.get("loop-no-machine")!.capabilityWarning).not.toBeNull();

    const failed = cards.get("loop-sync-failed")!;
    expect(failed.taskFilePathLabel).toBe("/tmp/task.md");
    expect(failed.taskFileSyncedAtLabel).toContain("2026-07-01 00:00:01 UTC");
    expect(failed.taskFileFailedAtLabel).toContain("2026-07-01 00:00:09 UTC");
    expect(failed.taskFileErrorLabel).toContain("too_large");

    const never = cards.get("loop-never-synced")!;
    expect(never.taskFileSyncedAtLabel).toBe("从未成功同步");
    expect(never.taskFileFailedAtLabel).toBe(NONE_TEXT);
    expect(never.taskFileErrorLabel).toBeNull();

    const ok = cards.get("loop-synced-ok")!;
    expect(ok.taskFileSyncedAtLabel).toContain("2026-07-01 00:00:03 UTC");
    expect(ok.taskFileFailedAtLabel).toBe(NONE_TEXT);
    expect(ok.taskFileErrorLabel).toBeNull();

    expect(cards.get("loop-scheduled")!.nextFireAtLabel).toContain("2026-07-30 00:00:00 UTC");

    // No sensitive column reaches the model — or the serialized snapshot.
    const serialized = JSON.stringify(snapshot);
    for (const leak of [
      "loop-state-secret",
      "loop-workflow-secret",
      "loop-model-secret",
      "loop-task-file-content-secret",
      "run-state-secret",
      "run-session-secret",
      "987654.321",
      "999991",
      "999992",
      "run-artifact-secret",
      "run-transcript-secret",
      "hash-m-capable",
    ]) {
      expect(serialized).not.toContain(leak);
      expect(JSON.stringify(model)).not.toContain(leak);
    }
    // The capability read is a two-column projection by construction.
    expect(Object.keys(snapshot.loops[0]!.loop).sort()).toEqual(
      [
        "agent",
        "allowControl",
        "completedAt",
        "completionReason",
        "createdAt",
        "cron",
        "enabled",
        "goal",
        "id",
        "lastRun",
        "machineId",
        "name",
        "nextFireAt",
        "taskFile",
        "taskFileSyncAttemptedAt",
        "taskFileSyncError",
        "taskFileSyncedAt",
        "timezone",
        "updatedAt",
        "workdir",
      ].sort(),
    );
  });
});
