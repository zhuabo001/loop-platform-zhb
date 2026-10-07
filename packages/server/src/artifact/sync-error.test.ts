/**
 * AH10 — the artifact sync-error report writer (Batch 2 slice 2, ADR-010
 * 决策 13): the double-match gate, the unconfigured gate, the cross-machine
 * refusal and the guarded write. Every refusal is ZERO-WRITE; `succeededAt`
 * survives a later failure.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops } from "../db/schema.js";
import { FakeClock, seedLoop, seedMachine, snapshotLoops, staticAttribution } from "../testkit/index.js";
import { recordArtifactSyncError, type ArtifactSyncErrorDeps } from "./sync-error.js";

const MACHINE = { machineId: "m-1" };

describe("AH10: recordArtifactSyncError — gates, scope and the guarded write", () => {
  const handles: DbHandle[] = [];
  let db: Db;
  let clock: FakeClock;
  let deps: ArtifactSyncErrorDeps;

  afterEach(async () => {
    for (const handle of handles.splice(0)) await closeDb(handle);
  });

  async function fresh(options: { attributionMissing?: boolean; hooks?: ArtifactSyncErrorDeps["hooks"] } = {}): Promise<void> {
    const handle = await openMigratedDb();
    handles.push(handle);
    db = handle.db;
    clock = new FakeClock();
    deps = {
      db,
      clock,
      attribution: staticAttribution(options.attributionMissing ? {} : { "m-1": "ns-1" }),
      hooks: options.hooks,
    };
    await seedMachine(db, "m-1");
  }

  /** The canonical configured loop: config generation 2, base manifest 5. */
  async function configuredLoop(overrides: Partial<Parameters<typeof seedLoop>[1]> = {}): Promise<void> {
    await seedLoop(db, {
      id: "loop-1",
      machineId: "m-1",
      artifactDir: "/data",
      artifactConfigRevision: 2,
      artifactManifestRevision: 5,
      ...overrides,
    });
  }

  const report = (overrides: Partial<{ failure: string; configRevision: number; baseManifestRevision: number }> = {}) =>
    ({
      failure: "watcher_error",
      configRevision: 2,
      baseManifestRevision: 5,
      ...overrides,
    }) as Parameters<typeof recordArtifactSyncError>[3];

  const row = async () => (await db.select().from(loops))[0]!;

  it("matching revisions: records attemptedAt + the failure class, bumps revision, touches NOTHING else", async () => {
    await fresh();
    await configuredLoop({ revision: 7, artifactSyncSucceededAt: "2026-10-01T00:00:00.000Z" });
    const before = await row();

    const result = await recordArtifactSyncError(deps, MACHINE, "loop-1", report({ failure: "directory_missing" }));

    expect(result).toEqual({ ok: true, recorded: true });
    const after = await row();
    expect(after.artifactSyncError).toBe("directory_missing");
    expect(after.artifactSyncAttemptedAt).toBe(clock.now().toISOString());
    expect(after.updatedAt).toBe(clock.now().toISOString());
    expect(after.revision).toBe(before.revision + 1);
    // A failure never rewrites a success stamp or the manifest pointer.
    expect(after.artifactSyncSucceededAt).toBe("2026-10-01T00:00:00.000Z");
    expect(after.artifactManifestId).toBe(before.artifactManifestId);
    expect(after.artifactManifestRevision).toBe(before.artifactManifestRevision);
  });

  it("config-generation drift is recorded:false with ZERO writes", async () => {
    await fresh();
    await configuredLoop();
    const before = await snapshotLoops(db);
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-1", report({ configRevision: 1 }))).toEqual({
      ok: true,
      recorded: false,
    });
    expect(await snapshotLoops(db)).toEqual(before);
  });

  it("base-manifest drift (a newer success landed) is recorded:false with ZERO writes", async () => {
    await fresh();
    await configuredLoop({ artifactManifestRevision: 6, artifactSyncSucceededAt: "2026-10-02T00:00:00.000Z" });
    const before = await snapshotLoops(db);
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-1", report({ baseManifestRevision: 5 }))).toEqual({
      ok: true,
      recorded: false,
    });
    expect(await snapshotLoops(db)).toEqual(before);
  });

  it("an UNCONFIGURED loop (0/0) refuses the report — the spurious-match trap stays clean", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId: "m-1" }); // artifactDir null, revisions 0
    const before = await snapshotLoops(db);
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-1", report({ configRevision: 0, baseManifestRevision: 0 }))).toEqual({
      ok: true,
      recorded: false,
    });
    expect(await snapshotLoops(db)).toEqual(before);
  });

  it("unknown and cross-machine loops refuse as loop_not_found with ZERO writes", async () => {
    await fresh();
    await configuredLoop();
    await seedLoop(db, { id: "loop-2", machineId: "m-2", artifactDir: "/other" });
    const before = await snapshotLoops(db);
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-ghost", report())).toEqual({
      ok: false,
      failure: "loop_not_found",
    });
    // m-2's loop is never touched (the caller passed it, not its owner).
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-2", report())).toEqual({
      ok: false,
      failure: "loop_not_found",
    });
    expect(await snapshotLoops(db)).toEqual(before);
  });

  it("missing attribution refuses before any loop read (zero writes)", async () => {
    await fresh({ attributionMissing: true });
    await configuredLoop();
    const before = await snapshotLoops(db);
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-1", report())).toEqual({
      ok: false,
      failure: "attribution_missing",
    });
    expect(await snapshotLoops(db)).toEqual(before);
  });

  it("a competing write between the gate and the UPDATE loses the CAS: recorded:false, zero writes", async () => {
    await fresh({
      hooks: {
        async afterGate(loopId) {
          // A REAL competing write on the same connection — a claim bump or any
          // management op landing in the gate read → guarded UPDATE window.
          await db
            .update(loops)
            .set({ revision: sql`${loops.revision} + 1` })
            .where(eq(loops.id, loopId));
        },
      },
    });
    await configuredLoop();
    const before = await row();
    expect(await recordArtifactSyncError(deps, MACHINE, "loop-1", report())).toEqual({ ok: true, recorded: false });
    const after = await row();
    expect(after.revision).toBe(before.revision + 1); // the competitor's bump, not ours
    expect(after.artifactSyncError).toBeNull();
  });
});
