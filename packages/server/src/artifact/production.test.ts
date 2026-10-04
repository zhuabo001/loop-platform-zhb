/**
 * AT10 — the production ArtifactHome facade (Batch 2 slice 1, ADR-010 决策 21).
 *
 *  pure construction: no filesystem side effects, no env reads — the blobs
 *                     root must not exist until the first write.
 *  blob root:         pinned at `<dataDir>/blobs`.
 *  ids:               `sync-`/`amf-` prefixed and unique.
 *  clock:             defaults to systemClock, honors an injected clock.
 *  end to end:        the assembled deps resolve the machine namespace and run
 *                     prepare → PUT → commit, landing the verified bytes at
 *                     `<dataDir>/blobs/<machineId>/<hash>`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { FakeClock, seedLoop, seedMachine } from "../testkit/index.js";
import { systemClock } from "../time.js";
import { updateArtifactConfig } from "./config.js";
import {
  ARTIFACT_BLOB_ROOT_DIRNAME,
  artifactBlobRoot,
  createProductionArtifactHome,
  newArtifactManifestId,
  newArtifactSyncId,
} from "./production.js";
import { commitArtifactSync, prepareArtifactSync, putArtifactBlob } from "./sync.js";

const MACHINE_ID = "m-0123456789abcdef";
const CONTENT = "artifact bytes";
const HASH = createHash("sha256").update(CONTENT).digest("hex");

describe("AT10: createProductionArtifactHome", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  async function freshDb(): Promise<Db> {
    const handle = await openMigratedDb();
    handles.push(handle);
    return handle.db;
  }

  async function tempDataDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `loopzhb-artifact-production-${process.pid}-`));
    dirs.push(dir);
    return dir;
  }

  it("construction touches no filesystem — the blobs root appears only on first write", async () => {
    const db = await freshDb();
    const dataDir = await tempDataDir();
    const deps = createProductionArtifactHome({ db, dataDir });
    expect(deps.blobStore).toBeDefined();
    expect(deps.attribution).toBeDefined();
    await expect(fs.stat(artifactBlobRoot(dataDir))).rejects.toThrow();
    expect(await fs.readdir(dataDir)).toEqual([]);
  });

  it("pins the blob root at <dataDir>/blobs", () => {
    expect(ARTIFACT_BLOB_ROOT_DIRNAME).toBe("blobs");
    expect(artifactBlobRoot("/var/lib/loopzhb")).toBe(path.join("/var/lib/loopzhb", "blobs"));
  });

  it("ids are prefixed sync-/amf- and unique", () => {
    const syncIds = new Set(Array.from({ length: 8 }, () => newArtifactSyncId()));
    const manifestIds = new Set(Array.from({ length: 8 }, () => newArtifactManifestId()));
    expect(syncIds.size).toBe(8);
    expect(manifestIds.size).toBe(8);
    for (const id of syncIds) expect(id.startsWith("sync-")).toBe(true);
    for (const id of manifestIds) expect(id.startsWith("amf-")).toBe(true);
  });

  it("defaults to systemClock and honors an injected clock", async () => {
    const db = await freshDb();
    const dataDir = await tempDataDir();
    expect(createProductionArtifactHome({ db, dataDir }).clock).toBe(systemClock);
    const clock = new FakeClock();
    expect(createProductionArtifactHome({ db, dataDir, clock }).clock).toBe(clock);
  });

  it("runs prepare → PUT → commit and lands the verified bytes under <dataDir>/blobs/<machineId>/<hash>", async () => {
    const db = await freshDb();
    const dataDir = await tempDataDir();
    const clock = new FakeClock();
    const deps = createProductionArtifactHome({ db, dataDir, clock });

    await seedMachine(db, MACHINE_ID);
    await seedLoop(db, { id: "loop-1", machineId: MACHINE_ID });
    const cfg = await updateArtifactConfig({ db, clock }, "loop-1", { artifactDir: "/data/out" });
    expect(cfg.ok && cfg.outcome).toBe("changed");

    expect(await deps.attribution.resolve({ machineId: MACHINE_ID })).toEqual({
      ok: true,
      namespaceId: MACHINE_ID,
      machineId: MACHINE_ID,
    });

    const prepare = await prepareArtifactSync(
      deps,
      { machineId: MACHINE_ID },
      {
        requestId: "req-1",
        loopId: "loop-1",
        configRevision: 1,
        baseManifestRevision: 0,
        entries: [{ path: "a.txt", hash: HASH, size: CONTENT.length }],
      },
    );
    expect(prepare.ok).toBe(true);
    if (!prepare.ok) return;
    expect(prepare.response.syncId.startsWith("sync-")).toBe(true);
    expect(prepare.response.needHashes).toEqual([HASH]);

    const put = await putArtifactBlob(
      deps,
      { machineId: MACHINE_ID },
      {
        syncId: prepare.response.syncId,
        hash: HASH,
        bytes: (async function* () {
          yield new TextEncoder().encode(CONTENT);
        })(),
      },
    );
    expect(put).toEqual({ ok: true, size: CONTENT.length, published: true });
    expect(await fs.readFile(path.join(dataDir, ARTIFACT_BLOB_ROOT_DIRNAME, MACHINE_ID, HASH), "utf8")).toBe(CONTENT);

    const commit = await commitArtifactSync(deps, { machineId: MACHINE_ID }, { syncId: prepare.response.syncId });
    expect(commit.ok).toBe(true);
    if (commit.ok) {
      expect(commit.receipt.artifactSnapshotId.startsWith("amf-")).toBe(true);
      expect(commit.receipt.manifestRevision).toBe(1);
    }
  });
});
