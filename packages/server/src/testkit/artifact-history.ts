/**
 * Artifact-history fixtures — TEST-ONLY (excluded from the build alongside the
 * rest of `src/testkit/**`).
 *
 * The claim tests need a REAL history on disk, not rows that merely look like
 * one: the CLI streams bytes through the production `LocalBlobStore` and
 * verifies SHA-256 on both sides, so a fixture that fakes the file layout would
 * test nothing. Everything here therefore writes through the real store (and
 * the raw-fs helpers exist only for the damage cases a store write can never
 * produce).
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { ArtifactManifestEntry } from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";

import type { BlobStore } from "../artifact/blob-store.js";
import { artifactBlobRoot } from "../artifact/production.js";
import type { Db } from "../db/index.js";
import {
  artifactBlobs,
  artifactManifests,
  artifactSyncSessions,
  type NewArtifactManifest,
  type NewArtifactSyncSession,
} from "../db/schema.js";

/** A local copy of `FIXTURE_T0` DELIBERATELY: importing it from `index.js`
 *  would make this module and the testkit barrel mutually dependent, and a
 *  cycle that happens to work today (the binding is only read inside
 *  functions) breaks the day someone reads it at module top level. */
const T0_ISO = "2026-07-29T00:00:00.000Z";

/** Content-addressed bytes: the hash IS the sha256 of the UTF-8 bytes, so the
 *  fixture satisfies ARTIFACT_HASH_RE and the store's own verification. */
export function makeArtifactBlob(text: string): { bytes: Uint8Array; hash: string; size: number } {
  const bytes = new TextEncoder().encode(text);
  return { bytes, hash: sha256(text), size: bytes.length };
}

/** `<dataDir>/blobs/<namespaceId>/<hash>` — the production layout. */
export function artifactBlobPath(dataDir: string, namespaceId: string, hash: string): string {
  return path.join(artifactBlobRoot(dataDir), namespaceId, hash);
}

/**
 * A verified blob: the file written through the real store plus its metadata
 * row. `rowSize` is the escape hatch for a LYING row (the file is fine, the
 * metadata disagrees) — a state only damage produces in production.
 */
export async function seedArtifactBlob(
  db: Db,
  store: BlobStore,
  input: {
    namespaceId: string;
    bytes: Uint8Array;
    hash?: string;
    rowSize?: number;
    /** false ⇒ row only, no file (the "lost out of band" shape). */
    writeFile?: boolean;
    verifiedAt?: string;
  },
): Promise<{ hash: string; size: number }> {
  const hash = input.hash ?? sha256(new TextDecoder().decode(input.bytes));
  const size = input.bytes.length;
  if (input.writeFile !== false) {
    const written = await store.writeVerified({
      namespaceId: input.namespaceId,
      hash,
      expectedSize: size,
      bytes: singleChunk(input.bytes),
    });
    if (!written.ok) throw new Error(`seedArtifactBlob: writeVerified failed: ${written.failure}`);
  }
  await db.insert(artifactBlobs).values({
    namespaceId: input.namespaceId,
    hash,
    size: input.rowSize ?? size,
    verifiedAt: input.verifiedAt ?? T0_ISO,
  });
  return { hash, size };
}

/** Write bytes at a blob path WITHOUT verification — the only way to plant a
 *  corrupt file under a valid hash name (disk damage simulation). */
export async function plantRawBlobFile(dataDir: string, namespaceId: string, hash: string, bytes: Uint8Array): Promise<void> {
  const target = artifactBlobPath(dataDir, namespaceId, hash);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

/** Remove a blob file, keeping its metadata row. */
export async function unlinkArtifactBlobFile(dataDir: string, namespaceId: string, hash: string): Promise<void> {
  await fs.rm(artifactBlobPath(dataDir, namespaceId, hash), { force: true });
}

/** The `BlobStore` input convention: an async iterable, never a bare array. */
async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** A committed manifest. `fileCount`/`totalBytes` derive from `entries` unless
 *  the caller states them explicitly — stating them is how the chain-check
 *  tests build a manifest that contradicts itself. */
export async function seedArtifactManifest(
  db: Db,
  values: Partial<NewArtifactManifest> & { id: string; namespaceId: string; machineId: string; loopId: string },
): Promise<void> {
  const entries: ArtifactManifestEntry[] = values.entries ?? [];
  await db.insert(artifactManifests).values({
    id: values.id,
    namespaceId: values.namespaceId,
    machineId: values.machineId,
    loopId: values.loopId,
    configRevision: values.configRevision ?? 1,
    manifestRevision: values.manifestRevision ?? 1,
    entries,
    fileCount: values.fileCount ?? entries.length,
    totalBytes: values.totalBytes ?? entries.reduce((sum, entry) => sum + entry.size, 0),
    committedAt: values.committedAt ?? T0_ISO,
  });
}

/** A sync session. `receipt: null` (the default) means PENDING; a receipt makes
 *  it committed, which is what the post-claim replay assertion needs. */
export async function seedArtifactSyncSession(
  db: Db,
  values: Partial<NewArtifactSyncSession> & { id: string; namespaceId: string; machineId: string; loopId: string },
): Promise<void> {
  const id = values.id;
  await db.insert(artifactSyncSessions).values({
    id,
    namespaceId: values.namespaceId,
    machineId: values.machineId,
    loopId: values.loopId,
    requestId: values.requestId ?? `req-${id}`,
    configRevision: values.configRevision ?? 1,
    baseManifestRevision: values.baseManifestRevision ?? 0,
    normalizedManifest: values.normalizedManifest ?? [],
    payloadFingerprint: values.payloadFingerprint ?? `fp-${id}`,
    negotiatedHashes: values.negotiatedHashes ?? [],
    createdAt: values.createdAt ?? T0_ISO,
    expiresAt: values.expiresAt ?? new Date(Date.parse(T0_ISO) + 60 * 60 * 1000).toISOString(),
    receipt: values.receipt ?? null,
  });
}
