/**
 * BlobStore — the server-internal blob storage contract for artifact sync
 * (ADR-010 决策 14). FROZEN in Batch 1 slice 1: the interface and its behavior
 * contract only — the in-memory and local-file adapters land in slice 3 and
 * share one contract test. This batch ships NO deletion and NO historical GC.
 *
 * Failures are RESULT UNIONS, not thrown errors: content mismatches and
 * missing blobs are expected domain outcomes of the prepare/PUT/commit flow
 * (ArtifactHome returns stable result unions per the batch plan §3), so every
 * failure a caller must branch on is typed here. `storage_error` may carry a
 * `cause` — log material only, it never reaches the wire.
 */

/** The safe storage-key shapes. `NAMESPACE_ID_RE` is server-internal (wire
 *  input never carries a namespace — the attribution resolver is its only
 *  source); the hash side reuses `ARTIFACT_HASH_RE` from @loopzhb/protocol so
 *  wire and store can never disagree. */
export const NAMESPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type BlobKey = { namespaceId: string; hash: string };

export type BlobStoreFailure =
  /** namespaceId/hash fail the safe storage-key shape (traversal guard). */
  | "invalid_key"
  /** The REAL byte count or SHA-256 differs from the negotiated one — a
   *  stream running past `expectedSize` short-circuits here. */
  | "content_mismatch"
  /** The target does not exist (has/read). */
  | "blob_missing"
  /** The on-disk target is a symlink or a special file — refused. */
  | "not_regular_file"
  /** Any other I/O failure. */
  | "storage_error";

export type BlobPresenceFailure = Extract<BlobStoreFailure, "invalid_key" | "storage_error">;
export type BlobReadFailure = Exclude<BlobStoreFailure, "content_mismatch">;

export type BlobWriteResult =
  /** `size` is the REAL byte count; `published: false` means the blob already
   *  existed — the bytes were verified all the same. */
  | { ok: true; size: number; published: boolean }
  | { ok: false; failure: BlobStoreFailure; cause?: unknown };

export type BlobPresenceResult =
  | { ok: true; present: boolean }
  | { ok: false; failure: BlobPresenceFailure; cause?: unknown };

export type BlobReadResult =
  | { ok: true; bytes: AsyncIterable<Uint8Array>; size: number }
  | { ok: false; failure: BlobReadFailure; cause?: unknown };

export interface BlobStore {
  /**
   * Verified write. The byte stream is the ONLY source of truth: count the
   * real bytes and compute the real SHA-256 while streaming; declared sizes
   * and Content-Length are never trusted. A stream that runs past
   * `expectedSize` short-circuits to `content_mismatch`. On a byte-exact hash
   * match the content lands in an EXCLUSIVE temporary file inside the target
   * filesystem, is fsynced, and is atomically published — a concurrent or
   * repeated upload of the same key still verifies its bytes and never
   * exposes a half-written file. Only after the publish succeeds may the
   * caller record the blob metadata.
   *
   * `bytes` is an AsyncIterable (neutral across node Readable, web streams
   * and test arrays). Symlinks and non-regular files are refused
   * (`not_regular_file`). No deletion, no GC in this batch.
   */
  writeVerified(input: BlobKey & { expectedSize: number; bytes: AsyncIterable<Uint8Array> }): Promise<BlobWriteResult>;

  /**
   * Existence check. Storage failures are NOT swallowed into "missing":
   * commit must tell "upload it again" (`blob_missing` → resume) apart from
   * "the store is broken" (`storage_error`).
   */
  has(key: BlobKey): Promise<BlobPresenceResult>;

  /** Read a published blob as a byte stream with its real size. */
  read(key: BlobKey): Promise<BlobReadResult>;
}
