/**
 * Artifact sync: the Phase 5 WIRE shapes for the artifact-sync-v1 three-step
 * sync (prepare → PUT → commit) and its error taxonomy (ADR-010).
 *
 * Declared, NOT opened (ADR-002 决策 6): Batch 1 mounts no route that consumes
 * these DTOs — the shapes freeze here so the ArtifactHome state machine
 * (Batch 1) and the watcher/HTTP adapters (Batch 2) build against a stable
 * contract. 镜像形状 ≠ 已支持语义.
 *
 * Shape only — value domains are deliberately NOT pinned at the schema layer
 * (hash stays `z.string()`, size is a TYPEOF-number check). The same manifest
 * must validate identically on the daemon (local pre-classification) and on
 * the server (defensive layer) with ONE failure-classification path, and that
 * value policy lives in artifact-policy.ts (ADR-002 决策 4 的窄例外). A
 * schema-level regex would hand the same defect two different classifications
 * (a zod issue vs a policy failure). So would `z.number()`: Zod 4 rejects
 * non-finite numbers at the schema layer, so a wire `1e400` (JSON-parses to
 * Infinity) would die as a zod issue on the server while the daemon's direct
 * policy call classifies it `size_invalid` (slice-1 review A1). Same
 * discipline as tokens.ts: shape filtering is mint/write-side only, never
 * reader-side.
 */
import { z } from "zod";

// ---- manifest entries ----

/** One manifest entry: `{path, hash, size}` SHAPE only. The value rules
 *  (canonical POSIX relative path, 64-hex lowercase SHA-256, non-negative
 *  safe integer, per-file and aggregate caps, never-sync, duplicate/conflict
 *  rejection) are shared policy — see artifact-policy.ts. */
export const artifactManifestEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  /** typeof-number ONLY — never `z.number()`: Zod 4 rejects non-finite
   *  numbers, which would fork the failure classification (a zod issue on the
   *  server's schema→policy path vs `size_invalid` from the daemon's direct
   *  policy call). Infinity/NaN pass here and are classified ONCE, by
   *  artifact-policy's `size_invalid` (slice-1 review A1). */
  size: z.custom<number>((value) => typeof value === "number"),
});
export type ArtifactManifestEntry = z.infer<typeof artifactManifestEntrySchema>;

// ---- watch configuration (rides the poll response) ----

/** One loop's artifact-watch configuration as the daemon's watcher needs it
 *  (Batch 2). `workdir` is the loop's machine-side cwd (null ⇒ daemon scratch
 *  dir); `roots` are the effective server-side jail roots; `configRevision`
 *  is the artifact config generation this watch is bound to. */
export const artifactWatchItemSchema = z.object({
  loopId: z.string(),
  artifactDir: z.string(),
  workdir: z.string().nullable(),
  roots: z.array(z.string()),
  configRevision: z.number().int().nonnegative(),
});
export type ArtifactWatchItem = z.infer<typeof artifactWatchItemSchema>;

// ---- prepare (POST /api/machine/sync — the route mounts in Batch 2) ----

export const prepareArtifactSyncRequestSchema = z.object({
  /** Client idempotency key: with the trusted attribution it forms the
   *  session unique key (namespaceId, machineId, requestId). It is the
   *  idempotency KEY — NOT part of the canonical payload fingerprint. */
  requestId: z.string(),
  loopId: z.string(),
  /** The artifact config generation this manifest targets. */
  configRevision: z.number().int().nonnegative(),
  /** The manifest revision this sync is based on; 0 = no base (first sync),
   *  aligned with the Loop column default. */
  baseManifestRevision: z.number().int().nonnegative(),
  /** The CURRENT COMPLETE manifest — never a delta. Any illegal, oversize or
   *  never-sync entry rejects the WHOLE manifest (artifact-policy.ts). */
  entries: z.array(artifactManifestEntrySchema),
});
export type PrepareArtifactSyncRequest = z.infer<typeof prepareArtifactSyncRequestSchema>;

export const prepareArtifactSyncResponseSchema = z.object({
  syncId: z.string(),
  /** The negotiated hashes the server still needs. Upload content dedupes by
   *  hash; manifest capacity still counts every path separately. */
  needHashes: z.array(z.string()),
  /** Pending-session expiry (ISO-8601 UTC). OPAQUE to the reader — no
   *  datetime refinement (shape filtering is write-side only, ADR-002). */
  expiresAt: z.string(),
});
export type PrepareArtifactSyncResponse = z.infer<typeof prepareArtifactSyncResponseSchema>;

// ---- PUT (PUT /api/machine/blob/:hash — the route mounts in Batch 2) ----

/** The header carrying the sync session id on blob PUTs. */
export const ARTIFACT_SYNC_ID_HEADER = "X-Artifact-Sync-Id";

// ---- commit (POST /api/machine/sync/:id/commit — the route mounts in Batch 2) ----

export const commitArtifactSyncResponseSchema = z.object({
  /** The immutable manifest id — doubles as a Run's `artifactSnapshotId`.
   *  Minted by the server's ID factory, NOT content-addressed: two sessions
   *  committing identical content still produce distinct snapshots. */
  artifactSnapshotId: z.string(),
  manifestRevision: z.number().int().nonnegative(),
});
export type CommitArtifactSyncResponse = z.infer<typeof commitArtifactSyncResponseSchema>;

// ---- error taxonomy (ADR-010 决策 13) ----

/** The stable wire codes for artifact sync failures. Error bodies ride the
 *  shared `apiErrorSchema` `{error, code?}` — the error TEXT is not a machine
 *  contract, these codes are. `artifact_attribution_missing` sits ahead of
 *  all session logic (no valid trusted attribution ⇒ no operation at all);
 *  it is frozen now so the state machine never invents it ad hoc. */
export const ARTIFACT_ERROR_CODES = [
  "artifact_validation_failed",
  "artifact_config_conflict",
  "artifact_manifest_conflict",
  "artifact_session_expired",
  "artifact_hash_not_negotiated",
  "artifact_content_mismatch",
  "artifact_blob_missing",
  "artifact_storage_error",
  "artifact_attribution_missing",
] as const;
export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[number];

/** How a daemon may react to a failure (Batch 2 branches on this):
 *  - `idempotent_retry`: safe to retry the identical request (bounded backoff)
 *  - `resume`: upload the missing blob(s), then retry the identical commit
 *  - `renegotiate`: restart from prepare with fresh config/base revisions
 *  - `terminal`: the identical request always fails — fix the cause first */
export const ARTIFACT_ERROR_RETRY_CLASSES = ["idempotent_retry", "resume", "renegotiate", "terminal"] as const;
export type ArtifactErrorRetryClass = (typeof ARTIFACT_ERROR_RETRY_CLASSES)[number];

/** code → retry class. Exhaustive by construction; the test pins every entry
 *  verbatim. The internal fine-grained policy failure literals
 *  (artifact-policy.ts) map onto these codes — two layers, mirroring the
 *  RunCapabilityInvalidError precedent (internal reasons → one wire code). */
export const ARTIFACT_ERROR_RETRY_CLASS: Readonly<Record<ArtifactErrorCode, ArtifactErrorRetryClass>> = {
  artifact_validation_failed: "terminal",
  artifact_config_conflict: "renegotiate",
  artifact_manifest_conflict: "renegotiate",
  artifact_session_expired: "renegotiate",
  artifact_hash_not_negotiated: "renegotiate",
  artifact_content_mismatch: "terminal",
  artifact_blob_missing: "resume",
  artifact_storage_error: "idempotent_retry",
  artifact_attribution_missing: "terminal",
};
