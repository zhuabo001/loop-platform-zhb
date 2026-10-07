/**
 * ArtifactHome production facade — the ONE place that assembles the production
 * ArtifactHomeDeps (ADR-010 决策 21, Batch 2 slice 1).
 *
 * Construction is PURE: no fs side effects (the local BlobStore creates
 * nothing until its first write), no environment reads, no timers, and no
 * dependency on the startup module — `dataDir` is passed in by the caller.
 * Slice 1 only tests this facade; the production composition in start.ts and
 * the HTTP routes arrive in slice 2.
 *
 * Blob root: `<dataDir>/blobs` (Batch 2 plan §1). The root is written ONLY by
 * the server's trusted runtime identity (ADR-010 决策 14 部署信任边界).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Db } from "../db/index.js";
import { systemClock, type Clock } from "../time.js";
import { createMachineAttributionResolver } from "./attribution-machine.js";
import { createLocalBlobStore } from "./blob-store-local.js";
import type { ArtifactHomeDeps } from "./sync.js";

/** The blob-root directory name under `dataDir`. */
export const ARTIFACT_BLOB_ROOT_DIRNAME = "blobs";

export function artifactBlobRoot(dataDir: string): string {
  return path.join(dataDir, ARTIFACT_BLOB_ROOT_DIRNAME);
}

/** Server-minted ids (ADR-010 决策 12: a manifest id is NOT content-addressed). */
export function newArtifactSyncId(): string {
  return `sync-${randomUUID()}`;
}

export function newArtifactManifestId(): string {
  return `amf-${randomUUID()}`;
}

export interface ArtifactHomeProductionOptions {
  db: Db;
  /** Absolute server data dir (ServerConfig.dataDir, default ~/.loopzhb). */
  dataDir: string;
  clock?: Clock;
}

export function createProductionArtifactHome(options: ArtifactHomeProductionOptions): ArtifactHomeDeps {
  const { db, dataDir } = options;
  return {
    db,
    clock: options.clock ?? systemClock,
    ids: { syncId: newArtifactSyncId, manifestId: newArtifactManifestId },
    blobStore: createLocalBlobStore({ rootDir: artifactBlobRoot(dataDir) }),
    attribution: createMachineAttributionResolver({ db }),
  };
}
