/**
 * Management read facade evidence (Batch 2 slice 7; ADR-010 决策 27).
 *
 *  pure:   the `diffManifestEntries` matrix — the three change classes, the
 *          same-hash omission, the empty-set baseline, the as-given direction
 *          (V1) and the from===to empty diff.
 *  reads:  the frozen evaluation order (loop row = identity discovery,
 *          attribution before any snapshot/path/blob resolution), the
 *          unconfigured/stale/dangling loop view semantics (reusing
 *          `readCurrentArtifactView` verbatim), the run bound/missing/row-gone
 *          discrimination (V3), the download-open rulings (resolver-sourced
 *          namespace, cross-scope 404s, R3 raw `blob_missing`, anomaly →
 *          `storage_error`), and the diff endpoint scope checks.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactManifests, loops, runs, type NewArtifactManifest } from "../db/schema.js";
import { createMemoryBlobStore, type MemoryBlobStoreFaults } from "./blob-store-memory.js";
import {
  diffLoopSnapshots,
  diffManifestEntries,
  openArtifactDownload,
  readLoopArtifactsView,
  readRunArtifactsView,
  type ArtifactReadHome,
} from "./read.js";
import { seedLoop, seedMachine, seedRun, staticAttribution } from "../testkit/index.js";

const NOW = "2026-10-06T00:00:00.000Z";

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const HASH_A = hashOf("aaa");
const HASH_B = hashOf("bbb");

function entry(path: string, content: string): { path: string; hash: string; size: number } {
  const bytes = new TextEncoder().encode(content);
  return { path, hash: hashOf(content), size: bytes.byteLength };
}

describe("diffManifestEntries (pure, V1: directional as-given algebra)", () => {
  const BEFORE = [entry("a.txt", "aaa"), entry("b.txt", "bbb"), entry("gone.txt", "ccc")];
  const AFTER = [entry("a.txt", "aaa"), entry("b.txt", "BBB"), entry("new.txt", "ccc")];

  it("added / modified / removed with before/after hash+size only", () => {
    expect(diffManifestEntries(BEFORE, AFTER)).toEqual({
      added: [entry("new.txt", "ccc")],
      modified: [
        { path: "b.txt", beforeHash: HASH_B, beforeSize: 3, afterHash: hashOf("BBB"), afterSize: 3 },
      ],
      removed: [entry("gone.txt", "ccc")],
    });
  });

  it("same-hash entries are UNCHANGED and omitted (size drift alone is not a change)", () => {
    const before = [entry("a.txt", "aaa")];
    const after = [{ path: "a.txt", hash: HASH_A, size: 999 }];
    expect(diffManifestEntries(before, after)).toEqual({ added: [], modified: [], removed: [] });
  });

  it("null before = the empty-set baseline: everything is added", () => {
    expect(diffManifestEntries(null, AFTER)).toEqual({
      added: AFTER,
      modified: [],
      removed: [],
    });
  });

  it("empty after = everything removed; empty before AND after = empty diff", () => {
    expect(diffManifestEntries(BEFORE, [])).toEqual({ added: [], modified: [], removed: BEFORE });
    expect(diffManifestEntries([], [])).toEqual({ added: [], modified: [], removed: [] });
  });

  it("from === to diffs to empty (same snapshot = no change)", () => {
    expect(diffManifestEntries(BEFORE, BEFORE)).toEqual({ added: [], modified: [], removed: [] });
  });

  it("reversed direction swaps added/removed and the before/after columns (as-given, V1)", () => {
    const reversed = diffManifestEntries(AFTER, BEFORE);
    expect(reversed.added.map((e) => e.path)).toEqual(["gone.txt"]);
    expect(reversed.removed.map((e) => e.path)).toEqual(["new.txt"]);
    expect(reversed.modified[0]).toMatchObject({
      path: "b.txt",
      beforeHash: hashOf("BBB"),
      afterHash: HASH_B,
    });
  });
});

describe("read facade over real PGlite (frozen evaluation order, AV1/AV2/AV7)", () => {
  let handle: DbHandle;
  let db: Db;
  let blobFaults: MemoryBlobStoreFaults;
  let home: ArtifactReadHome;

  beforeEach(async () => {
    handle = await openMigratedDb();
    db = handle.db;
    blobFaults = {};
    home = {
      db,
      attribution: staticAttribution({ "m-1": "m-1" }),
      blobStore: createMemoryBlobStore({ faults: blobFaults }),
    };
    await seedMachine(db, "m-1");
  });

  afterEach(async () => {
    await closeDb(handle);
  });

  async function seedManifest(overrides: Partial<NewArtifactManifest> & { id: string }): Promise<void> {
    const entries = overrides.entries ?? [entry("a.txt", "aaa"), entry("b.txt", "bbb")];
    await db.insert(artifactManifests).values({
      namespaceId: "m-1",
      machineId: "m-1",
      loopId: "loop-1",
      configRevision: 1,
      manifestRevision: 1,
      entries,
      fileCount: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.size, 0),
      committedAt: NOW,
      ...overrides,
    });
  }

  /** loop-1 bound to manifest amf-1 under config generation 1. */
  async function seedBoundLoop(overrides: Partial<Parameters<typeof seedLoop>[1]> = {}): Promise<void> {
    await seedManifest({ id: "amf-1" });
    await seedLoop(db, {
      id: "loop-1",
      machineId: "m-1",
      artifactDir: "/data/out",
      artifactConfigRevision: 1,
      artifactManifestRevision: 1,
      artifactManifestId: "amf-1",
      ...overrides,
    });
  }

  describe("readLoopArtifactsView", () => {
    it("unconfigured loop is NOT an error: the nullable view shape is served (AV7)", async () => {
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      const result = await readLoopArtifactsView(home, "loop-1");
      expect(result).toEqual({
        ok: true,
        response: {
          loopId: "loop-1",
          artifactDir: null,
          configRevision: 0,
          manifestRevision: 0,
          manifestId: null,
          committedAt: null,
          stale: false,
          fileCount: 0,
          totalBytes: 0,
          sync: { attemptedAt: null, succeededAt: null, error: null },
          files: [],
        },
      });
    });

    it("bound loop serves the manifest entries; sync state columns ride along (AV1)", async () => {
      await seedBoundLoop({
        artifactSyncAttemptedAt: NOW,
        artifactSyncError: "directory_missing",
      });
      const result = await readLoopArtifactsView(home, "loop-1");
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.response).toMatchObject({
        artifactDir: "/data/out",
        configRevision: 1,
        manifestRevision: 1,
        manifestId: "amf-1",
        committedAt: NOW,
        stale: false,
        fileCount: 2,
        totalBytes: 6,
        sync: { attemptedAt: NOW, succeededAt: null, error: "directory_missing" },
      });
      expect(result.response.files).toEqual([entry("a.txt", "aaa"), entry("b.txt", "bbb")]);
    });

    it("config generation moved on ⇒ stale:true, the old view still served (决策 8, AV7)", async () => {
      await seedBoundLoop({ artifactConfigRevision: 2 });
      const result = await readLoopArtifactsView(home, "loop-1");
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.response.stale).toBe(true);
      expect(result.response.files).toHaveLength(2);
    });

    it("dangling pointer ⇒ manifest null, stale:false, empty files (out-of-band damage only)", async () => {
      await seedBoundLoop({ artifactManifestId: "amf-ghost" });
      const result = await readLoopArtifactsView(home, "loop-1");
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.response).toMatchObject({ manifestId: "amf-ghost", manifestRevision: 1, stale: false, files: [] });
    });

    it("unknown loop ⇒ loop_not_found; unmapped machine ⇒ attribution_missing (AV2)", async () => {
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      expect(await readLoopArtifactsView(home, "loop-nope")).toEqual({ ok: false, failure: "loop_not_found" });
      const refused = await readLoopArtifactsView(
        { ...home, attribution: staticAttribution({}) },
        "loop-1",
      );
      expect(refused).toEqual({ ok: false, failure: "attribution_missing" });
    });
  });

  describe("readRunArtifactsView", () => {
    it("unbound run ⇒ the EXPLICIT missing state, exactly the frozen shape (AV7)", async () => {
      await seedBoundLoop();
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: null });
      const result = await readRunArtifactsView(home, "run-1");
      expect(result).toEqual({ ok: true, response: { runId: "run-1", loopId: "loop-1", state: "missing" } });
      if (result.ok) expect(result.response).not.toHaveProperty("files");
    });

    it("bound run serves the snapshot's frozen bound shape", async () => {
      await seedBoundLoop();
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: "amf-1" });
      const result = await readRunArtifactsView(home, "run-1");
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.response).toEqual({
        runId: "run-1",
        loopId: "loop-1",
        state: "bound",
        snapshotId: "amf-1",
        manifestRevision: 1,
        configRevision: 1,
        committedAt: NOW,
        fileCount: 2,
        totalBytes: 6,
        files: [entry("a.txt", "aaa"), entry("b.txt", "bbb")],
      });
    });

    it("cross-loop snapshot reference ⇒ snapshot_not_found, never the other loop's data (AV2)", async () => {
      await seedManifest({ id: "amf-other", loopId: "loop-2" });
      await seedLoop(db, { id: "loop-2", machineId: "m-1" });
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: "amf-other" });
      expect(await readRunArtifactsView(home, "run-1")).toEqual({ ok: false, failure: "snapshot_not_found" });
    });

    it("bound-but-row-gone ⇒ snapshot_not_found, NOT missing (V3: never rewrite history)", async () => {
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: "amf-ghost" });
      expect(await readRunArtifactsView(home, "run-1")).toEqual({ ok: false, failure: "snapshot_not_found" });
    });

    it("unknown run ⇒ run_not_found", async () => {
      expect(await readRunArtifactsView(home, "run-nope")).toEqual({ ok: false, failure: "run_not_found" });
    });

    it("#111: the nested page's expected parent folds a mismatch into run_not_found at the IDENTITY step", async () => {
      await seedBoundLoop();
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: "amf-1" });
      // Wrong / nonexistent parent: indistinguishable from a run that never
      // existed — bound state and (below) missing state alike.
      expect(await readRunArtifactsView(home, "run-1", "loop-OTHER")).toEqual({ ok: false, failure: "run_not_found" });
      expect(await readRunArtifactsView(home, "run-1", "loop-nope")).toEqual({ ok: false, failure: "run_not_found" });
      expect(await readRunArtifactsView(home, "run-nope", "loop-1")).toEqual({ ok: false, failure: "run_not_found" });
      // The matching parent keeps the domain result.
      const bound = await readRunArtifactsView(home, "run-1", "loop-1");
      if (!bound.ok) throw new Error(`fixture must succeed: ${JSON.stringify(bound)}`);
      expect(bound.response.state).toBe("bound");
      // No expected parent (the flat JSON route): the unscoped legacy read.
      const legacy = await readRunArtifactsView(home, "run-1");
      if (!legacy.ok) throw new Error(`fixture must succeed: ${JSON.stringify(legacy)}`);
      expect(legacy.response.state).toBe("bound");
      // …and the missing state folds the same way.
      await seedRun(db, { id: "run-2", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: null });
      expect(await readRunArtifactsView(home, "run-2", "loop-OTHER")).toEqual({ ok: false, failure: "run_not_found" });
      const missing = await readRunArtifactsView(home, "run-2", "loop-1");
      if (!missing.ok) throw new Error(`fixture must succeed: ${JSON.stringify(missing)}`);
      expect(missing.response.state).toBe("missing");
    });

    it("#111 round 2: the parent check precedes ATTRIBUTION — a wrong parent never leaks 403-vs-404 across scopes", async () => {
      // The run's loop resolves to NO namespace (its machine row is gone from
      // the resolver's mapping — the review's parent-failure probe).
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: null });
      const unmapped = { ...home, attribution: staticAttribution({}) };
      // Correct parent: attribution_missing is the preserved 403 control.
      expect(await readRunArtifactsView(unmapped, "run-1", "loop-1")).toEqual({
        ok: false,
        failure: "attribution_missing",
      });
      // Wrong / nonexistent parent: run_not_found — the domain failure must
      // not leak the run's existence under a foreign scope (决策 13/27).
      expect(await readRunArtifactsView(unmapped, "run-1", "loop-OTHER")).toEqual({
        ok: false,
        failure: "run_not_found",
      });
      expect(await readRunArtifactsView(unmapped, "run-1", "loop-nope")).toEqual({
        ok: false,
        failure: "run_not_found",
      });
    });
  });

  describe("openArtifactDownload", () => {
    it("opens the verified stream for a manifest entry; namespace comes from the RESOLVER, not the row", async () => {
      // The row claims a foreign namespace; only the resolver's namespace has
      // the blob. A row-sourced key would miss (mutation ①).
      await seedManifest({ id: "amf-1", namespaceId: "ns-evil" });
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      await home.blobStore.writeVerified({
        namespaceId: "m-1",
        hash: HASH_A,
        expectedSize: 3,
        bytes: (async function* () {
          yield new TextEncoder().encode("aaa");
        })(),
      });
      const result = await openArtifactDownload(home, "loop-1", { snapshotId: "amf-1", path: "a.txt" });
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.entry).toEqual(entry("a.txt", "aaa"));
      expect(result.manifest.id).toBe("amf-1");
      expect(result.stream.size).toBe(3);
      await result.stream.close();
    });

    it("manifest-absent path (incl. traversal-shaped) ⇒ path_not_found; cross-loop snapshot ⇒ snapshot_not_found (AV2)", async () => {
      await seedManifest({ id: "amf-1" });
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      // The lookup is the manifest ENTRIES table, never a disk path: a
      // traversal-shaped string is simply an unknown path.
      for (const path of ["absent.txt", "../escape.txt"]) {
        expect(await openArtifactDownload(home, "loop-1", { snapshotId: "amf-1", path })).toEqual({
          ok: false,
          failure: "path_not_found",
        });
      }
      await seedManifest({ id: "amf-other", loopId: "loop-2" });
      await seedLoop(db, { id: "loop-2", machineId: "m-1" });
      expect(
        await openArtifactDownload(home, "loop-1", { snapshotId: "amf-other", path: "a.txt" }),
      ).toEqual({ ok: false, failure: "snapshot_not_found" });
    });

    it("blob gone ⇒ RAW blob_missing (the ROUTE composes R3 → 404 path_not_found)", async () => {
      await seedManifest({ id: "amf-1" });
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      const result = await openArtifactDownload(home, "loop-1", { snapshotId: "amf-1", path: "a.txt" });
      expect(result).toEqual({ ok: false, failure: "blob_missing" });
    });

    it("anomaly openings ⇒ storage_error, never laundered into a client class", async () => {
      await seedManifest({ id: "amf-1" });
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      // Faults are captured at store CREATION — build the anomalous store in
      // this test, not via the shared mutable bag.
      const anomalous: ArtifactReadHome = {
        ...home,
        blobStore: createMemoryBlobStore({ faults: { notRegularKeys: new Set([`m-1/${HASH_A}`]) } }),
      };
      const result = await openArtifactDownload(anomalous, "loop-1", { snapshotId: "amf-1", path: "a.txt" });
      expect(result).toEqual({ ok: false, failure: "storage_error" });
    });

    it("attribution is resolved BEFORE the snapshot read (决策 27 order): a poisoned attribution never touches the snapshot stage", async () => {
      await seedLoop(db, { id: "loop-1", machineId: "m-1" });
      // The 2nd top-level select is the snapshot read. Original order stops
      // at attribution (one select); an order flip walks into the fault.
      let n = 0;
      const faulting = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "select") {
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          }
          return (...args: unknown[]) => {
            n += 1;
            if (n === 2) throw Object.assign(new Error("injected storage fault"), { code: "08006" });
            return (target.select as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as Db;
      const poisoned: ArtifactReadHome = {
        db: faulting,
        attribution: staticAttribution({}),
        blobStore: createMemoryBlobStore(),
      };
      const result = await openArtifactDownload(poisoned, "loop-1", { snapshotId: "amf-1", path: "a.txt" });
      expect(result).toEqual({ ok: false, failure: "attribution_missing" });
    });
  });

  describe("diffLoopSnapshots", () => {
    async function seedTwoSnapshots(): Promise<void> {
      await seedManifest({
        id: "amf-1",
        manifestRevision: 1,
        entries: [entry("a.txt", "aaa"), entry("gone.txt", "ccc")],
      });
      await seedManifest({
        id: "amf-2",
        manifestRevision: 2,
        entries: [entry("a.txt", "aaa"), entry("b.txt", "bbb")],
      });
      await seedLoop(db, {
        id: "loop-1",
        machineId: "m-1",
        artifactConfigRevision: 2,
        artifactManifestRevision: 2,
        artifactManifestId: "amf-2",
      });
    }

    it("from+to: the three classes with the frozen response shape (AV6)", async () => {
      await seedTwoSnapshots();
      const result = await diffLoopSnapshots(home, "loop-1", { from: "amf-1", to: "amf-2" });
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.response).toEqual({
        loopId: "loop-1",
        from: { snapshotId: "amf-1", manifestRevision: 1 },
        to: { snapshotId: "amf-2", manifestRevision: 2 },
        added: [entry("b.txt", "bbb")],
        modified: [],
        removed: [entry("gone.txt", "ccc")],
      });
    });

    it("omitted from = empty-set baseline: from is null in the response (AV6)", async () => {
      await seedTwoSnapshots();
      const result = await diffLoopSnapshots(home, "loop-1", { to: "amf-2" });
      if (!result.ok) throw new Error(`fixture must succeed: ${JSON.stringify(result)}`);
      expect(result.response.from).toBeNull();
      expect(result.response.added.map((e) => e.path).sort()).toEqual(["a.txt", "b.txt"]);
      expect(result.response.removed).toEqual([]);
    });

    it("cross-loop to (or from) ⇒ snapshot_not_found (AV2)", async () => {
      await seedTwoSnapshots();
      await seedManifest({ id: "amf-other", loopId: "loop-2", manifestRevision: 1 });
      await seedLoop(db, { id: "loop-2", machineId: "m-1" });
      expect(await diffLoopSnapshots(home, "loop-1", { to: "amf-other" })).toEqual({
        ok: false,
        failure: "snapshot_not_found",
      });
      expect(await diffLoopSnapshots(home, "loop-1", { from: "amf-other", to: "amf-2" })).toEqual({
        ok: false,
        failure: "snapshot_not_found",
      });
    });

    it("unknown loop ⇒ loop_not_found (evaluation order: scope before snapshots)", async () => {
      await seedTwoSnapshots();
      expect(await diffLoopSnapshots(home, "loop-nope", { to: "amf-2" })).toEqual({
        ok: false,
        failure: "loop_not_found",
      });
    });
  });

  describe("zero-write invariant (AV2)", () => {
    it("every refusal path leaves loops/runs/manifests untouched", async () => {
      await seedBoundLoop();
      await seedRun(db, { id: "run-1", loopId: "loop-1", machineId: "m-1", artifactSnapshotId: "amf-1" });
      const loopsBefore = await db.select().from(loops);
      const runsBefore = await db.select().from(runs);
      const manifestsBefore = await db.select().from(artifactManifests);

      await readLoopArtifactsView({ ...home, attribution: staticAttribution({}) }, "loop-1");
      await readRunArtifactsView(home, "run-nope");
      await openArtifactDownload(home, "loop-1", { snapshotId: "amf-1", path: "nope.txt" });
      await diffLoopSnapshots(home, "loop-1", { to: "amf-ghost" });

      expect(await db.select().from(loops)).toEqual(loopsBefore);
      expect(await db.select().from(runs)).toEqual(runsBefore);
      expect(await db.select().from(artifactManifests)).toEqual(manifestsBefore);
    });
  });
});
