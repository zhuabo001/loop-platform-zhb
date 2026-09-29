/**
 * In-memory BlobStore adapter (ADR-010 决策 14, Phase 5 Batch 1 slice 3) —
 * the test double that runs the ONE shared contract suite alongside the
 * local-file adapter (src/testkit/blob-store-contract.ts). Byte storage is a
 * Map keyed by the serialized storage key; the verification pipeline is the
 * SHARED `verifyByteStream`, so failure classification can never drift from
 * the local adapter (AB10 dual-adapter parity).
 *
 * The two on-disk shapes with no in-memory physical analog are modeled by
 * the TEST-ONLY fault sets: `notRegularKeys` parks an anomaly at a key (the
 * symlink/special-file case — #66(b)) and `failReadAfterChunks` injects a
 * mid-stream storage failure (the S1 two-phase read channel — #66(a)).
 *
 * Batch 1 wires this module from TESTS ONLY — no production composition
 * (决策 16).
 */
import { ARTIFACT_HASH_RE } from "@loopzhb/protocol";

import {
  NAMESPACE_ID_RE,
  type BlobKey,
  type BlobPresenceResult,
  type BlobReadResult,
  type BlobStore,
  type BlobStreamChunk,
  type BlobWriteResult,
} from "./blob-store.js";
import { verifyByteStream } from "./blob-store-verify.js";

export interface MemoryBlobStoreFaults {
  /** TEST-ONLY: a serialized key (`${namespaceId}/${hash}`) in this set is
   *  parked with an anomaly — has/read/write classify it `not_regular_file`,
   *  mirroring a symlink parked at the local adapter's blob path. */
  notRegularKeys?: Set<string>;
  /** TEST-ONLY: a read of a key in this map yields the stored bytes in
   *  chunks and then the terminal `storage_error` element after the given
   *  number of chunks — the mid-read I/O failure (slice-1 review S1). */
  failReadAfterChunks?: Map<string, number>;
}

function keyString(key: BlobKey): string {
  return `${key.namespaceId}/${key.hash}`;
}

function isValidKey(key: BlobKey): boolean {
  return NAMESPACE_ID_RE.test(key.namespaceId) && ARTIFACT_HASH_RE.test(key.hash);
}

/** The stored bytes as a 64 KiB-chunked stream of COPIES (a stored blob must
 *  be immune to consumers mutating the chunks they received). A key armed in
 *  `failReadAfterChunks` yields the terminal storage_error element once the
 *  trip count is reached — an armed stream never completes cleanly, even
 *  when the trip count exceeds the real chunk count (a failure can
 *  physically arrive at end-of-stream). */
async function* streamStored(
  bytes: Uint8Array,
  failAfterChunks: number | undefined,
): AsyncIterable<BlobStreamChunk> {
  const CHUNK = 64 * 1024;
  let emitted = 0;
  for (let off = 0; off < bytes.byteLength; off += CHUNK) {
    yield { ok: true, chunk: bytes.slice(off, off + CHUNK) };
    emitted += 1;
    if (failAfterChunks !== undefined && emitted >= failAfterChunks) {
      yield { ok: false, failure: "storage_error", cause: new Error("injected mid-read failure") };
      return;
    }
  }
  if (failAfterChunks !== undefined) {
    yield { ok: false, failure: "storage_error", cause: new Error("injected mid-read failure") };
  }
}

export function createMemoryBlobStore(options?: { faults?: MemoryBlobStoreFaults }): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  const notRegular = options?.faults?.notRegularKeys ?? new Set<string>();
  const failReadAfter = options?.faults?.failReadAfterChunks ?? new Map<string, number>();

  return {
    async writeVerified(input): Promise<BlobWriteResult> {
      if (!isValidKey(input)) return { ok: false, failure: "invalid_key" };
      const collected: Uint8Array[] = [];
      const verified = await verifyByteStream({
        expectedHash: input.hash,
        expectedSize: input.expectedSize,
        bytes: input.bytes,
        onChunk: async (chunk) => {
          collected.push(chunk);
        },
      });
      if (!verified.ok) return verified;
      // The anomaly refusal comes AFTER byte verification — the local
      // adapter's publish order (EEXIST ⇒ lstat ⇒ not_regular_file), so the
      // shared suite's write case classifies identically on both adapters.
      const k = keyString(input);
      if (notRegular.has(k)) return { ok: false, failure: "not_regular_file" };
      // `published` honesty invariant: the has-check + set below are a
      // SYNCHRONOUS critical section — no await between them, so two
      // concurrent same-key writes cannot both observe absence (JS is
      // single-threaded here). Never introduce an await into this section.
      const published = !blobs.has(k);
      // Copy on store: the caller may reuse its source buffers — a stored
      // blob must be immune to later mutation.
      const bytes = new Uint8Array(verified.size);
      let off = 0;
      for (const c of collected) {
        bytes.set(c, off);
        off += c.byteLength;
      }
      blobs.set(k, bytes);
      return { ok: true, size: verified.size, published };
    },

    async has(key): Promise<BlobPresenceResult> {
      if (!isValidKey(key)) return { ok: false, failure: "invalid_key" };
      const k = keyString(key);
      if (notRegular.has(k)) return { ok: false, failure: "not_regular_file" };
      return { ok: true, present: blobs.has(k) };
    },

    async read(key): Promise<BlobReadResult> {
      if (!isValidKey(key)) return { ok: false, failure: "invalid_key" };
      const k = keyString(key);
      if (notRegular.has(k)) return { ok: false, failure: "not_regular_file" };
      const bytes = blobs.get(k);
      if (bytes === undefined) return { ok: false, failure: "blob_missing" };
      return { ok: true, size: bytes.byteLength, bytes: streamStored(bytes, failReadAfter.get(k)) };
    },
  };
}
