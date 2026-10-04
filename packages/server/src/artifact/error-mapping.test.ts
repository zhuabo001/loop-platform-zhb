/**
 * AT9 — the artifact failure → HTTP mapping matrix (Batch 2 slice 1,
 * ADR-010 决策 13).
 *
 * Pins every literal's status+code verbatim, the code-less 404 family, the
 * two newly frozen wire codes, the full reachability of the 11-code taxonomy,
 * and the per-operation subsets. The table's
 * `Record<ArtifactInternalFailure, ...>` type is the compile-time
 * exhaustiveness evidence: a literal added to sync.ts/config.ts without a
 * mapping fails `tsc`.
 */
import { describe, expect, it } from "vitest";

import { ARTIFACT_ERROR_CODES } from "@loopzhb/protocol";

import { ARTIFACT_FAILURE_HTTP, ARTIFACT_OPERATION_FAILURES, mapArtifactFailure } from "./error-mapping.js";

/** status:code projection — "-" = code-less. */
function projection(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ARTIFACT_FAILURE_HTTP).map(([failure, mapping]) => [
      failure,
      `${mapping.status}:${mapping.code ?? "-"}`,
    ]),
  );
}

describe("AT9: artifact failure → HTTP mapping (ADR-010 决策 13)", () => {
  it("pins every literal's status+code verbatim", () => {
    expect(projection()).toEqual({
      manifest_invalid: "400:artifact_validation_failed",
      artifact_dir_invalid: "400:artifact_validation_failed",
      artifact_dir_relative_without_workdir: "400:artifact_validation_failed",
      content_mismatch: "400:artifact_content_mismatch",
      attribution_missing: "403:artifact_attribution_missing",
      loop_not_found: "404:-",
      session_not_found: "404:-",
      run_not_found: "404:-",
      snapshot_not_found: "404:-",
      path_not_found: "404:-",
      config_conflict: "409:artifact_config_conflict",
      artifact_dir_unconfigured: "409:artifact_config_conflict",
      manifest_conflict: "409:artifact_manifest_conflict",
      session_expired: "409:artifact_session_expired",
      session_committed: "409:artifact_session_committed",
      hash_not_negotiated: "409:artifact_hash_not_negotiated",
      blob_missing: "409:artifact_blob_missing",
      manifest_revision_exhausted: "409:artifact_revision_exhausted",
      config_revision_exhausted: "409:artifact_revision_exhausted",
      storage_error: "500:artifact_storage_error",
    });
  });

  it("the five 404 literals are code-less and byte-identical to app.notFound", () => {
    for (const failure of [
      "loop_not_found",
      "session_not_found",
      "run_not_found",
      "snapshot_not_found",
      "path_not_found",
    ] as const) {
      const mapping = ARTIFACT_FAILURE_HTTP[failure];
      expect(mapping.status, failure).toBe(404);
      expect(mapping.code, failure).toBeUndefined();
      expect(mapping.message, failure).toBe("not found");
    }
  });

  it("every mapping carries a message; every emitted code is a wire code", () => {
    const wire = new Set<string>(ARTIFACT_ERROR_CODES);
    for (const [failure, mapping] of Object.entries(ARTIFACT_FAILURE_HTTP)) {
      expect(mapping.message.length, failure).toBeGreaterThan(0);
      if (mapping.code !== undefined) expect(wire.has(mapping.code), failure).toBe(true);
    }
  });

  it("the table reaches EVERY wire code (no unreachable taxonomy entry)", () => {
    const emitted = new Set(
      Object.values(ARTIFACT_FAILURE_HTTP).flatMap((mapping) => (mapping.code === undefined ? [] : [mapping.code])),
    );
    expect([...emitted].sort()).toEqual([...ARTIFACT_ERROR_CODES].sort());
  });

  it("revision exhaustion collapses both internal literals into ONE wire code", () => {
    expect(ARTIFACT_FAILURE_HTTP.manifest_revision_exhausted).toEqual(ARTIFACT_FAILURE_HTTP.config_revision_exhausted);
    expect(ARTIFACT_FAILURE_HTTP.manifest_revision_exhausted).toEqual({
      status: 409,
      code: "artifact_revision_exhausted",
      message: "artifact revision exhausted",
    });
  });

  it("a committed session's PUT refuses 409 artifact_session_committed (recover_receipt)", () => {
    expect(ARTIFACT_FAILURE_HTTP.session_committed).toEqual({
      status: 409,
      code: "artifact_session_committed",
      message: "artifact sync session already committed",
    });
  });

  it("mapArtifactFailure returns the table entry verbatim", () => {
    for (const failure of Object.keys(ARTIFACT_FAILURE_HTTP) as Array<keyof typeof ARTIFACT_FAILURE_HTTP>) {
      expect(mapArtifactFailure(failure)).toBe(ARTIFACT_FAILURE_HTTP[failure]);
    }
  });

  it("every operation list is non-empty and a subset of the table", () => {
    const table = new Set(Object.keys(ARTIFACT_FAILURE_HTTP));
    for (const [operation, failures] of Object.entries(ARTIFACT_OPERATION_FAILURES)) {
      expect(failures.length, operation).toBeGreaterThan(0);
      for (const failure of failures) expect(table.has(failure), `${operation}:${failure}`).toBe(true);
    }
  });

  it("pins the operation domains (prepare / put / commit / config / read)", () => {
    expect(ARTIFACT_OPERATION_FAILURES.prepare).toContain("artifact_dir_unconfigured");
    expect(ARTIFACT_OPERATION_FAILURES.put).toContain("session_committed");
    expect(ARTIFACT_OPERATION_FAILURES.commit).toContain("manifest_revision_exhausted");
    expect(ARTIFACT_OPERATION_FAILURES.configUpdate).toEqual([
      "loop_not_found",
      "artifact_dir_invalid",
      "artifact_dir_relative_without_workdir",
      "config_revision_exhausted",
    ]);
    expect(ARTIFACT_OPERATION_FAILURES.read).toContain("snapshot_not_found");
  });
});
