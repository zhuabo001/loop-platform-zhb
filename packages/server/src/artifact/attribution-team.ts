/**
 * Team attribution resolver — the Phase 5 Batch 3 Slice 3 production
 * implementation of the frozen ArtifactAttributionResolver contract
 * (ADR-010 决策 7/15, ADR-011).
 *
 * Batch 3 slice 3 changes the storage namespace from the machine's own id
 * (`m-<sha256(token)[:16]>`) to the owning Team's id (`t-<hex16>`). This
 * means every artifact written or read by a machine is now scoped to the
 * team that claimed the machine — the namespace the SAME Batch's Slice 4
 * offline claim path copies history INTO (from the legacy machine namespace,
 * in a verified copy-then-update transaction), and the one slice 4's CLI
 * therefore has to agree with byte for byte.
 *
 * `resolve()` re-queries the machine row on EVERY operation and reads
 * `teamId` from it. A missing row, a null `teamId` (unclaimed machine), or
 * a `teamId` that cannot satisfy NAMESPACE_ID_RE all refuse with
 * `attribution_missing` (403) — never a raw key, never an exception. A
 * missing attribution is an expected domain outcome (the union), not an
 * exception.
 *
 * Credential verification (shape + full tokenHash + teamId + revokedAt) has
 * already happened in `verifyEligibleMachineCredential` before this resolver
 * is called. `resolve()` is deliberately a re-read rather than a cache: the
 * machine's team ownership could change between a prepare and a commit in
 * a future racing claim scenario, and re-derivation is the safe default.
 *
 * The old `createMachineAttributionResolver` (attribution-machine.ts) is
 * RETAINED: Batch 3 slice 4's offline claim CLI needs it to locate and verify
 * source blobs under the legacy machine namespace before the copy-and-claim
 * transaction. (Batch 4 is the ConnectKey intake — a different slice of work.)
 */
import type { Db } from "../db/index.js";
import { getMachine } from "../store/machines.js";
import { NAMESPACE_ID_RE } from "./blob-store.js";
import type { ArtifactAttribution, ArtifactAttributionResolver, TrustedMachineIdentity } from "./attribution.js";

export interface TeamAttributionResolverOptions {
  db: Db;
}

/**
 * Returns an ArtifactAttributionResolver that derives the storage namespace
 * from the machine's owning team (`machines.teamId`).
 *
 * Preconditions (caller's responsibility):
 *  - The machine credential has already been verified through
 *    `verifyEligibleMachineCredential` (shape + hash + teamId + revokedAt).
 *  - `machine.machineId` is the store-resolved id (never raw wire input).
 *
 * Refusal conditions (all collapse to `attribution_missing`):
 *  - No machines row at `machineId`
 *  - `machines.teamId` IS NULL (machine not yet claimed)
 *  - `machines.teamId` fails NAMESPACE_ID_RE (would be an invalid BlobStore key)
 *
 * `revokedAt` is deliberately NOT part of this predicate. Revocation gates
 * EXECUTION (claiming new work), which `verifyEligibleMachineCredential`
 * enforces; the artifacts a revoked machine already published belong to its
 * team and stay readable through the team namespace (the Dashboard's
 * management reads carry no machine credential at all).
 */
export function createTeamAttributionResolver(options: TeamAttributionResolverOptions): ArtifactAttributionResolver {
  const { db } = options;
  return {
    async resolve(machine: TrustedMachineIdentity): Promise<ArtifactAttribution> {
      const row = await getMachine(db, machine.machineId);
      if (row === undefined || row.teamId === null || !NAMESPACE_ID_RE.test(row.teamId)) {
        return { ok: false, failure: "attribution_missing" };
      }
      return { ok: true, namespaceId: row.teamId, machineId: machine.machineId };
    },
  };
}
