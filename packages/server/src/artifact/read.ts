/**
 * Management read facade — the four Batch 2 slice 7 read operations
 * (ADR-010 决策 27). Pure domain reads behind the `ArtifactApi` door: no HTTP
 * types in, `ArtifactReadFailure` result unions out (the slice-1 frozen read
 * domain, error-mapping.ts).
 *
 * Evaluation order (决策 27): these routes carry NO credential — the machine
 * identity is DISCOVERED from the loop row, so the loop lookup is the
 * identity-discovery step and attribution is re-resolved BEFORE any
 * snapshot/path/blob resolution and before any data leaves. Existence never
 * leaks across scopes: an unknown OR cross-scope snapshot/path/run stays the
 * code-less 404 family (决策 13).
 *
 * The blob key's namespace comes from the RESOLVER (决策 7), never from the
 * manifest row the row happens to carry. `blob_missing` passes through raw —
 * the download ROUTE composes the user's R3 ruling (blob gone at download ⇒
 * 404 `path_not_found`); the anomaly openings (`invalid_key`/
 * `not_regular_file`) are defensively classified `storage_error` right here.
 */
import { eq } from "drizzle-orm";

import type {
  ArtifactDiffEntry,
  ArtifactDiffResponse,
  ArtifactManifestEntry,
  LoopArtifactsResponse,
  RunArtifactsResponse,
} from "@loopzhb/protocol";

import type { Db } from "../db/index.js";
import { loops, type ArtifactManifestRow, type Loop } from "../db/schema.js";
import { getRun } from "../store/runs.js";
import type { ArtifactAttributionResolver } from "./attribution.js";
import type { BlobStore, BlobStreamChunk } from "./blob-store.js";
import { readCurrentArtifactView } from "./config.js";
import type { ArtifactReadFailure } from "./error-mapping.js";
import { readArtifactSnapshot } from "./sync.js";

/** The narrow dep bag the reads need — a deliberate narrowing of
 *  `ArtifactHomeDeps` (the api factory already holds all three). */
export interface ArtifactReadHome {
  db: Db;
  attribution: ArtifactAttributionResolver;
  blobStore: BlobStore;
}

export type ReadLoopArtifactsResult =
  | { ok: true; response: LoopArtifactsResponse }
  | { ok: false; failure: ArtifactReadFailure; cause?: unknown };

export type ReadRunArtifactsResult =
  | { ok: true; response: RunArtifactsResponse }
  | { ok: false; failure: ArtifactReadFailure; cause?: unknown };

export type ReadDiffResult =
  | { ok: true; response: ArtifactDiffResponse }
  | { ok: false; failure: ArtifactReadFailure; cause?: unknown };

/** The download-open outcome: a STRUCTURED HANDLE, not a stream. The route
 *  owns response composition, the mid-stream pump and abort cleanup (AV4/AV8
 *  live at the HTTP boundary). */
export type OpenArtifactDownloadResult =
  | {
      ok: true;
      stream: { bytes: AsyncIterable<BlobStreamChunk>; size: number; close(): Promise<void> };
      entry: ArtifactManifestEntry;
      manifest: ArtifactManifestRow;
    }
  | { ok: false; failure: ArtifactReadFailure; cause?: unknown };

/** Loop row lookup + per-operation attribution, in the frozen order. The loop
 *  row read IS the identity-discovery step for credential-less management
 *  reads (决策 27). */
type LoopScope =
  | { ok: true; loop: Loop; namespaceId: string }
  | { ok: false; failure: ArtifactReadFailure; cause?: unknown };

async function resolveLoopScope(home: ArtifactReadHome, loopId: string): Promise<LoopScope> {
  const loop = (await home.db.select().from(loops).where(eq(loops.id, loopId)).limit(1))[0];
  if (!loop) return { ok: false, failure: "loop_not_found" };
  const resolved = await home.attribution.resolve({ machineId: loop.machineId });
  if (!resolved.ok) return { ok: false, failure: "attribution_missing" };
  return { ok: true, loop, namespaceId: resolved.namespaceId };
}

/** GET /api/loops/:id/artifacts — the current file view. An unconfigured loop
 *  is NOT an error: the frozen view shape is nullable (the Dashboard renders
 *  the 未配置 state); `artifact_dir_unconfigured` stays a union member with no
 *  slice-7 route returning it (决策 27). */
export async function readLoopArtifactsView(home: ArtifactReadHome, loopId: string): Promise<ReadLoopArtifactsResult> {
  const scope = await resolveLoopScope(home, loopId);
  if (!scope.ok) return scope;
  const view = await readCurrentArtifactView(home.db, loopId);
  // Unreachable (the scope read above just saw the row; PGlite is one
  // connection) — the type still allows it, and the frozen domain has the
  // literal for it.
  if (view === undefined) return { ok: false, failure: "loop_not_found" };
  const manifest = view.manifest;
  return {
    ok: true,
    response: {
      loopId,
      artifactDir: view.artifactDir,
      configRevision: view.configRevision,
      manifestRevision: view.manifestRevision,
      manifestId: view.manifestId,
      committedAt: manifest?.committedAt ?? null,
      stale: view.stale,
      fileCount: manifest?.fileCount ?? 0,
      totalBytes: manifest?.totalBytes ?? 0,
      sync: {
        attemptedAt: scope.loop.artifactSyncAttemptedAt ?? null,
        succeededAt: scope.loop.artifactSyncSucceededAt ?? null,
        error: scope.loop.artifactSyncError ?? null,
      },
      files: manifest?.entries ?? [],
    },
  };
}

/** GET /api/runs/:id/artifacts — the bound snapshot, or the EXPLICIT missing
 *  state. `missing` is frozen to mean "no snapshot was ever bound": a bound
 *  Run whose manifest row vanished out-of-band is a 404 `snapshot_not_found`
 *  (V3 — rewriting a bound Run to missing would fabricate history).
 *
 *  `expectedLoopId` is the NESTED page's parent path (Dashboard). The check
 *  rides the IDENTITY step — right after the run row, BEFORE the loop,
 *  attribution and snapshot resolution (#111 round 2): a mismatched parent
 *  must stay indistinguishable from never-existed on EVERY path, including
 *  the `attribution_missing` failure — otherwise 403-vs-404 under a foreign
 *  parent leaks the run's existence across scopes (决策 13/27). With the
 *  matching parent the failure domain is unchanged; absent (the flat JSON
 *  route) the read is unscoped. */
export async function readRunArtifactsView(
  home: ArtifactReadHome,
  runId: string,
  expectedLoopId?: string,
): Promise<ReadRunArtifactsResult> {
  const run = await getRun(home.db, runId);
  if (!run) return { ok: false, failure: "run_not_found" };
  if (expectedLoopId !== undefined && run.loopId !== expectedLoopId) {
    return { ok: false, failure: "run_not_found" };
  }
  const loop = (await home.db.select().from(loops).where(eq(loops.id, run.loopId)).limit(1))[0];
  if (!loop) return { ok: false, failure: "loop_not_found" }; // defensive: FK makes this unreachable
  const resolved = await home.attribution.resolve({ machineId: loop.machineId });
  if (!resolved.ok) return { ok: false, failure: "attribution_missing" };
  if (run.artifactSnapshotId === null) {
    return { ok: true, response: { runId, loopId: run.loopId, state: "missing" } };
  }
  const manifest = await readArtifactSnapshot(home.db, run.artifactSnapshotId);
  if (!manifest || manifest.loopId !== run.loopId) return { ok: false, failure: "snapshot_not_found" };
  return {
    ok: true,
    response: {
      runId,
      loopId: run.loopId,
      state: "bound",
      snapshotId: manifest.id,
      manifestRevision: manifest.manifestRevision,
      configRevision: manifest.configRevision,
      committedAt: manifest.committedAt,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      files: manifest.entries,
    },
  };
}

/** GET /api/loops/:id/artifacts/download — open the verified blob stream for
 *  one manifest entry. Scope order: loop → attribution → snapshot (cross-loop
 *  stays indistinguishable from never-existed) → path lookup in the manifest
 *  entries table (NEVER a disk-path join). Opening failures: `blob_missing`
 *  passes through raw for the route's R3 composition; anomaly openings map to
 *  `storage_error` at this seam. */
export async function openArtifactDownload(
  home: ArtifactReadHome,
  loopId: string,
  query: { snapshotId: string; path: string },
): Promise<OpenArtifactDownloadResult> {
  const scope = await resolveLoopScope(home, loopId);
  if (!scope.ok) return scope;
  const manifest = await readArtifactSnapshot(home.db, query.snapshotId);
  if (!manifest || manifest.loopId !== loopId) return { ok: false, failure: "snapshot_not_found" };
  const entry = manifest.entries.find((e) => e.path === query.path);
  if (!entry) return { ok: false, failure: "path_not_found" };
  // The namespace comes from the resolver (决策 7), NOT from the row.
  const opened = await home.blobStore.read({ namespaceId: scope.namespaceId, hash: entry.hash });
  if (!opened.ok) {
    // `invalid_key`/`not_regular_file` cannot occur with a resolver-formed
    // namespace and a policy-validated manifest hash — they are anomalies,
    // defensively classified storage_error (never laundered into a re-upload
    // class). `blob_missing` passes through RAW: the download route composes
    // the R3 ruling (404 `path_not_found`).
    const failure: ArtifactReadFailure =
      opened.failure === "invalid_key" || opened.failure === "not_regular_file" ? "storage_error" : opened.failure;
    return { ok: false, failure, cause: opened.cause };
  }
  return { ok: true, stream: opened, entry, manifest };
}

export interface ManifestDiff {
  /** In `after`, not in `before` (full entries). */
  added: ArtifactManifestEntry[];
  /** Same path, different hash — before/after hash+size ONLY (the frozen
   *  shape carries no content). */
  modified: ArtifactDiffEntry[];
  /** In `before`, not in `after` (full entries). */
  removed: ArtifactManifestEntry[];
}

/** Pure structural diff (V1): directional set algebra exactly as passed —
 *  `before = from`, `after = to`. Same-hash entries are UNCHANGED and omitted;
 *  `before = null` is the empty-set baseline (the first-snapshot convention);
 *  `from === to` therefore diffs to empty. */
export function diffManifestEntries(
  before: readonly ArtifactManifestEntry[] | null,
  after: readonly ArtifactManifestEntry[],
): ManifestDiff {
  const beforeByPath = new Map((before ?? []).map((e) => [e.path, e]));
  const added: ArtifactManifestEntry[] = [];
  const modified: ArtifactDiffEntry[] = [];
  for (const entry of after) {
    const prev = beforeByPath.get(entry.path);
    if (prev === undefined) {
      added.push(entry);
    } else if (prev.hash !== entry.hash) {
      modified.push({
        path: entry.path,
        beforeHash: prev.hash,
        beforeSize: prev.size,
        afterHash: entry.hash,
        afterSize: entry.size,
      });
    }
  }
  const afterPaths = new Set(after.map((e) => e.path));
  const removed = (before ?? []).filter((e) => !afterPaths.has(e.path));
  return { added, modified, removed };
}

/** GET /api/loops/:id/artifacts/diff — two snapshots of the SAME loop.
 *  `from` omitted (or empty after route normalization) = empty-set baseline.
 *  A cross-loop `to`/`from` is indistinguishable from never-existed (决策 13). */
export async function diffLoopSnapshots(
  home: ArtifactReadHome,
  loopId: string,
  query: { from?: string; to: string },
): Promise<ReadDiffResult> {
  const scope = await resolveLoopScope(home, loopId);
  if (!scope.ok) return scope;
  const to = await readArtifactSnapshot(home.db, query.to);
  if (!to || to.loopId !== loopId) return { ok: false, failure: "snapshot_not_found" };
  let fromRef: { snapshotId: string; manifestRevision: number } | null = null;
  let before: readonly ArtifactManifestEntry[] | null = null;
  if (query.from !== undefined) {
    const from = await readArtifactSnapshot(home.db, query.from);
    if (!from || from.loopId !== loopId) return { ok: false, failure: "snapshot_not_found" };
    fromRef = { snapshotId: from.id, manifestRevision: from.manifestRevision };
    before = from.entries;
  }
  const diff = diffManifestEntries(before, to.entries);
  return {
    ok: true,
    response: {
      loopId,
      from: fromRef,
      to: { snapshotId: to.id, manifestRevision: to.manifestRevision },
      added: diff.added,
      modified: diff.modified,
      removed: diff.removed,
    },
  };
}
