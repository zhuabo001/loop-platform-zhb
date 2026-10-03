/**
 * AM6/AM4-revision — the artifact config transaction (ADR-010 决策 8).
 *
 *  plan (pure):   the fixed evaluation order validate → noop → exhaustion;
 *                 the server-side path policy (relative requires a workdir);
 *                 the sync-attempt triple clears, the manifest pointer NEVER
 *                 enters the patch.
 *  transaction:   the guarded write on the real PGlite — changed lands with
 *                 revision+1, noop/rejected write NOTHING, loop_not_found,
 *                 stale-view computation, and the CAS-level old-generation
 *                 evidence (a competitor that commits between resolve and
 *                 write can never be silently overwritten).
 *
 * AM6's session-generation half (a stale-generation prepare/commit rejects)
 * is slice 4 evidence (AC8/AC5) — this file deliberately tests only the
 * config-CAS half.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactManifests, loops, machines, type Loop } from "../db/schema.js";
import { REVISION_INT32_MAX } from "../schedule/transition.js";
import { FakeClock } from "../testkit/index.js";
import {
  ArtifactConfigRaceLostError,
  planArtifactConfigUpdate,
  readCurrentArtifactView,
  updateArtifactConfig,
  type ArtifactConfigSnapshot,
} from "./config.js";

const NOW = "2026-09-28T00:00:00.000Z";

function snap(overrides: Partial<ArtifactConfigSnapshot> = {}): ArtifactConfigSnapshot {
  return { artifactDir: null, artifactConfigRevision: 0, workdir: "/home/user/project", ...overrides };
}

describe("plan (pure): fixed evaluation order validate → noop → exhaustion", () => {
  it("set on an unconfigured loop → changed, generation 0→1, sync triple nulled", () => {
    const plan = planArtifactConfigUpdate(snap(), { artifactDir: "/data/out" }, NOW);
    expect(plan).toEqual({
      kind: "changed",
      writes: {
        artifactDir: "/data/out",
        artifactConfigRevision: 1,
        artifactSyncAttemptedAt: null,
        artifactSyncSucceededAt: null,
        artifactSyncError: null,
        updatedAt: NOW,
      },
    });
    // The manifest pointer NEVER enters the patch (决策 8: 保留旧 manifest 指针).
    if (plan.kind === "changed") {
      expect(Object.keys(plan.writes).sort()).toEqual([
        "artifactConfigRevision",
        "artifactDir",
        "artifactSyncAttemptedAt",
        "artifactSyncError",
        "artifactSyncSucceededAt",
        "updatedAt",
      ]);
    }
  });

  it("equal value (including null===null) → noop", () => {
    expect(planArtifactConfigUpdate(snap({ artifactDir: "/data" }), { artifactDir: "/data" }, NOW)).toEqual({
      kind: "noop",
    });
    expect(planArtifactConfigUpdate(snap(), { artifactDir: null }, NOW)).toEqual({ kind: "noop" });
  });

  it("change and clear → changed with the generation incremented", () => {
    const changed = planArtifactConfigUpdate(
      snap({ artifactDir: "/a", artifactConfigRevision: 3 }),
      { artifactDir: "/b" },
      NOW,
    );
    expect(changed).toMatchObject({ kind: "changed", writes: { artifactDir: "/b", artifactConfigRevision: 4 } });
    const cleared = planArtifactConfigUpdate(
      snap({ artifactDir: "/a", artifactConfigRevision: 3 }),
      { artifactDir: null },
      NOW,
    );
    expect(cleared).toMatchObject({ kind: "changed", writes: { artifactDir: null, artifactConfigRevision: 4 } });
  });

  it("rejects empty and NUL-containing dirs (artifact_dir_invalid)", () => {
    expect(planArtifactConfigUpdate(snap(), { artifactDir: "" }, NOW)).toEqual({
      kind: "rejected",
      reason: "artifact_dir_invalid",
    });
    expect(planArtifactConfigUpdate(snap(), { artifactDir: "a\0b" }, NOW)).toEqual({
      kind: "rejected",
      reason: "artifact_dir_invalid",
    });
  });

  it("a relative dir requires a workdir; absolute never does (决策 8 server-side policy)", () => {
    expect(planArtifactConfigUpdate(snap({ workdir: null }), { artifactDir: "rel/path" }, NOW)).toEqual({
      kind: "rejected",
      reason: "artifact_dir_relative_without_workdir",
    });
    expect(planArtifactConfigUpdate(snap(), { artifactDir: "rel/path" }, NOW)).toMatchObject({ kind: "changed" });
    expect(planArtifactConfigUpdate(snap({ workdir: null }), { artifactDir: "/abs" }, NOW)).toMatchObject({
      kind: "changed",
    });
  });

  it("validate precedes noop: an invalid value rejects even when it equals the stored one", () => {
    // A degenerate stored value can never launder an invalid command into a noop.
    expect(planArtifactConfigUpdate(snap({ artifactDir: "" }), { artifactDir: "" }, NOW)).toEqual({
      kind: "rejected",
      reason: "artifact_dir_invalid",
    });
  });

  it("noop precedes exhaustion: an equal-value command at the int32 ceiling still writes nothing", () => {
    expect(
      planArtifactConfigUpdate(
        snap({ artifactDir: "/data", artifactConfigRevision: REVISION_INT32_MAX }),
        { artifactDir: "/data" },
        NOW,
      ),
    ).toEqual({ kind: "noop" });
  });

  it("an effective change at the int32 ceiling is a stable rejection (config_revision_exhausted)", () => {
    expect(
      planArtifactConfigUpdate(
        snap({ artifactDir: "/data", artifactConfigRevision: REVISION_INT32_MAX }),
        { artifactDir: "/other" },
        NOW,
      ),
    ).toEqual({ kind: "rejected", reason: "config_revision_exhausted" });
  });
});

describe("transaction (real PGlite)", () => {
  const handles: DbHandle[] = [];
  let db: Db;
  let clock: FakeClock;

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  });

  async function fresh(): Promise<void> {
    const h = await openMigratedDb();
    handles.push(h);
    db = h.db;
    clock = new FakeClock();
    await db.insert(machines).values({ id: "m-1", name: "", tokenHash: "deadbeef", createdAt: NOW });
  }

  async function seedLoop(overrides: Partial<typeof loops.$inferInsert> = {}): Promise<void> {
    await db.insert(loops).values({
      id: "loop-1",
      machineId: "m-1",
      workdir: "/home/user/project",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }

  async function getLoop(): Promise<Loop> {
    return (await db.select().from(loops).where(eq(loops.id, "loop-1")))[0]!;
  }

  it("changed lands: new dir, generation+1, sync triple cleared, manifest pointer kept, OCC revision +1", async () => {
    await fresh();
    await seedLoop({
      artifactDir: "/old",
      artifactConfigRevision: 2,
      artifactManifestRevision: 3,
      artifactManifestId: "amf-1",
      artifactSyncAttemptedAt: NOW,
      artifactSyncSucceededAt: NOW,
      artifactSyncError: "artifact_storage_error",
      revision: 7,
    });
    const before = await getLoop();

    const result = await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/new" });
    expect(result).toMatchObject({ ok: true, outcome: "changed" });

    const after = await getLoop();
    expect(after.artifactDir).toBe("/new");
    expect(after.artifactConfigRevision).toBe(3);
    expect([after.artifactSyncAttemptedAt, after.artifactSyncSucceededAt, after.artifactSyncError]).toEqual([
      null,
      null,
      null,
    ]);
    // 决策 8: the old manifest pointer is KEPT (staleness is a read-time
    // computation, never a pointer nulling).
    expect([after.artifactManifestId, after.artifactManifestRevision]).toEqual(["amf-1", 3]);
    expect(after.updatedAt).toBe(clock.iso());
    expect(after.revision).toBe(before.revision + 1);
    // Business revisions of other domains are untouched.
    expect([after.goalRevision, after.scheduleRevision]).toEqual([before.goalRevision, before.scheduleRevision]);
  });

  it("noop is ZERO writes — the whole row (updatedAt and revision included) is item-equal", async () => {
    await fresh();
    await seedLoop({ artifactDir: "/data", artifactConfigRevision: 2, revision: 4 });
    const before = await getLoop();

    const result = await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data" });
    expect(result).toMatchObject({ ok: true, outcome: "noop" });
    expect(await getLoop()).toEqual(before);
  });

  it("loop_not_found and rejections are zero-write results, not exceptions", async () => {
    await fresh();
    await expect(updateArtifactConfig({ db, clock }, "loop-ghost", { artifactDir: "/x" })).resolves.toEqual({
      ok: false,
      failure: "loop_not_found",
    });

    await seedLoop({ workdir: null });
    const before = await getLoop();
    await expect(updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "rel/path" })).resolves.toEqual({
      ok: false,
      failure: "artifact_dir_relative_without_workdir",
    });
    expect(await getLoop()).toEqual(before);
  });

  it("AM6: a config change keeps the old manifest view and marks it stale by generation", async () => {
    await fresh();
    await seedLoop({ artifactDir: "/data", artifactConfigRevision: 1 });
    // A manifest committed under generation 1, pointed at by the loop.
    await db.insert(artifactManifests).values({
      id: "amf-1",
      namespaceId: "ns-1",
      machineId: "m-1",
      loopId: "loop-1",
      configRevision: 1,
      manifestRevision: 1,
      entries: [],
      fileCount: 0,
      totalBytes: 0,
      committedAt: NOW,
    });
    await db.update(loops).set({ artifactManifestId: "amf-1", artifactManifestRevision: 1 }).where(eq(loops.id, "loop-1"));

    // Same generation: the view is current.
    const current = await readCurrentArtifactView(db, "loop-1");
    expect(current).toMatchObject({ manifestId: "amf-1", stale: false });
    expect(current!.manifest!.id).toBe("amf-1");

    // Effective change → generation 2: the OLD manifest is still the view,
    // now stale; the pointer and manifestRevision did not move.
    await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/elsewhere" });
    const stale = await readCurrentArtifactView(db, "loop-1");
    expect(stale).toMatchObject({
      artifactDir: "/elsewhere",
      configRevision: 2,
      manifestId: "amf-1",
      manifestRevision: 1,
      stale: true,
    });
    expect(stale!.manifest!.configRevision).toBe(1);

    // Unknown loop → undefined; a dangling pointer → manifest null, not stale.
    await expect(readCurrentArtifactView(db, "loop-ghost")).resolves.toBeUndefined();
    await db.update(loops).set({ artifactManifestId: "amf-ghost" }).where(eq(loops.id, "loop-1"));
    const dangling = await readCurrentArtifactView(db, "loop-1");
    expect(dangling).toMatchObject({ manifestId: "amf-ghost", manifest: null, stale: false });
  });

  it("AM6 (config-generation CAS): a competitor committed mid-flight can never be silently overwritten", async () => {
    await fresh();
    await seedLoop({ artifactDir: "/a", artifactConfigRevision: 1 });

    // The hook commits a REAL competing config write between the loser's
    // resolve and its guarded write (single-connection PGlite: the race
    // window lives outside the transaction — the ops.race.test.ts pattern).
    let competitorCalls = 0;
    const hooks = {
      afterResolve: async () => {
        competitorCalls += 1;
        if (competitorCalls > 1) return; // the retry re-resolves AFTER the competitor
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/competitor" });
      },
    };

    // Loser planned on generation 1; the competitor moved the row to
    // generation 2. The loser's guarded write misses, the bounded retry
    // re-plans on the FRESH row, and the write lands on generation 3 exactly
    // once — never overwriting the competitor's write with a stale plan.
    const result = await updateArtifactConfig({ db, clock, hooks }, "loop-1", { artifactDir: "/loser" });
    expect(result).toMatchObject({ ok: true, outcome: "changed" });
    const after = await getLoop();
    expect(after.artifactDir).toBe("/loser");
    expect(after.artifactConfigRevision).toBe(3);
    expect(competitorCalls).toBe(2);
  });

  it("AM6 (config-generation CAS): a retry that re-plans to an EQUAL value degrades to a zero-write noop", async () => {
    await fresh();
    await seedLoop({ artifactDir: "/a", artifactConfigRevision: 1 });

    let competitorCalls = 0;
    const hooks = {
      afterResolve: async () => {
        competitorCalls += 1;
        if (competitorCalls > 1) return;
        // The competitor sets EXACTLY the value the loser is carrying.
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/same" });
      },
    };

    const result = await updateArtifactConfig({ db, clock, hooks }, "loop-1", { artifactDir: "/same" });
    expect(result).toMatchObject({ ok: true, outcome: "noop" });
    const after = await getLoop();
    // Only the competitor's write landed: generation 2, one revision bump.
    expect(after.artifactDir).toBe("/same");
    expect(after.artifactConfigRevision).toBe(2);
  });

  it("a second guard loss fails closed as ArtifactConfigRaceLostError with no partial state", async () => {
    await fresh();
    await seedLoop({ artifactDir: "/a", artifactConfigRevision: 1 });

    // The hook fires on EVERY attempt (no early return): both the first
    // write and the bounded retry lose their guard. Each competitor write
    // must be an EFFECTIVE change (an equal value would be a noop and leave
    // the loser's guard intact).
    let competitorWrites = 0;
    const hooks = {
      afterResolve: async () => {
        competitorWrites += 1;
        await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: `/competitor-${competitorWrites}` });
      },
    };

    await expect(updateArtifactConfig({ db, clock, hooks }, "loop-1", { artifactDir: "/loser" })).rejects.toBeInstanceOf(
      ArtifactConfigRaceLostError,
    );
    // The row carries ONLY the competitor's writes — no partial loser state.
    const after = await getLoop();
    expect(after.artifactDir).toBe("/competitor-2");
    expect(after.artifactConfigRevision).toBe(3); // two competitor writes, zero loser writes
  });
});
