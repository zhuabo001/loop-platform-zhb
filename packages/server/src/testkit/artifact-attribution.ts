/**
 * Shared artifact-attribution test double (TEST-ONLY; excluded from the build
 * via tsconfig.build.json). Batch 2 slice 1 extracted this from the five
 * hand-rolled copies in the artifact suites — tests inject the mapping
 * (ADR-010 决策 7/15), production resolves the Machine namespace.
 */
import type { ArtifactAttributionResolver } from "../artifact/attribution.js";

/** Map a machineId to a namespace; unmapped machines refuse with
 *  `attribution_missing` — the frozen Batch 1 slice-1 contract verbatim. */
export function staticAttribution(map: Record<string, string>): ArtifactAttributionResolver {
  return {
    resolve: (machine) => {
      const namespaceId = map[machine.machineId];
      return Promise.resolve(
        namespaceId
          ? { ok: true as const, namespaceId, machineId: machine.machineId }
          : { ok: false as const, failure: "attribution_missing" as const },
      );
    },
  };
}
