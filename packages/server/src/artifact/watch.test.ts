/**
 * AH11 — the poll watch set and the digest compare (Batch 2 slice 2,
 * ADR-010 决策 22): every configured loop of the machine (paused and
 * completed included), and the "missing digest == empty-set digest" rule
 * that keeps Batch 1 daemons byte-identical.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactWatchItem } from "@loopzhb/protocol";
import { watchConfigDigest } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { seedLoop } from "../testkit/index.js";
import { planArtifactWatchResponse, readMachineWatchItems } from "./watch.js";

const MACHINE = { id: "m-1", roots: ["/home/dev"] as string[] | null };

describe("AH11: the machine's watch set", () => {
  const handles: DbHandle[] = [];
  let db: Db;

  afterEach(async () => {
    for (const handle of handles.splice(0)) await closeDb(handle);
  });

  async function fresh(): Promise<void> {
    const handle = await openMigratedDb();
    handles.push(handle);
    db = handle.db;
  }

  it("collects EVERY configured loop of the machine — paused and completed included — and nothing else", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-b", machineId: "m-1", artifactDir: "/b", workdir: "/home/dev/b", artifactConfigRevision: 4 });
    await seedLoop(db, { id: "loop-a", machineId: "m-1", artifactDir: "/a", artifactConfigRevision: 2 });
    await seedLoop(db, { id: "loop-paused", machineId: "m-1", artifactDir: "/p", enabled: false, artifactConfigRevision: 1 });
    await seedLoop(db, {
      id: "loop-done",
      machineId: "m-1",
      artifactDir: "/d",
      // The completion triple is all-or-nothing (loops_completion_ck): goal +
      // completedAt + reason + enabled=false.
      goal: "done",
      completedAt: "2026-10-01T00:00:00.000Z",
      completionReason: "goal met",
      enabled: false,
      artifactConfigRevision: 3,
    });
    await seedLoop(db, { id: "loop-plain", machineId: "m-1" }); // unconfigured — excluded
    await seedLoop(db, { id: "loop-other", machineId: "m-2", artifactDir: "/x" }); // other machine — excluded

    expect(await readMachineWatchItems(db, MACHINE)).toEqual([
      { loopId: "loop-a", artifactDir: "/a", workdir: null, roots: ["/home/dev"], configRevision: 2 },
      { loopId: "loop-b", artifactDir: "/b", workdir: "/home/dev/b", roots: ["/home/dev"], configRevision: 4 },
      { loopId: "loop-done", artifactDir: "/d", workdir: null, roots: ["/home/dev"], configRevision: 3 },
      { loopId: "loop-paused", artifactDir: "/p", workdir: null, roots: ["/home/dev"], configRevision: 1 },
    ] satisfies ArtifactWatchItem[]);
  });

  it("a null roots column reads as [] (the production machine shape)", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-a", machineId: "m-1", artifactDir: "/a" });
    const items = await readMachineWatchItems(db, { id: "m-1", roots: null });
    expect(items[0]!.roots).toEqual([]);
  });
});

describe("AH11: planArtifactWatchResponse — the digest compare", () => {
  const ITEM: ArtifactWatchItem = {
    loopId: "loop-a",
    artifactDir: "/a",
    workdir: null,
    roots: [],
    configRevision: 1,
  };
  const DIGEST = watchConfigDigest([ITEM]);
  const EMPTY = watchConfigDigest([]);

  it("a matching digest omits BOTH keys (no update needed)", () => {
    expect(planArtifactWatchResponse([ITEM], DIGEST)).toEqual({});
    expect(planArtifactWatchResponse([], EMPTY)).toEqual({});
  });

  it("a MISSING digest equals the empty-set digest: an empty set stays silent, a configured set propagates", () => {
    // Batch 1 daemons (no watchDigest) with no configured loops: byte-identical.
    expect(planArtifactWatchResponse([], undefined)).toEqual({});
    // …but the moment a loop is configured, the full set rides the response.
    expect(planArtifactWatchResponse([ITEM], undefined)).toEqual({ watch: [ITEM], watchDigest: DIGEST });
  });

  it("a drifted digest sends the COMPLETE set plus the computed digest", () => {
    expect(planArtifactWatchResponse([ITEM], EMPTY)).toEqual({ watch: [ITEM], watchDigest: DIGEST });
    expect(planArtifactWatchResponse([ITEM], "stale-digest")).toEqual({ watch: [ITEM], watchDigest: DIGEST });
  });

  it("clearing the last configured loop sends watch: [] — the clear-all payload", () => {
    expect(planArtifactWatchResponse([], DIGEST)).toEqual({ watch: [], watchDigest: EMPTY });
  });
});
