/**
 * Artifact read-side views: the LOCAL management wire shapes for the current
 * file view, Run snapshots, downloads and structural diffs (Batch 2 plan §1).
 *
 * Declared, NOT opened (ADR-002 决策 6): Batch 2 slice 1 freezes these shapes;
 * the read routes and Dashboard pages mount in slice 7. Every schema here is
 * a tolerant reader, and NO schema carries a storage namespace — attribution
 * is derived server-side and never named on the wire (ADR-010 决策 7).
 *
 * Downloads never map a URL path to a disk path: the download query carries a
 * snapshot id + a manifest path, and the server resolves the blob through the
 * manifest lookup only (plan §1). These shapes pin field names and null
 * conventions only; value domains (hash/size) stay in shared policy, mirroring
 * artifact.ts.
 */
import { z } from "zod";

import { artifactManifestEntrySchema } from "./artifact.js";

/** The loop's last sync-attempt state as the dashboard renders it. `error`
 *  carries a value from ARTIFACT_SYNC_STATE_ERRORS (wire codes + client
 *  failure classes) — shape-only here, the domain is server state. */
export const artifactSyncStatusSchema = z.object({
  attemptedAt: z.string().nullable(),
  succeededAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ArtifactSyncStatus = z.infer<typeof artifactSyncStatusSchema>;

/** GET /api/loops/:id/artifacts — the current file view plus its sync status.
 *  `stale` = the pointer's config generation is older than the loop's current
 *  one (ADR-010 决策 8); the view stays served, marked stale. */
export const loopArtifactsResponseSchema = z.object({
  loopId: z.string(),
  artifactDir: z.string().nullable(),
  configRevision: z.number().int().nonnegative(),
  manifestRevision: z.number().int().nonnegative(),
  manifestId: z.string().nullable(),
  committedAt: z.string().nullable(),
  stale: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  sync: artifactSyncStatusSchema,
  files: z.array(artifactManifestEntrySchema),
});
export type LoopArtifactsResponse = z.infer<typeof loopArtifactsResponseSchema>;

/** A committed snapshot reference: the immutable manifest id + its revision. */
export const artifactSnapshotRefSchema = z.object({
  snapshotId: z.string(),
  manifestRevision: z.number().int().nonnegative(),
});
export type ArtifactSnapshotRef = z.infer<typeof artifactSnapshotRefSchema>;

/** GET /api/runs/:id/artifacts — the Run's bound snapshot. */
export const runArtifactsBoundSchema = z.object({
  runId: z.string(),
  loopId: z.string(),
  state: z.literal("bound"),
  snapshotId: z.string(),
  manifestRevision: z.number().int().nonnegative(),
  configRevision: z.number().int().nonnegative(),
  committedAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(artifactManifestEntrySchema),
});

/** GET /api/runs/:id/artifacts — no snapshot was bound. An EXPLICIT missing
 *  state (never an implicit empty file list): later idle syncs only update
 *  the loop's current view and can never fabricate this Run's history. */
export const runArtifactsMissingSchema = z.object({
  runId: z.string(),
  loopId: z.string(),
  state: z.literal("missing"),
});

export const runArtifactsResponseSchema = z.discriminatedUnion("state", [
  runArtifactsBoundSchema,
  runArtifactsMissingSchema,
]);
export type RunArtifactsResponse = z.infer<typeof runArtifactsResponseSchema>;

/** GET /api/loops/:id/artifacts/download — snapshot id + manifest path. The
 *  server resolves the blob through the manifest lookup ONLY; the path is
 *  never joined to a disk path (plan §1). */
export const artifactDownloadQuerySchema = z.object({
  snapshotId: z.string(),
  path: z.string(),
});
export type ArtifactDownloadQuery = z.infer<typeof artifactDownloadQuerySchema>;

/** GET /api/loops/:id/artifacts/diff — `to` is required; an omitted `from`
 *  compares against the EMPTY set (the first-snapshot baseline convention). */
export const artifactDiffQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string(),
});
export type ArtifactDiffQuery = z.infer<typeof artifactDiffQuerySchema>;

/** One modified path: before/after hash + size ONLY — this version carries no
 *  content preview and no text diff (plan §1). `size` stays a typeof-number
 *  check (never `z.number()`), mirroring artifact.ts 决策 2. */
export const artifactDiffEntrySchema = z.object({
  path: z.string(),
  beforeHash: z.string(),
  beforeSize: z.custom<number>((value) => typeof value === "number"),
  afterHash: z.string(),
  afterSize: z.custom<number>((value) => typeof value === "number"),
});
export type ArtifactDiffEntry = z.infer<typeof artifactDiffEntrySchema>;

export const artifactDiffResponseSchema = z.object({
  loopId: z.string(),
  /** null = compared against the empty set (an omitted `from`). */
  from: artifactSnapshotRefSchema.nullable(),
  to: artifactSnapshotRefSchema,
  added: z.array(artifactManifestEntrySchema),
  modified: z.array(artifactDiffEntrySchema),
  removed: z.array(artifactManifestEntrySchema),
});
export type ArtifactDiffResponse = z.infer<typeof artifactDiffResponseSchema>;
