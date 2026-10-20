/**
 * Machine attribution resolver — the LEGACY namespace resolver: it derives the
 * storage namespace from the verified MACHINE's own id (ADR-010 决策 7/15/21).
 *
 * `resolve()` re-queries the machines row on EVERY operation and derives the
 * namespace from its `machineId` (`m-<sha256(token)[:16]>`, which satisfies the
 * BlobStore's NAMESPACE_ID_RE — verified in the tests). A missing row refuses
 * with `attribution_missing`; an id that cannot form a legal storage key is
 * refused the SAME way rather than handing a raw key to the BlobStore (it
 * would otherwise surface later as an `invalid_key` invariant violation). A
 * missing attribution is an expected domain outcome, never an exception.
 *
 * NOT the production resolver since Phase 5 Batch 3 slice 3 (ADR-011):
 * `createProductionArtifactHome` and the report binding resolve the OWNING
 * TEAM's namespace instead (`attribution-team.ts`). This module is retained
 * because the slice-4 offline claim CLI must read the SOURCE side of the
 * migration — the pre-claim blobs that live under the machine's own namespace
 * — and verify them before copying them into the Team namespace.
 *
 * Credential verification (full tokenHash comparison, NO self-registration)
 * is the machine HTTP auth read path built in Batch 2 slice 2 — this resolver
 * runs AFTER it and trusts the identity the store resolved.
 */
import type { ArtifactAttribution, ArtifactAttributionResolver, TrustedMachineIdentity } from "./attribution.js";
import { NAMESPACE_ID_RE } from "./blob-store.js";
import type { Db } from "../db/index.js";
import { getMachine } from "../store/machines.js";

export interface MachineAttributionResolverOptions {
  db: Db;
}

export function createMachineAttributionResolver(options: MachineAttributionResolverOptions): ArtifactAttributionResolver {
  const { db } = options;
  return {
    async resolve(machine: TrustedMachineIdentity): Promise<ArtifactAttribution> {
      const row = await getMachine(db, machine.machineId);
      if (row === undefined || !NAMESPACE_ID_RE.test(row.id)) {
        return { ok: false, failure: "attribution_missing" };
      }
      return { ok: true, namespaceId: row.id, machineId: row.id };
    },
  };
}
