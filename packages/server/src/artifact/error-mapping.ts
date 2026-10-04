/**
 * Artifact failure → HTTP mapping — the server-side half of ADR-010 决策 13,
 * frozen in Batch 2 slice 1 (plan §1: "错误映射和重试矩阵均有测试").
 *
 * Every internal failure literal the artifact modules return maps to exactly
 * one `{status, code?, message}`. The table is exhaustive by construction:
 * `Record<ArtifactInternalFailure, ArtifactHttpMapping>` — a new literal in
 * sync.ts/config.ts without a mapping does not compile. The statuses and
 * codes are contract; the route layer (slice 2 for the machine routes, slice 7
 * for the read routes) composes
 * `jsonError(c, m.status, m.message, m.code)`.
 *
 * Code-less 404: loop/session/run/snapshot/path never-existed and cross-scope
 * refusals stay indistinguishable (the existing 404 convention; the body is
 * byte-identical to `app.notFound`). Race-lost and invariant errors are NOT in
 * this table — they stay 500 via `app.onError`.
 */
import type { ArtifactErrorCode } from "@loopzhb/protocol";

import type { JsonErrorStatus } from "../http/json-error.js";
import type { ArtifactConfigRejection } from "./config.js";
import type { CommitArtifactSyncFailure, PrepareArtifactSyncFailure, PutArtifactBlobFailure } from "./sync.js";

/** Read-side failures, pre-frozen for Batch 2 slice 7 (the read facade and
 *  the download/diff routes consume them; a new literal extends this union,
 *  the table and `ARTIFACT_OPERATION_FAILURES.read` in the same change).
 *  决策 7 spans reads too: the facade re-resolves attribution per call, so a
 *  vanished machine row or an unformable namespace key is a first-class read
 *  result (403), not an excluded branch (#83). */
export type ArtifactReadFailure =
  | "attribution_missing"
  | "loop_not_found"
  | "run_not_found"
  | "snapshot_not_found"
  | "path_not_found"
  | "artifact_dir_unconfigured"
  | "blob_missing"
  | "storage_error";

/** Every internal failure literal an artifact operation can return. */
export type ArtifactInternalFailure =
  | PrepareArtifactSyncFailure
  | PutArtifactBlobFailure
  | CommitArtifactSyncFailure
  | ArtifactConfigRejection
  | ArtifactReadFailure;

export interface ArtifactHttpMapping {
  status: JsonErrorStatus;
  /** Absent ⇒ code-less 404 (existence never leaks across scopes). */
  code?: ArtifactErrorCode;
  /** Human-readable text; NOT a machine contract (the code is). */
  message: string;
}

export const ARTIFACT_FAILURE_HTTP: Readonly<Record<ArtifactInternalFailure, ArtifactHttpMapping>> = {
  // ---- 400: client input / content defects (terminal) ----
  manifest_invalid: { status: 400, code: "artifact_validation_failed", message: "invalid artifact sync request" },
  artifact_dir_invalid: { status: 400, code: "artifact_validation_failed", message: "invalid artifact directory" },
  artifact_dir_relative_without_workdir: {
    status: 400,
    code: "artifact_validation_failed",
    message: "invalid artifact directory",
  },
  content_mismatch: { status: 400, code: "artifact_content_mismatch", message: "artifact content mismatch" },
  // ---- 403: no valid trusted attribution (terminal) ----
  attribution_missing: {
    status: 403,
    code: "artifact_attribution_missing",
    message: "artifact attribution missing",
  },
  // ---- 404: never existed or cross-scope — code-less by convention ----
  loop_not_found: { status: 404, message: "not found" },
  session_not_found: { status: 404, message: "not found" },
  run_not_found: { status: 404, message: "not found" },
  snapshot_not_found: { status: 404, message: "not found" },
  path_not_found: { status: 404, message: "not found" },
  // ---- 409: renegotiate / resume class ----
  config_conflict: { status: 409, code: "artifact_config_conflict", message: "artifact config conflict" },
  artifact_dir_unconfigured: { status: 409, code: "artifact_config_conflict", message: "artifact config conflict" },
  manifest_conflict: { status: 409, code: "artifact_manifest_conflict", message: "artifact manifest conflict" },
  session_expired: { status: 409, code: "artifact_session_expired", message: "artifact sync session expired" },
  session_committed: {
    status: 409,
    code: "artifact_session_committed",
    message: "artifact sync session already committed",
  },
  hash_not_negotiated: { status: 409, code: "artifact_hash_not_negotiated", message: "artifact hash not negotiated" },
  blob_missing: { status: 409, code: "artifact_blob_missing", message: "artifact blob missing" },
  manifest_revision_exhausted: {
    status: 409,
    code: "artifact_revision_exhausted",
    message: "artifact revision exhausted",
  },
  config_revision_exhausted: {
    status: 409,
    code: "artifact_revision_exhausted",
    message: "artifact revision exhausted",
  },
  // ---- 500: idempotent_retry class ----
  storage_error: { status: 500, code: "artifact_storage_error", message: "artifact storage error" },
};

export function mapArtifactFailure(failure: ArtifactInternalFailure): ArtifactHttpMapping {
  return ARTIFACT_FAILURE_HTTP[failure];
}

/** Per-operation failure domains: which literals each entry point can return.
 *  Slice 2's routes and slice 7's read facade consume these lists; the table
 *  above stays the single source for status/code/message. */
export interface ArtifactOperationFailures {
  prepare: readonly PrepareArtifactSyncFailure[];
  put: readonly PutArtifactBlobFailure[];
  commit: readonly CommitArtifactSyncFailure[];
  configUpdate: readonly (ArtifactConfigRejection | "loop_not_found")[];
  syncErrorReport: readonly ("loop_not_found" | "attribution_missing" | "storage_error")[];
  read: readonly ArtifactReadFailure[];
}

export const ARTIFACT_OPERATION_FAILURES: ArtifactOperationFailures = {
  prepare: [
    "manifest_invalid",
    "attribution_missing",
    "loop_not_found",
    "artifact_dir_unconfigured",
    "config_conflict",
    "manifest_conflict",
    "storage_error",
  ],
  put: [
    "attribution_missing",
    "session_not_found",
    "session_expired",
    "session_committed",
    "loop_not_found",
    "config_conflict",
    "hash_not_negotiated",
    "content_mismatch",
    "storage_error",
  ],
  commit: [
    "attribution_missing",
    "session_not_found",
    "session_expired",
    "loop_not_found",
    "config_conflict",
    "manifest_conflict",
    "blob_missing",
    "manifest_revision_exhausted",
    "storage_error",
  ],
  configUpdate: ["loop_not_found", "artifact_dir_invalid", "artifact_dir_relative_without_workdir", "config_revision_exhausted"],
  syncErrorReport: ["loop_not_found", "attribution_missing", "storage_error"],
  read: [
    // 决策 7 first: attribution is resolved before any resource lookup.
    "attribution_missing",
    "loop_not_found",
    "run_not_found",
    "snapshot_not_found",
    "path_not_found",
    "artifact_dir_unconfigured",
    "blob_missing",
    "storage_error",
  ],
};
