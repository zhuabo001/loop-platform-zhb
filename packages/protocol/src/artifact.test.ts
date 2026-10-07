import { describe, expect, it } from "vitest";

import {
  ARTIFACT_ERROR_CODES,
  ARTIFACT_ERROR_RETRY_CLASS,
  ARTIFACT_ERROR_RETRY_CLASSES,
  ARTIFACT_SYNC_FAILURES,
  ARTIFACT_SYNC_ID_HEADER,
  ARTIFACT_SYNC_STATE_ERRORS,
  artifactManifestEntrySchema,
  artifactSyncErrorReportRequestSchema,
  artifactSyncErrorReportResponseSchema,
  artifactWatchItemSchema,
  commitArtifactSyncResponseSchema,
  machineLoopArtifactsResponseSchema,
  prepareArtifactSyncRequestSchema,
  prepareArtifactSyncResponseSchema,
  putArtifactBlobResponseSchema,
} from "./artifact.js";
import {
  createLoopRequestSchema,
  loopSummarySchema,
  updateArtifactDirRequestSchema,
  updateArtifactDirResponseSchema,
} from "./admin.js";
import { pollRequestSchema, pollResponseSchema } from "./poll.js";
import { reportRequestSchema } from "./report.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const GOLDEN_PREPARE_REQUEST = {
  requestId: "req-01",
  loopId: "loop-01",
  configRevision: 3,
  baseManifestRevision: 2,
  entries: [
    { path: "src/index.ts", hash: HASH_A, size: 1200 },
    { path: "docs/README.md", hash: HASH_B, size: 0 },
  ],
} as const;

const GOLDEN_WATCH_ITEM = {
  loopId: "loop-01",
  artifactDir: "dist",
  workdir: "/home/dev/project",
  roots: ["/home/dev"],
  configRevision: 3,
} as const;

const MINIMAL_LOOP_SUMMARY = {
  id: "loop-01",
  machineId: "m-0123456789abcdef",
  name: null,
  workdir: null,
  taskFile: null,
  agent: "claude-code",
  allowControl: true,
  enabled: true,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  lastRun: null,
} as const;

describe("artifact sync DTO goldens", () => {
  it("round-trips a golden prepare request (the current COMPLETE manifest)", () => {
    expect(prepareArtifactSyncRequestSchema.parse(GOLDEN_PREPARE_REQUEST)).toEqual(GOLDEN_PREPARE_REQUEST);
  });

  it("round-trips a first-sync prepare request (baseManifestRevision 0 = no base)", () => {
    const body = { ...GOLDEN_PREPARE_REQUEST, configRevision: 1, baseManifestRevision: 0 };
    expect(prepareArtifactSyncRequestSchema.parse(body)).toEqual(body);
  });

  it("round-trips the prepare response and the commit response", () => {
    const prepareResponse = { syncId: "sync-01", needHashes: [HASH_A, HASH_B], expiresAt: "2026-09-28T01:00:00.000Z" };
    expect(prepareArtifactSyncResponseSchema.parse(prepareResponse)).toEqual(prepareResponse);
    const commitResponse = { artifactSnapshotId: "am_01", manifestRevision: 3 };
    expect(commitArtifactSyncResponseSchema.parse(commitResponse)).toEqual(commitResponse);
  });

  it("round-trips a golden watch item (workdir nullable)", () => {
    expect(artifactWatchItemSchema.parse(GOLDEN_WATCH_ITEM)).toEqual(GOLDEN_WATCH_ITEM);
    const scratch = { ...GOLDEN_WATCH_ITEM, workdir: null };
    expect(artifactWatchItemSchema.parse(scratch)).toEqual(scratch);
  });

  it("pins the sync-id header name (Batch 2's PUT carries the session in it)", () => {
    expect(ARTIFACT_SYNC_ID_HEADER).toBe("X-Artifact-Sync-Id");
  });

  it("round-trips the PUT response; unknown keys strip and a half-formed body rejects (AH1)", () => {
    const published = { ok: true, size: 1200, published: true };
    expect(putArtifactBlobResponseSchema.parse(published)).toEqual(published);
    // The dedupe shape is legal: published:false still carries the verified size.
    const deduped = putArtifactBlobResponseSchema.parse({ ...published, size: 0, published: false });
    expect(deduped).toEqual({ ok: true, size: 0, published: false });
    // Tolerant reader: an unknown additive field from a newer writer is stripped.
    expect(putArtifactBlobResponseSchema.parse({ ...published, future: 1 })).toEqual(published);
    // Half-formed bodies are rejected: a missing published flag or a wrong
    // literal is not a success shape.
    expect(putArtifactBlobResponseSchema.safeParse({ ok: true, size: 1 }).success).toBe(false);
    expect(putArtifactBlobResponseSchema.safeParse({ ok: false, size: 1, published: true }).success).toBe(false);
  });
});

describe("schema pins SHAPE only — the value domain stays in artifact-policy", () => {
  it("a malformed hash still parses as an entry (no schema-level regex)", () => {
    // Same discipline as tokens.ts: shape filtering is write-side only. The
    // 64-hex lowercase rule is shared policy so daemon and server produce ONE
    // classification path — a zod issue here would fork it.
    for (const hash of ["xyz", "a".repeat(63), "A".repeat(64), ""]) {
      expect(artifactManifestEntrySchema.parse({ path: "a", hash, size: 1 }).hash).toBe(hash);
    }
  });

  it("a negative/fractional/huge size still parses as an entry (no schema-level int/nonnegative)", () => {
    for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(artifactManifestEntrySchema.parse({ path: "a", hash: HASH_A, size }).size).toBe(size);
    }
  });

  it("a NON-FINITE size still parses (typeof-number only — slice-1 review A1)", () => {
    // Zod 4's z.number() rejects Infinity/NaN at the schema layer, which would
    // fork the failure classification (zod issue here vs size_invalid in the
    // shared policy). The schema admits any typeof-number; the policy rejects.
    const infinity = artifactManifestEntrySchema.parse({ path: "a", hash: HASH_A, size: Number.POSITIVE_INFINITY });
    expect(infinity.size).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(artifactManifestEntrySchema.parse({ path: "a", hash: HASH_A, size: Number.NaN }).size)).toBe(
      true,
    );
    // A non-number still fails at the schema layer — that IS shape.
    expect(() => artifactManifestEntrySchema.parse({ path: "a", hash: HASH_A, size: "1" })).toThrow();
    expect(() => artifactManifestEntrySchema.parse({ path: "a", hash: HASH_A })).toThrow();
  });
});

describe("poll additive fields (Phase 5, ADR-010)", () => {
  it("request: watchDigest round-trips and stays absent for old daemons", () => {
    expect(pollRequestSchema.parse({ host: "h", watchDigest: "d".repeat(64) })).toEqual({
      host: "h",
      watchDigest: "d".repeat(64),
    });
    expect(pollRequestSchema.parse({ host: "h" })).toEqual({ host: "h" });
  });

  it("response: watch + watchDigest round-trip; [] is a legal (clearing) set", () => {
    const full = pollResponseSchema.parse({
      deliveries: [],
      watch: [GOLDEN_WATCH_ITEM],
      watchDigest: "e".repeat(64),
    });
    expect(full.watch).toEqual([GOLDEN_WATCH_ITEM]);
    expect(full.watchDigest).toBe("e".repeat(64));
    expect(pollResponseSchema.parse({ deliveries: [], watch: [] }).watch).toEqual([]);
    const absent = pollResponseSchema.parse({ deliveries: [] });
    expect(absent).not.toHaveProperty("watch");
    expect(absent).not.toHaveProperty("watchDigest");
  });
});

describe("report additive fields (declared in Batch 1, consumed by the Batch 2 report wiring)", () => {
  it("artifactSnapshotId / artifactSyncError round-trip and stay absent on old reports", () => {
    const withFields = reportRequestSchema.parse({
      ok: true,
      artifactSnapshotId: "am_01",
      artifactSyncError: "sync_failed",
    });
    expect(withFields.artifactSnapshotId).toBe("am_01");
    expect(withFields.artifactSyncError).toBe("sync_failed");
    const without = reportRequestSchema.parse({ ok: true });
    expect(without).not.toHaveProperty("artifactSnapshotId");
    expect(without).not.toHaveProperty("artifactSyncError");
  });
});

describe("admin artifactDir fields (declared in Batch 1, routes mounted in Batch 2 slices 2/7)", () => {
  it("create: artifactDir is optional; explicit null is rejected at creation", () => {
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", artifactDir: "dist" })).toEqual({
      machineId: "m-0123456789abcdef",
      artifactDir: "dist",
    });
    expect(createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef" })).not.toHaveProperty("artifactDir");
    expect(() => createLoopRequestSchema.parse({ machineId: "m-0123456789abcdef", artifactDir: null })).toThrow();
  });

  it("update: null CLEARS, a string SETS, a missing key REJECTS (required-nullable)", () => {
    expect(updateArtifactDirRequestSchema.parse({ artifactDir: null })).toEqual({ artifactDir: null });
    expect(updateArtifactDirRequestSchema.parse({ artifactDir: "dist" })).toEqual({ artifactDir: "dist" });
    expect(() => updateArtifactDirRequestSchema.parse({})).toThrow();
  });

  it("update response wraps the loop summary; the summary carries additive artifactDir", () => {
    const loop = { ...MINIMAL_LOOP_SUMMARY, artifactDir: "dist" };
    expect(updateArtifactDirResponseSchema.parse({ loop })).toEqual({ loop });
    const oldServer = loopSummarySchema.parse({ ...MINIMAL_LOOP_SUMMARY });
    expect(oldServer).not.toHaveProperty("artifactDir");
    expect(loopSummarySchema.parse({ ...MINIMAL_LOOP_SUMMARY, artifactDir: null }).artifactDir).toBeNull();
  });
});

describe("error taxonomy (ADR-010 决策 13)", () => {
  it("pins the eleven wire codes verbatim and in order", () => {
    expect(ARTIFACT_ERROR_CODES).toEqual([
      "artifact_validation_failed",
      "artifact_config_conflict",
      "artifact_manifest_conflict",
      "artifact_session_expired",
      "artifact_hash_not_negotiated",
      "artifact_content_mismatch",
      "artifact_blob_missing",
      "artifact_storage_error",
      "artifact_attribution_missing",
      "artifact_revision_exhausted",
      "artifact_session_committed",
    ]);
  });

  it("pins the retry classes verbatim", () => {
    expect(ARTIFACT_ERROR_RETRY_CLASSES).toEqual([
      "idempotent_retry",
      "resume",
      "renegotiate",
      "terminal",
      "recover_receipt",
    ]);
  });

  it("maps EVERY code to a retry class, exhaustively and verbatim", () => {
    expect(ARTIFACT_ERROR_RETRY_CLASS).toEqual({
      artifact_validation_failed: "terminal",
      artifact_config_conflict: "renegotiate",
      artifact_manifest_conflict: "renegotiate",
      artifact_session_expired: "renegotiate",
      artifact_hash_not_negotiated: "renegotiate",
      artifact_content_mismatch: "terminal",
      artifact_blob_missing: "resume",
      artifact_storage_error: "idempotent_retry",
      artifact_attribution_missing: "terminal",
      artifact_revision_exhausted: "terminal",
      artifact_session_committed: "recover_receipt",
    });
    // Exhaustiveness beyond the literal: every declared code has a mapping.
    for (const code of ARTIFACT_ERROR_CODES) {
      expect(ARTIFACT_ERROR_RETRY_CLASSES).toContain(ARTIFACT_ERROR_RETRY_CLASS[code]);
    }
    expect(Object.keys(ARTIFACT_ERROR_RETRY_CLASS)).toHaveLength(ARTIFACT_ERROR_CODES.length);
  });
});

describe("client failure taxonomy and sync-error reporting (Batch 2, ADR-010 决策 13)", () => {
  it("pins the nine client failure classes verbatim and in order", () => {
    expect(ARTIFACT_SYNC_FAILURES).toEqual([
      "directory_missing",
      "unreadable",
      "outside_jail",
      "symlink",
      "special_file",
      "unstable",
      "too_large",
      "watcher_error",
      "timeout",
    ]);
  });

  it("the client taxonomy is DISJOINT from the server wire codes", () => {
    const wire = new Set<string>(ARTIFACT_ERROR_CODES);
    for (const failure of ARTIFACT_SYNC_FAILURES) expect(wire.has(failure)).toBe(false);
  });

  it("ARTIFACT_SYNC_STATE_ERRORS is the ordered deduped union of both sets", () => {
    expect(ARTIFACT_SYNC_STATE_ERRORS).toEqual([...ARTIFACT_ERROR_CODES, ...ARTIFACT_SYNC_FAILURES]);
    expect(new Set(ARTIFACT_SYNC_STATE_ERRORS).size).toBe(ARTIFACT_SYNC_STATE_ERRORS.length);
  });

  it("the sync-error report round-trips failure/revisions and an optional message", () => {
    const body = { failure: "outside_jail", configRevision: 3, baseManifestRevision: 2 };
    expect(artifactSyncErrorReportRequestSchema.parse(body)).toEqual(body);
    const withMessage = { ...body, message: "scan left the jail" };
    expect(artifactSyncErrorReportRequestSchema.parse(withMessage)).toEqual(withMessage);
    expect(artifactSyncErrorReportRequestSchema.parse(body)).not.toHaveProperty("message");
  });

  it("an unknown failure value is rejected at the schema layer (closed taxonomy)", () => {
    expect(() =>
      artifactSyncErrorReportRequestSchema.parse({ failure: "kaboom", configRevision: 1, baseManifestRevision: 0 }),
    ).toThrow();
  });

  it("the report response carries ok + recorded (false = no state written)", () => {
    expect(artifactSyncErrorReportResponseSchema.parse({ ok: true, recorded: false })).toEqual({
      ok: true,
      recorded: false,
    });
  });
});

describe("machine-scoped artifacts read (Batch 2)", () => {
  it("round-trips config + current manifest revision; no namespace field", () => {
    const golden = { loopId: "loop-01", artifactDir: "dist", configRevision: 3, manifestRevision: 5 };
    const parsed = machineLoopArtifactsResponseSchema.parse(golden);
    expect(parsed).toEqual(golden);
    expect(Object.keys(parsed)).not.toContain("namespaceId");
  });
});
