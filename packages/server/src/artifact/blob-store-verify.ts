/**
 * verifyByteStream — the streaming verification pipeline SHARED by the two
 * BlobStore adapters (ADR-010 决策 14, Phase 5 Batch 1 slice 3): pure
 * computation over the byte stream plus an injected per-chunk sink (the
 * local adapter streams into its exclusive tmp file; the memory adapter
 * collects). Sharing this one pipeline is the construction-level guarantee
 * that both adapters classify identically (AB10 dual-adapter parity).
 *
 * The byte stream is the ONLY source of truth — declared sizes and
 * Content-Length are never trusted. Fixed evaluation order:
 *   1. expectedSize domain: a non-safe-integer, negative, or over-CAP
 *      declaration can never match real bytes ⇒ `content_mismatch`, and the
 *      source is NOT pulled at all (defense in depth against a broken or
 *      malicious internal caller flooding the disk).
 *   2. Per chunk: an overrun (`count + len > expectedSize`) short-circuits
 *      to `content_mismatch` BEFORE the sink/hash — deterministic even when
 *      the source would throw next. Breaking the for-await cancels the
 *      source through its `return()` (a Batch 2 request-body stream gets
 *      destroyed).
 *   3. The source THROWING mid-iteration ⇒ `storage_error`: the byte stream
 *      IS I/O from the store's view (in Batch 2 it is the HTTP request
 *      body), and the wire retry class of `artifact_storage_error` is
 *      idempotent_retry — classifying a transient transport failure as
 *      `content_mismatch` (terminal) would permafrost it.
 *   4. Clean EOF short of expectedSize ⇒ `content_mismatch` (retrying the
 *      same bytes fails identically — terminal).
 *   5. Digest mismatch ⇒ `content_mismatch`.
 */
import { createHash } from "node:crypto";

import { ARTIFACT_FILE_MAX_BYTES } from "@loopzhb/protocol";

export type VerifiedStream =
  | { ok: true; size: number; digestHex: string }
  | { ok: false; failure: "content_mismatch" | "storage_error"; cause?: unknown };

/** The expectedSize domain: a safe integer within 0..ARTIFACT_FILE_MAX_BYTES.
 *  Adapters may check this BEFORE any fs side effect; verifyByteStream
 *  always re-checks it internally (zero source pulls on rejection). */
export function isLegalExpectedSize(expectedSize: number): boolean {
  return Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize <= ARTIFACT_FILE_MAX_BYTES;
}

export async function verifyByteStream(input: {
  expectedHash: string;
  expectedSize: number;
  bytes: AsyncIterable<Uint8Array>;
  /** Per-chunk sink (local: write the exclusive tmp file; memory: collect).
   *  A throw aborts the write and classifies `storage_error`. */
  onChunk?: (chunk: Uint8Array) => Promise<void>;
}): Promise<VerifiedStream> {
  const { expectedHash, expectedSize, bytes, onChunk } = input;
  if (!isLegalExpectedSize(expectedSize)) {
    return { ok: false, failure: "content_mismatch" };
  }
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of bytes) {
      if (size + chunk.byteLength > expectedSize) {
        // Deterministic short-circuit: the overrun is observed before any
        // source error could surface, and breaking the for-await cancels the
        // source via its `return()`.
        return { ok: false, failure: "content_mismatch" };
      }
      if (onChunk) await onChunk(chunk);
      hash.update(chunk);
      size += chunk.byteLength;
    }
  } catch (cause) {
    return { ok: false, failure: "storage_error", cause };
  }
  if (size !== expectedSize) return { ok: false, failure: "content_mismatch" };
  const digestHex = hash.digest("hex");
  if (digestHex !== expectedHash) return { ok: false, failure: "content_mismatch" };
  return { ok: true, size, digestHex };
}
