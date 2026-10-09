/**
 * Blob copy + verification for `claim:legacy` (ADR-011 决策 21). Uses ONLY the
 * three frozen `BlobStore` methods — no interface change, no new primitive.
 *
 * The load-bearing fact this module exists for: `writeVerified` returning
 * `published:false` proves the INCOMING bytes matched the key, and proves
 * nothing about the file already parked at that path — the local adapter never
 * re-reads it. The batch contract requires a pre-existing target to be verified
 * too, so every path that finds a target (before the copy, or discovered by
 * `published:false` after it) runs an INDEPENDENT read-back and recomputes the
 * digest. A corrupt target is a hard refusal, never a silent overwrite: the
 * whole point of the claim is that the history does not change.
 *
 * Nothing here writes a row. A kill at any point leaves published target blobs
 * (allowed to remain, reused and re-verified by the retry) and inert
 * `.tmp-<uuid>` files, which the store already documents as unaddressable.
 */
import type { BlobStore, BlobStreamChunk } from "../artifact/blob-store.js";
import { verifyByteStream } from "../artifact/blob-store-verify.js";

import type { ClaimRefusal } from "./plan.js";

export interface CopyPlanInput {
  teamId: string;
  /** The hashes to copy, in the planner's deterministic order. */
  hashes: readonly string[];
  /** The hashes the planner already found in the target namespace. They are
   *  not re-copied, but they ARE part of the outcome — the operator needs to
   *  know how much of the history was already in place. */
  reuseHashes: readonly string[];
  expectedSize: ReadonlyMap<string, number>;
  sourceNamespaceOf: ReadonlyMap<string, string>;
}

export interface CopyOutcome {
  copied: number;
  copiedBytes: number;
  reused: number;
  reusedBytes: number;
}

export type CopyResult = { ok: true; outcome: CopyOutcome } | { ok: false; refusal: ClaimRefusal };

/**
 * Copy every planned hash into the team namespace, verifying size and SHA-256
 * on BOTH sides. Returns only after every hash has been verified.
 */
export async function copyAndVerifyBlobs(store: BlobStore, plan: CopyPlanInput): Promise<CopyResult> {
  let copied = 0;
  let copiedBytes = 0;
  // Seeded from the planner's classification: a hash already in the target
  // namespace is verified on the spot (a retry re-checks it) and is reuse, not
  // a no-op.
  let reused = 0;
  let reusedBytes = 0;
  for (const hash of plan.reuseHashes) {
    const size = plan.expectedSize.get(hash);
    if (size === undefined) return fail("storage_error", { hash, detail: "plan_incomplete" });
    const verified = await verifyExisting(store, { namespaceId: plan.teamId, hash }, hash, size);
    if (!verified.ok) return verified;
    reused += 1;
    reusedBytes += size;
  }

  for (const hash of plan.hashes) {
    const size = plan.expectedSize.get(hash);
    const sourceNamespace = plan.sourceNamespaceOf.get(hash);
    if (size === undefined || sourceNamespace === undefined) {
      return fail("storage_error", { hash, detail: "plan_incomplete" });
    }

    const target = { namespaceId: plan.teamId, hash };
    const present = await store.has(target);
    if (!present.ok) return fail("storage_error", { hash, detail: present.failure });

    if (present.present) {
      // Left over from a crashed or rolled-back run (or written by a sibling
      // machine of the same team): verify it, never trust the name.
      const verified = await verifyExisting(store, target, hash, size);
      if (!verified.ok) return verified;
      reused += 1;
      reusedBytes += size;
      continue;
    }

    const opened = await store.read({ namespaceId: sourceNamespace, hash });
    if (!opened.ok) {
      if (opened.failure === "blob_missing") return fail("source_blob_missing", { hash, detail: sourceNamespace });
      return fail("storage_error", { hash, detail: opened.failure });
    }
    // The recorded metadata must agree with the file BEFORE we stream it: a
    // disagreement means the source blob row lies about its content.
    if (opened.size !== size) {
      await opened.close();
      return fail("source_blob_corrupt", { hash, detail: "size_mismatch" });
    }

    const written = await store.writeVerified({ namespaceId: plan.teamId, hash, expectedSize: size, bytes: legalBytes(opened.bytes) });
    if (!written.ok) {
      // `content_mismatch`: the source's real bytes disagree with its verified
      // metadata — terminal, never retryable.
      if (written.failure === "content_mismatch") return fail("source_blob_corrupt", { hash, detail: "hash_mismatch" });
      // ENOSPC and friends: the local adapter unlinked its own tmp file, so
      // nothing partial exists and no row was written.
      return fail("storage_error", { hash, detail: written.failure });
    }

    if (!written.published) {
      // The store verified OUR bytes but never read theirs (a race, or a
      // leftover the `has` above missed). Close the hole explicitly.
      const verified = await verifyExisting(store, target, hash, size);
      if (!verified.ok) return verified;
      reused += 1;
      reusedBytes += size;
      continue;
    }

    copied += 1;
    copiedBytes += size;
  }

  return { ok: true, outcome: { copied, copiedBytes, reused, reusedBytes } };
}

/** Read a blob that is already at the target and recompute its digest. */
async function verifyExisting(
  store: BlobStore,
  target: { namespaceId: string; hash: string },
  hash: string,
  expectedSize: number,
): Promise<{ ok: true } | { ok: false; refusal: ClaimRefusal }> {
  const opened = await store.read(target);
  if (!opened.ok) {
    if (opened.failure === "storage_error") return fail("storage_error", { hash, detail: opened.failure });
    return fail("target_blob_corrupt", { hash, detail: opened.failure });
  }
  if (opened.size !== expectedSize) {
    await opened.close();
    return fail("target_blob_corrupt", { hash, detail: "size_mismatch" });
  }

  const verified = await verifyByteStream({
    expectedHash: hash,
    expectedSize,
    bytes: legalBytes(opened.bytes),
  });
  if (verified.ok) return { ok: true };
  if (verified.failure === "content_mismatch") return fail("target_blob_corrupt", { hash, detail: "hash_mismatch" });
  return fail("storage_error", { hash, detail: verified.failure });
}

/**
 * The read stream's failure channel is a terminal `{ok:false}` ELEMENT, not a
 * throw. Turning it into a throw here is deliberate: `verifyByteStream`
 * classifies a thrown source as `storage_error`. Returning instead would let a
 * truncated read look like a digest mismatch and be reported as a CORRUPT SOURCE
 * — a false accusation that would send an operator hunting for disk damage.
 */
async function* legalBytes(chunks: AsyncIterable<BlobStreamChunk>): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) {
    if (!chunk.ok) throw new Error("blob read failed mid-stream", { cause: chunk.cause });
    yield chunk.chunk;
  }
}

function fail(failure: ClaimRefusal["failure"], extra: Omit<ClaimRefusal, "failure">): { ok: false; refusal: ClaimRefusal } {
  return { ok: false, refusal: { failure, ...extra } };
}
