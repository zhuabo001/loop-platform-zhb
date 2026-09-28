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
 *
 * Read is TWO-PHASE (slice-1 review S1): opening failures (`invalid_key`,
 * `blob_missing`, `not_regular_file`, `storage_error`) come back in the
 * `BlobReadResult` union; a storage failure DURING streaming can no longer
 * change that already-returned union, so it surfaces as a terminal
 * `{ok:false, failure:"storage_error"}` STREAM ELEMENT — the iterator never
 * throws for an I/O failure, and a caller classifies mid-stream failures
 * without try/catch.
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

export type BlobPresenceFailure = Extract<BlobStoreFailure, "invalid_key" | "not_regular_file" | "storage_error">;
export type BlobReadFailure = Exclude<BlobStoreFailure, "content_mismatch">;

export type BlobWriteResult =
  /** `size` is the REAL byte count; `published: false` means the blob already
   *  existed — the bytes were verified all the same. */
  | { ok: true; size: number; published: boolean }
  | { ok: false; failure: BlobStoreFailure; cause?: unknown };

export type BlobPresenceResult =
  | { ok: true; present: boolean }
  | { ok: false; failure: BlobPresenceFailure; cause?: unknown };

/** One element of a read stream. A mid-stream storage failure surfaces as a
 *  TERMINAL `{ok:false, failure:"storage_error"}` element — the stream ends
 *  right after it and the iterator never throws for an I/O failure (the
 *  `BlobReadResult` union was already returned and cannot change). Only
 *  `storage_error` can occur mid-stream; the other failures are opening-time. */
export type BlobStreamChunk =
  | { ok: true; chunk: Uint8Array }
  | { ok: false; failure: "storage_error"; cause?: unknown };

export type BlobReadResult =
  | { ok: true; bytes: AsyncIterable<BlobStreamChunk>; size: number }
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
   * "the store is broken" (`storage_error`). A symlink or special file parked
   * at the blob path is an ANOMALY, not an absence: classify it
   * `not_regular_file` (slice-1 review S1) — never report it as a clean
   * `present: false`, which would route it onto the re-upload path.
   */
  has(key: BlobKey): Promise<BlobPresenceResult>;

  /**
   * Read a published blob as a byte stream with its real size. Two-phase
   * failure channel: failures while OPENING the blob come back in this
   * union; a failure WHILE STREAMING arrives as a terminal
   * `{ok:false, failure:"storage_error"}` stream element (see
   * `BlobStreamChunk`) — the iterator never throws for an I/O failure.
   */
  read(key: BlobKey): Promise<BlobReadResult>;
}
