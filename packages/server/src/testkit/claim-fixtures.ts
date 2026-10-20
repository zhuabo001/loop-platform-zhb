/**
 * Shared fixtures for the Phase 5 Batch 3 slice 4 claim tests — TEST-ONLY
 * (excluded from the build with the rest of `src/testkit/**`).
 *
 * Both claim e2e files need the same three things: a data dir with a logged-in
 * target account and unclaimed machines, a real on-disk Artifact history, and
 * a way to invoke the CLI the way an operator would (through `runClaimLegacy`,
 * never through the built entry point). They live here so neither test file
 * imports the other.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BlobStore } from "../artifact/blob-store.js";
import { updateArtifactConfig } from "../artifact/config.js";
import { artifactBlobRoot } from "../artifact/production.js";
import { runClaimLegacy, type ClaimDeps } from "../claim/legacy.js";
import type { Db } from "../db/index.js";
import { loops } from "../db/schema.js";
import { eq } from "drizzle-orm";

import { makeArtifactBlob, seedArtifactBlob, seedArtifactManifest, seedArtifactSyncSession } from "./artifact-history.js";
import { FakeClock, seedLoop, seedMachineForToken, seedPersonalIdentity, seedRun, snapshotBusinessState, snapshotIdentityState } from "./index.js";

export const CLAIM_USER_ID = "424242";
export const CLAIM_TOKEN_A = "dk_legacy_machine_a";
export const CLAIM_TOKEN_B = "dk_legacy_machine_b";
export const CLAIM_LOOP_ID = "loop-1";

export interface ClaimBase {
  dataDir: string;
  machineIds: string[];
  teamId: string;
  userId: string;
}

export async function makeClaimDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `loopzhb-claim-${process.pid}-`));
}

/** The logged-in target account plus N UNCLAIMED machines (and one configured
 *  loop per machine, so the artifact layer has something to sync against). */
export async function seedClaimBase(db: Db, tokens: readonly string[]): Promise<Omit<ClaimBase, "dataDir">> {
  const identity = await seedPersonalIdentity(db, { githubUserId: CLAIM_USER_ID, username: "tester" });
  const machineIds: string[] = [];
  for (const token of tokens) machineIds.push(await seedMachineForToken(db, token));
  const clock = new FakeClock();
  for (const [index, machineId] of machineIds.entries()) {
    const loopId = index === 0 ? CLAIM_LOOP_ID : `${CLAIM_LOOP_ID}-${index}`;
    await seedLoop(db, { id: loopId, machineId });
    await updateArtifactConfig({ db, clock }, loopId, { artifactDir: "/data/out" });
  }
  return { machineIds, teamId: identity.teamId, userId: identity.userId };
}

export interface ClaimHistory {
  blobs: { hash: string; size: number; text: string }[];
  entries: { path: string; hash: string; size: number }[];
  manifestId: string;
  receipt: { artifactSnapshotId: string; manifestRevision: number };
}

/**
 * A real on-disk history for one machine: three verified blobs (two referenced
 * by the manifest, the third reachable only through a still-pending session), a
 * committed manifest, one committed and one pending session, and a terminal Run
 * bound to the manifest.
 */
export async function seedClaimHistory(
  db: Db,
  store: BlobStore,
  machineId: string,
  loopId: string = CLAIM_LOOP_ID,
  texts: readonly string[] = ["alpha", "beta", "gamma"],
): Promise<ClaimHistory> {
  const blobs: ClaimHistory["blobs"] = [];
  for (const text of texts) {
    const blob = makeArtifactBlob(text);
    await seedArtifactBlob(db, store, { namespaceId: machineId, bytes: blob.bytes, hash: blob.hash });
    blobs.push({ hash: blob.hash, size: blob.size, text });
  }
  const entries = blobs.slice(0, 2).map((b) => ({ path: `${b.text}.txt`, hash: b.hash, size: b.size }));
  const manifestId = `amf-${machineId}`;
  await seedArtifactManifest(db, { id: manifestId, namespaceId: machineId, machineId, loopId, entries });
  // A committed manifest implies the loop's cursor moved with it; a fixture
  // that commits a snapshot without advancing the loop is a world the chain
  // check is right to distrust.
  await db.update(loops).set({ artifactManifestId: manifestId, artifactManifestRevision: 1 }).where(eq(loops.id, loopId));
  const receipt = { artifactSnapshotId: manifestId, manifestRevision: 1 };
  await seedArtifactSyncSession(db, {
    id: `sync-committed-${machineId}`,
    namespaceId: machineId,
    machineId,
    loopId,
    negotiatedHashes: entries.map((e) => e.hash),
    normalizedManifest: entries,
    receipt,
  });
  await seedArtifactSyncSession(db, {
    id: `sync-pending-${machineId}`,
    namespaceId: machineId,
    machineId,
    loopId,
    negotiatedHashes: [blobs[2]!.hash],
  });
  await seedRun(db, { id: `run-${machineId}`, loopId, machineId, phase: "done", artifactSnapshotId: manifestId });
  return { blobs, entries, manifestId, receipt };
}

export function claimBlobRoot(dataDir: string): string {
  return artifactBlobRoot(dataDir);
}

export interface ClaimRunResult {
  code: number;
  out: string;
  err: string;
}

/** Invoke the CLI exactly as the operator's shell would (argv in, text out). */
export async function runClaimForTest(
  dataDir: string,
  machineIds: readonly string[],
  extra: readonly string[] = [],
  deps: ClaimDeps = {},
  githubUserId: string = CLAIM_USER_ID,
): Promise<ClaimRunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runClaimLegacy(
    [
      "--data-dir",
      dataDir,
      "--github-user-id",
      githubUserId,
      ...machineIds.flatMap((id) => ["--machine-id", id]),
      ...extra,
    ],
    {},
    "/",
    (text) => out.push(text),
    (text) => err.push(text),
    deps,
  );
  return { code, out: out.join(""), err: err.join("") };
}

/** The 11-table zero-write oracle: business + identity state, all of it. */
export async function claimWorldSnapshot(db: Db) {
  return { ...(await snapshotBusinessState(db)), ...(await snapshotIdentityState(db)) };
}

/** A BlobStore decorator for injected failures (ENOSPC shapes) and write
 *  counting. `writeVerified` delegates unless `failOn` matches the hash. */
export function failingStore(
  inner: BlobStore,
  failOn: (input: { namespaceId: string; hash: string; call: number }) => { ok: false; failure: "storage_error" } | null,
): { store: BlobStore; writes: string[] } {
  const writes: string[] = [];
  let call = 0;
  return {
    writes,
    store: {
      has: (key) => inner.has(key),
      read: (key) => inner.read(key),
      writeVerified: async (input) => {
        call += 1;
        const injected = failOn({ namespaceId: input.namespaceId, hash: input.hash, call });
        if (injected !== null) return injected;
        writes.push(input.hash);
        return inner.writeVerified(input);
      },
    },
  };
}
