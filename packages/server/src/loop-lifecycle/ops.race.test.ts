/**
 * Lifecycle-ops race pins (review SPEC-1/ADV-3/SPEC-3, ADR-009 修订
 * 2026-09-01): the unified `revision` OCC token under DETERMINISTIC
 * interleaving. Single-connection PGlite cannot interleave a competitor
 * inside a transaction, so each case resolves, then commits a REAL competing
 * transaction from the TEST-ONLY `afterResolve` hook (the resolve/write
 * window), then lands the guarded write.
 *
 *  R1 (SPEC-1/ADV-3) retarget vs claim: a claim committed mid-window (its
 *     revision bump) loses the retarget's guard; the re-resolve sees the
 *     running run — final answer 409-conflict, old path + snapshot
 *     untouched. The old-generation delivery can never sync into the new
 *     path's snapshot.
 *  R2 (opposite order) retarget commits BEFORE the claim: the claim's
 *     in-transaction loop re-read carries the NEW task file — the Delivery
 *     belongs to the new path.
 *  R3 (SPEC-3) two retargets on a FROZEN clock (identical updatedAt — the
 *     exact case the millisecond guard could not see): the stale write loses
 *     the revision guard, re-resolves, lands once; revision advanced exactly
 *     per effective write.
 *  R4 reopen vs retarget: both land, neither clobbers the other, revision
 *     advanced exactly twice.
 */
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { claimRunWithLeaseTx } from "../store/runs.js";
import {
  FakeClock,
  seedLoop,
  seedRun,
  snapshotLeases,
  snapshotLoops,
  snapshotRuns,
  testDeps,
} from "../testkit/index.js";
import { reopenLoop, updateTaskFile, type LifecycleOpsDeps } from "./ops.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock(); // FROZEN — every write shares one updatedAt
}

function depsWith(hooks: LifecycleOpsDeps["hooks"]): LifecycleOpsDeps {
  return { db, clock, hooks };
}

describe("R1 — retarget vs claim (SPEC-1/ADV-3): the interleaved claim wins the guard", () => {
  it("a claim committed mid-window turns the retarget into run_in_progress with zero retarget writes", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", taskFile: "/machine/A.md", taskFileContent: "old snapshot" });
    await seedRun(db, { id: "run-1", phase: "pending" });

    let hookCalls = 0;
    const result = await updateTaskFile(
      depsWith({
        afterResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return; // the retry re-resolves AFTER the claim
          // Commit a REAL claim in the resolve/write window.
          const claimed = await claimRunWithLeaseTx(testDeps(db, clock), {
            runId: "run-1",
            loopId: "loop-1",
            machineId: "m-test",
            role: "exec",
          });
          expect(claimed).toBeDefined();
        },
      }),
      "loop-1",
      "/machine/B.md",
    );

    expect(result).toEqual({ found: true, kind: "conflict", reason: "run_in_progress" });
    const [loop] = await snapshotLoops(db);
    // The retarget never wrote: old path + old snapshot survive; revision
    // advanced EXACTLY once — the claim's bump.
    expect(loop).toMatchObject({
      taskFile: "/machine/A.md",
      taskFileContent: "old snapshot",
      revision: 1,
    });
    const [run] = await snapshotRuns(db);
    expect(run).toMatchObject({ id: "run-1", phase: "running" });
    expect(await snapshotLeases(db)).toHaveLength(1);
  });
});

describe("R2 — retarget before claim: the delivery carries the NEW path", () => {
  it("claim re-reads the loop after the committed retarget", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", taskFile: "/machine/A.md" });
    await seedRun(db, { id: "run-1", phase: "pending" });

    const retarget = await updateTaskFile(depsWith(undefined), "loop-1", "/machine/B.md");
    expect(retarget).toMatchObject({ found: true, kind: "changed" });

    const claimed = await claimRunWithLeaseTx(testDeps(db, clock), {
      runId: "run-1",
      loopId: "loop-1",
      machineId: "m-test",
      role: "exec",
    });
    expect(claimed?.loop.taskFile).toBe("/machine/B.md");
    const [loop] = await snapshotLoops(db);
    expect(loop!.revision).toBe(2); // retarget + claim bump
  });

  it("a retarget committed after claim resolve makes claim retry and deliver only the NEW path", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", taskFile: "/machine/A.md" });
    await seedRun(db, { id: "run-1", phase: "pending" });

    let hookCalls = 0;
    const claimed = await claimRunWithLeaseTx(
      {
        ...testDeps(db, clock),
        hooks: {
          afterClaimLoopResolve: async () => {
            hookCalls += 1;
            if (hookCalls > 1) return;
            const retarget = await updateTaskFile(depsWith(undefined), "loop-1", "/machine/B.md");
            expect(retarget).toMatchObject({ found: true, kind: "changed" });
          },
        },
      },
      {
        runId: "run-1",
        loopId: "loop-1",
        machineId: "m-test",
        role: "exec",
      },
    );

    expect(hookCalls).toBe(2);
    expect(claimed?.loop.taskFile).toBe("/machine/B.md");
    const [loop] = await snapshotLoops(db);
    expect(loop).toMatchObject({ taskFile: "/machine/B.md", revision: 2 });
    const [run] = await snapshotRuns(db);
    expect(run).toMatchObject({ id: "run-1", phase: "running" });
    expect(await snapshotLeases(db)).toHaveLength(1);
  });
});

describe("R3 — SPEC-3: same-timestamp competing writes cannot silently overwrite", () => {
  it("a stale retarget loses the revision guard under a FROZEN clock, re-resolves, lands once", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", taskFile: "/machine/A.md" });

    let hookCalls = 0;
    const result = await updateTaskFile(
      depsWith({
        afterResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return; // fire only on the FIRST (doomed) attempt
          // A competing retarget resolves on the SAME revision and commits —
          // under the frozen clock its updatedAt is byte-identical, so the
          // old updatedAt guard would have passed. The revision guard loses.
          const inner = await updateTaskFile(depsWith(undefined), "loop-1", "/machine/B.md");
          expect(inner).toMatchObject({ found: true, kind: "changed" });
        },
      }),
      "loop-1",
      "/machine/C.md",
    );

    expect(result).toMatchObject({ found: true, kind: "changed" });
    expect(hookCalls).toBe(2); // the lost guard forced exactly one re-resolve
    const [loop] = await snapshotLoops(db);
    expect(loop).toMatchObject({ taskFile: "/machine/C.md", revision: 2 });
  });
});

describe("R4 — reopen vs retarget: both land, neither clobbers the other", () => {
  it("a retarget committed mid-reopen-window loses the reopen's first guard; the retry preserves both effects", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      goal: "g",
      completedAt: "2026-07-28T00:00:00.000Z",
      completionReason: "done",
      enabled: false,
      taskFile: "/machine/A.md",
    });

    let hookCalls = 0;
    const result = await reopenLoop(
      depsWith({
        afterResolve: async () => {
          hookCalls += 1;
          if (hookCalls > 1) return;
          const inner = await updateTaskFile(depsWith(undefined), "loop-1", "/machine/B.md");
          expect(inner).toMatchObject({ found: true, kind: "changed" });
        },
      }),
      "loop-1",
    );

    expect(result).toMatchObject({ found: true, kind: "changed" });
    const [loop] = await snapshotLoops(db);
    // Reopen landed (completion cleared, re-enabled) AND the retarget's
    // taskFile survived — revision advanced exactly twice.
    expect(loop).toMatchObject({
      completedAt: null,
      completionReason: null,
      enabled: true,
      taskFile: "/machine/B.md",
      revision: 2,
    });
  });
});
