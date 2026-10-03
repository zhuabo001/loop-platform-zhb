/**
 * Trusted attribution resolver — the ONLY source of a storage namespace
 * (ADR-010 决策 7/15). FROZEN in Batch 1 slice 1: the interface and its
 * behavior contract only. Production Team attribution arrives with the later
 * auth batches; Batch 1 tests inject the mapping.
 *
 * The namespace is derived from the TRUSTED machine identity — a record the
 * store already resolved from the Bearer credential — never from wire input:
 * no prepare/PUT/commit/read request may name a namespace, and there is NO
 * default global namespace. Missing attribution rejects the operation
 * (`artifact_attribution_missing` / 403).
 */

/** A machine identity already authenticated by the store from its Bearer
 *  credential. NEVER wire input. */
export interface TrustedMachineIdentity {
  readonly machineId: string;
}

export type ArtifactAttribution =
  | { ok: true; namespaceId: string; machineId: string }
  | { ok: false; failure: "attribution_missing" };

export interface ArtifactAttributionResolver {
  /**
   * Resolve the storage namespace for a trusted machine. Called on EVERY
   * prepare, PUT, commit, read and snapshot bind — attribution is re-derived
   * per operation, never cached from the request. Async: production Team
   * attribution will need a database read. A missing attribution is an
   * expected domain outcome (the union), not an exception.
   */
  resolve(machine: TrustedMachineIdentity): Promise<ArtifactAttribution>;
}
