/**
 * Artifact snapshot binding — pure plan matrix + guarded persistence
 * (ADR-010 决策 12, plan §3 "Run 快照边界"; slice 2 AM4 关联约束 evidence).
 *
 *  plan (pure):   the fixed evaluation order (skip → skip-on-phase →
 *                 snapshot_not_committed → cross_namespace → cross_machine →
 *                 cross_loop → stale_config_generation → bind); the write
 *                 shapes are exactly the artifact columns, never the run's
 *                 outcome.
 *  persistence:   bind / record_error / skip against the real PGlite, the
 *                 phase-guarded CAS write, and the transaction-handle
 *                 acceptance Batch 2 will use to embed the plan in the
 *                 report transaction.
 *
 * Nothing here wires into the production report path (决策 16).
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import {
  artifactManifests,
  loops,
  machines,
  runs,
  type ArtifactManifestRow,
  type Loop,
  type Run,
} from "../db/schema.js";
import {
  applyArtifactBindingPlan,
  ArtifactBindingGuardLostError,
  planArtifactSnapshotBinding,
  type ArtifactBindingInput,
} from "./binding-plan.js";

const NOW = "2026-09-28T00:00:00.000Z";
const HASH = "a".repeat(64);

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    loopId: "loop-1",
    machineId: "m-1",
    phase: "running",
    role: "exec",
    ts: NOW,
    outcome: null,
    status: null,
    message: null,
    durationMs: null,
    error: null,
    state: null,
    sessionId: null,
    costUsd: null,
    usage: null,
    artifacts: null,
    transcript: null,
    progress: null,
    artifactSnapshotId: null,
    artifactSyncError: null,
    ...overrides,
  };
}

function baseLoop(overrides: Partial<Pick<Loop, "id" | "machineId" | "artifactConfigRevision">> = {}) {
  return { id: "loop-1", machineId: "m-1", artifactConfigRevision: 2, ...overrides };
}

function baseManifest(overrides: Partial<ArtifactManifestRow> = {}): ArtifactManifestRow {
  return {
    id: "amf-1",
    namespaceId: "ns-1",
    machineId: "m-1",
    loopId: "loop-1",
    configRevision: 2,
    manifestRevision: 1,
    entries: [{ path: "dist/app.js", hash: HASH, size: 1200 }],
    fileCount: 1,
    totalBytes: 1200,
    committedAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<ArtifactBindingInput> = {}): ArtifactBindingInput {
  return {
    run: baseRun(),
    loop: baseLoop(),
    manifest: baseManifest(),
    snapshotId: "amf-1",
    attribution: { namespaceId: "ns-1", machineId: "m-1" },
    ...overrides,
  };
}

describe("plan (pure): the fixed evaluation order", () => {
  it("no snapshotId in the report → skip (zero writes)", () => {
    expect(planArtifactSnapshotBinding(input({ snapshotId: undefined }))).toEqual({ kind: "skip" });
  });

  it("a non-running run never binds — canceled/error/done/pending all skip", () => {
    for (const phase of ["canceled", "error", "done", "pending"] as const) {
      expect(planArtifactSnapshotBinding(input({ run: baseRun({ phase }) }))).toEqual({ kind: "skip" });
    }
  });

  it("an unknown snapshot id → record_error/snapshot_not_committed", () => {
    const plan = planArtifactSnapshotBinding(input({ manifest: null, snapshotId: "amf-ghost" }));
    expect(plan).toEqual({
      kind: "record_error",
      reason: "snapshot_not_committed",
      runWrites: { artifactSnapshotId: null, artifactSyncError: "snapshot_not_committed" },
    });
  });

  it("a manifest row whose id is NOT the referenced snapshot id is snapshot_not_committed — never bind an unverified id (#69)", () => {
    // Everything else about the manifest is consistent (namespace / machine /
    // loop / generation) — only the presented row is not the referenced id.
    const plan = planArtifactSnapshotBinding(input({ snapshotId: "amf-ghost" }));
    expect(plan).toEqual({
      kind: "record_error",
      reason: "snapshot_not_committed",
      runWrites: { artifactSnapshotId: null, artifactSyncError: "snapshot_not_committed" },
    });
  });

  it("cross-resource references reject with their own literal (AM4 关联约束)", () => {
    expect(planArtifactSnapshotBinding(input({ manifest: baseManifest({ namespaceId: "ns-2" }) }))).toMatchObject({
      kind: "record_error",
      reason: "cross_namespace",
    });
    expect(planArtifactSnapshotBinding(input({ manifest: baseManifest({ machineId: "m-2" }) }))).toMatchObject({
      kind: "record_error",
      reason: "cross_machine",
    });
    expect(planArtifactSnapshotBinding(input({ manifest: baseManifest({ loopId: "loop-2" }) }))).toMatchObject({
      kind: "record_error",
      reason: "cross_loop",
    });
    // A manifest committed under an older config generation never binds
    // (决策 8 staleness at bind time).
    expect(planArtifactSnapshotBinding(input({ manifest: baseManifest({ configRevision: 1 }) }))).toMatchObject({
      kind: "record_error",
      reason: "stale_config_generation",
    });
    // Caller corruption (loop row ≠ run.loopId) is cross_loop, never a bind.
    expect(planArtifactSnapshotBinding(input({ loop: baseLoop({ id: "loop-9" }) }))).toMatchObject({
      kind: "record_error",
      reason: "cross_loop",
    });
  });

  it("the loop's machine is part of the attribution chain — a mismatched loop.machineId rejects cross_machine (#70)", () => {
    // Manifest, run and attribution all agree on m-1; ONLY the loop row
    // points elsewhere. Pre-fix this fell through to bind.
    expect(planArtifactSnapshotBinding(input({ loop: baseLoop({ machineId: "m-9" }) }))).toMatchObject({
      kind: "record_error",
      reason: "cross_machine",
    });
  });

  it("a fully consistent reference binds — runWrites is EXACTLY the artifact column", () => {
    const plan = planArtifactSnapshotBinding(input());
    expect(plan).toEqual({ kind: "bind", runWrites: { artifactSnapshotId: "amf-1" } });
    if (plan.kind === "bind") expect(Object.keys(plan.runWrites)).toEqual(["artifactSnapshotId"]);
  });

  it("record_error runWrites contain ONLY the two artifact columns — never the run outcome", () => {
    const plan = planArtifactSnapshotBinding(input({ manifest: null }));
    if (plan.kind !== "record_error") throw new Error("unreachable");
    expect(Object.keys(plan.runWrites).sort()).toEqual(["artifactSnapshotId", "artifactSyncError"]);
  });
});

describe("persistence (real PGlite)", () => {
  const handles: DbHandle[] = [];
  let db: Db;

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  });

  async function fresh(): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    await db.insert(machines).values({ id: "m-1", name: "", tokenHash: "deadbeef", createdAt: NOW });
    await db.insert(loops).values({ id: "loop-1", machineId: "m-1", createdAt: NOW, updatedAt: NOW });
    await db.insert(loops).values({ id: "loop-2", machineId: "m-2", createdAt: NOW, updatedAt: NOW });
    await db.insert(runs).values(baseRun({ outcome: "exec", message: "wrapped up" }));
  }

  async function getRun(): Promise<Run> {
    return (await db.select().from(runs).where(eq(runs.id, "run-1")))[0]!;
  }

  it("bind lands the snapshot id and leaves every other run column item-equal", async () => {
    await fresh();
    await db.insert(artifactManifests).values(baseManifest());
    const before = await getRun();

    const plan = planArtifactSnapshotBinding(input({ run: before }));
    await applyArtifactBindingPlan(db, before, plan);

    const after = await getRun();
    expect(after.artifactSnapshotId).toBe("amf-1");
    expect({ ...after, artifactSnapshotId: null }).toEqual(before);
  });

  it("record_error lands the stable literal and NEVER touches the run outcome", async () => {
    await fresh();
    const before = await getRun();

    const plan = planArtifactSnapshotBinding(input({ run: before, manifest: null, snapshotId: "amf-ghost" }));
    await applyArtifactBindingPlan(db, before, plan);

    const after = await getRun();
    expect(after.artifactSnapshotId).toBeNull();
    expect(after.artifactSyncError).toBe("snapshot_not_committed");
    // Outcome-bearing columns are untouched (非法引用不改变合法 Run 执行结果).
    expect([after.phase, after.outcome, after.status, after.message, after.durationMs]).toEqual([
      before.phase,
      before.outcome,
      before.status,
      before.message,
      before.durationMs,
    ]);
  });

  it("skip performs zero writes (canceled/superseded runs stay item-equal)", async () => {
    await fresh();
    await db.update(runs).set({ phase: "canceled", outcome: "silent" }).where(eq(runs.id, "run-1"));
    const before = await getRun();

    const plan = planArtifactSnapshotBinding(input({ run: before }));
    expect(plan).toEqual({ kind: "skip" });
    await applyArtifactBindingPlan(db, before, plan);
    expect(await getRun()).toEqual(before);
  });

  it("AM4 关联约束: a manifest owned by another loop/machine/namespace records an error, never binds", async () => {
    await fresh();
    const before = await getRun();
    for (const [id, manifestRevision, mismatch] of [
      ["amf-other-loop", 1, { loopId: "loop-2" }],
      ["amf-other-machine", 2, { machineId: "m-2" }],
      ["amf-other-namespace", 3, { namespaceId: "ns-2" }],
    ] as const) {
      // Distinct manifestRevision per row — (loopId, manifestRevision) is
      // unique (AM4), so three manifests for loop-1 need three revisions.
      await db.insert(artifactManifests).values(baseManifest({ id, manifestRevision, ...mismatch }));
      // The manifest input IS the caller's DB lookup of the referenced id —
      // run the real read path rather than handing the planner a fixture.
      const found = (await db.select().from(artifactManifests).where(eq(artifactManifests.id, id)))[0]!;
      const plan = planArtifactSnapshotBinding(input({ run: before, snapshotId: id, manifest: found }));
      expect(plan.kind).toBe("record_error");
      await applyArtifactBindingPlan(db, before, plan);
      const after = await getRun();
      expect(after.artifactSnapshotId).toBeNull();
      expect(after.artifactSyncError).toBe((plan as { reason: string }).reason);
    }
  });

  it("a committed manifest does not launder a DIFFERENT referenced id — the run records snapshot_not_committed, never binds (#69)", async () => {
    await fresh();
    await db.insert(artifactManifests).values(baseManifest());
    const before = await getRun();
    // The manifest input IS the caller's real lookup row (id "amf-1"); the
    // report references a DIFFERENT id — without the id check this plan
    // would bind "amf-ghost" against a fully consistent "amf-1" row.
    const found = (await db.select().from(artifactManifests).where(eq(artifactManifests.id, "amf-1")))[0]!;
    const plan = planArtifactSnapshotBinding(input({ run: before, snapshotId: "amf-ghost", manifest: found }));
    expect(plan).toMatchObject({ kind: "record_error", reason: "snapshot_not_committed" });
    await applyArtifactBindingPlan(db, before, plan);
    const after = await getRun();
    expect(after.artifactSnapshotId).toBeNull();
    expect(after.artifactSyncError).toBe("snapshot_not_committed");
    expect(after.outcome).toBe(before.outcome);
  });

  it("a loop whose machineId breaks the attribution chain records cross_machine, never binds (#70)", async () => {
    await fresh();
    await db.insert(artifactManifests).values(baseManifest());
    // The loop row itself points at another machine (no-FK: the chain is
    // re-verified at bind time, never assumed) — resolve the REAL row.
    await db.update(loops).set({ machineId: "m-9" }).where(eq(loops.id, "loop-1"));
    const before = await getRun();
    const loopRow = (await db.select().from(loops).where(eq(loops.id, "loop-1")))[0]!;
    const found = (await db.select().from(artifactManifests).where(eq(artifactManifests.id, "amf-1")))[0]!;
    const plan = planArtifactSnapshotBinding(input({ run: before, loop: loopRow, manifest: found }));
    expect(plan).toMatchObject({ kind: "record_error", reason: "cross_machine" });
    await applyArtifactBindingPlan(db, before, plan);
    const after = await getRun();
    expect(after.artifactSnapshotId).toBeNull();
    expect(after.artifactSyncError).toBe("cross_machine");
  });

  it("a moved phase between resolve and apply throws ArtifactBindingGuardLostError and writes nothing", async () => {
    await fresh();
    await db.insert(artifactManifests).values(baseManifest());
    const before = await getRun();
    const plan = planArtifactSnapshotBinding(input({ run: before }));

    // The run finalized between the caller's resolve and the apply.
    await db.update(runs).set({ phase: "done" }).where(eq(runs.id, "run-1"));

    await expect(applyArtifactBindingPlan(db, before, plan)).rejects.toBeInstanceOf(ArtifactBindingGuardLostError);
    const after = await getRun();
    expect(after.artifactSnapshotId).toBeNull();
    expect(after.phase).toBe("done");
  });

  it("the plan applies inside a caller-owned transaction (the Batch 2 report-tx seam)", async () => {
    await fresh();
    await db.insert(artifactManifests).values(baseManifest());
    const before = await getRun();
    const plan = planArtifactSnapshotBinding(input({ run: before }));

    await db.transaction(async (tx) => {
      await applyArtifactBindingPlan(tx, before, plan);
    });
    expect((await getRun()).artifactSnapshotId).toBe("amf-1");

    // …and a throw rolls the whole transaction back: the record_error plan
    // applied below lands inside the tx, then vanishes with it — the row
    // keeps exactly the first transaction's state.
    const errorPlan = planArtifactSnapshotBinding(input({ run: before, manifest: null, snapshotId: "amf-ghost" }));
    await expect(
      db.transaction(async (tx) => {
        await applyArtifactBindingPlan(tx, before, errorPlan);
        throw new Error("injected post-bind failure");
      }),
    ).rejects.toThrow("injected post-bind failure");
    const after = await getRun();
    expect(after.artifactSnapshotId).toBe("amf-1");
    expect(after.artifactSyncError).toBeNull();
  });
});
