/**
 * Batch 2 slice 1 contract tests (AT3/AT7): the read-side view shapes and the
 * wire-never-names-a-storage-namespace rule (ADR-010 决策 7).
 *
 * AT3 pins the read-side goldens: the loop's current view with its stale
 * marker, the Run's bound-vs-missing discriminated union, and the download /
 * diff query+response shapes (diff carries hash/size only — no content).
 * AT7 proves the namespace rule two ways: no Batch 2 (or Batch 1 artifact)
 * schema DECLARES a namespace-named key, and an injected `namespaceId` strips
 * away from every request/response golden.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  artifactManifestEntrySchema,
  artifactSyncErrorReportRequestSchema,
  artifactSyncErrorReportResponseSchema,
  artifactWatchItemSchema,
  commitArtifactSyncResponseSchema,
  machineLoopArtifactsResponseSchema,
  prepareArtifactSyncRequestSchema,
  prepareArtifactSyncResponseSchema,
} from "./artifact.js";
import {
  artifactDiffEntrySchema,
  artifactDiffQuerySchema,
  artifactDiffResponseSchema,
  artifactDownloadQuerySchema,
  artifactSnapshotRefSchema,
  artifactSyncStatusSchema,
  loopArtifactsResponseSchema,
  runArtifactsBoundSchema,
  runArtifactsMissingSchema,
  runArtifactsResponseSchema,
} from "./artifact-view.js";
import { deliveryArtifactConfigSchema, deliverySchema } from "./poll.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AT = "2026-10-04T00:00:00.000Z";

const GOLDEN_LOOP_VIEW = {
  loopId: "loop-01",
  artifactDir: "dist",
  configRevision: 3,
  manifestRevision: 5,
  manifestId: "amf-01",
  committedAt: AT,
  stale: false,
  fileCount: 2,
  totalBytes: 1_200,
  sync: { attemptedAt: AT, succeededAt: AT, error: null },
  files: [
    { path: "src/index.ts", hash: HASH_A, size: 1_200 },
    { path: "docs/README.md", hash: HASH_B, size: 0 },
  ],
};

const GOLDEN_RUN_BOUND = {
  runId: "r-01",
  loopId: "loop-01",
  state: "bound" as const,
  snapshotId: "amf-01",
  manifestRevision: 5,
  configRevision: 3,
  committedAt: AT,
  fileCount: 1,
  totalBytes: 7,
  files: [{ path: "a.txt", hash: HASH_A, size: 7 }],
};

const GOLDEN_RUN_MISSING = { runId: "r-02", loopId: "loop-01", state: "missing" as const };

const GOLDEN_DIFF_RESPONSE = {
  loopId: "loop-01",
  from: null,
  to: { snapshotId: "amf-02", manifestRevision: 5 },
  added: [{ path: "new.txt", hash: HASH_A, size: 1 }],
  modified: [{ path: "src/index.ts", beforeHash: HASH_A, beforeSize: 1, afterHash: HASH_B, afterSize: 2 }],
  removed: [{ path: "old.txt", hash: HASH_B, size: 3 }],
};

describe("AT3: read-side view goldens", () => {
  it("loop view round-trips a manifest with the stale marker off", () => {
    expect(loopArtifactsResponseSchema.parse(GOLDEN_LOOP_VIEW)).toEqual(GOLDEN_LOOP_VIEW);
  });

  it("loop view round-trips the unconfigured-but-erroring shape (nulls + client failure)", () => {
    const unconfigured = {
      loopId: "loop-01",
      artifactDir: null,
      configRevision: 0,
      manifestRevision: 0,
      manifestId: null,
      committedAt: null,
      stale: true,
      fileCount: 0,
      totalBytes: 0,
      sync: { attemptedAt: AT, succeededAt: null, error: "directory_missing" },
      files: [],
    };
    expect(loopArtifactsResponseSchema.parse(unconfigured)).toEqual(unconfigured);
  });

  it("run view discriminates bound vs missing; missing carries no file set", () => {
    expect(runArtifactsResponseSchema.parse(GOLDEN_RUN_BOUND)).toEqual(GOLDEN_RUN_BOUND);
    expect(runArtifactsResponseSchema.parse(GOLDEN_RUN_MISSING)).toEqual(GOLDEN_RUN_MISSING);
    const parsedMissing = runArtifactsResponseSchema.parse({ ...GOLDEN_RUN_MISSING, files: [] });
    expect(parsedMissing).toEqual(GOLDEN_RUN_MISSING);
    expect(parsedMissing).not.toHaveProperty("files");
    expect(() => runArtifactsResponseSchema.parse({ ...GOLDEN_RUN_MISSING, state: "weird" })).toThrow();
  });

  it("download query requires snapshotId and path (no defaults)", () => {
    const query = { snapshotId: "amf-01", path: "a/b.txt" };
    expect(artifactDownloadQuerySchema.parse(query)).toEqual(query);
    expect(() => artifactDownloadQuerySchema.parse({ snapshotId: "amf-01" })).toThrow();
    expect(() => artifactDownloadQuerySchema.parse({ path: "a/b.txt" })).toThrow();
  });

  it("diff query requires `to`; an omitted `from` stays absent (the empty-set baseline)", () => {
    expect(artifactDiffQuerySchema.parse({ to: "amf-02" })).toEqual({ to: "amf-02" });
    expect(artifactDiffQuerySchema.parse({ from: "amf-01", to: "amf-02" })).toEqual({
      from: "amf-01",
      to: "amf-02",
    });
    expect(() => artifactDiffQuerySchema.parse({ from: "amf-01" })).toThrow();
  });

  it("diff entries carry ONLY before/after hash + size — never content", () => {
    const entry = { path: "src/index.ts", beforeHash: HASH_A, beforeSize: 1, afterHash: HASH_B, afterSize: 2 };
    const parsed = artifactDiffEntrySchema.parse({ ...entry, content: "secret bytes" });
    expect(parsed).toEqual(entry);
    expect(Object.keys(parsed).sort()).toEqual(["afterHash", "afterSize", "beforeHash", "beforeSize", "path"]);
  });

  it("diff response round-trips with the empty-set baseline (from = null) and a live ref", () => {
    expect(artifactDiffResponseSchema.parse(GOLDEN_DIFF_RESPONSE)).toEqual(GOLDEN_DIFF_RESPONSE);
    const withFrom = { ...GOLDEN_DIFF_RESPONSE, from: { snapshotId: "amf-01", manifestRevision: 4 } };
    expect(artifactDiffResponseSchema.parse(withFrom)).toEqual(withFrom);
  });

  it("snapshot refs and sync status round-trip their minimal shapes", () => {
    expect(artifactSnapshotRefSchema.parse({ snapshotId: "amf-01", manifestRevision: 4 })).toEqual({
      snapshotId: "amf-01",
      manifestRevision: 4,
    });
    const status = { attemptedAt: null, succeededAt: null, error: null };
    expect(artifactSyncStatusSchema.parse(status)).toEqual(status);
  });
});

// ---- AT7: the wire never names a storage namespace ----

/** Walk a JSON Schema (z.toJSONSchema output) and collect every `properties`
 *  key, recursing through nested objects, oneOf/anyOf branches and items. */
function collectPropertyKeys(node: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyKeys(item, keys);
    return keys;
  }
  if (node === null || typeof node !== "object") return keys;
  const record = node as Record<string, unknown>;
  if (record.properties !== undefined && record.properties !== null && typeof record.properties === "object") {
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
      keys.add(key);
      collectPropertyKeys(child, keys);
    }
  }
  for (const [keyword, value] of Object.entries(record)) {
    if (keyword === "properties") continue;
    collectPropertyKeys(value, keys);
  }
  return keys;
}

/** Assert no KEY anywhere in a parsed value matches /namespace/i. */
function expectNoNamespaceKey(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectNoNamespaceKey(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expect(key, `${path}.${key} names a namespace`).not.toMatch(/namespace/i);
    expectNoNamespaceKey(child, `${path}.${key}`);
  }
}

/** Every artifact wire schema that exists after Batch 2 slice 1. */
const NAMESPACE_FREE_SCHEMAS: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
  ["artifactManifestEntrySchema", artifactManifestEntrySchema],
  ["artifactWatchItemSchema", artifactWatchItemSchema],
  ["prepareArtifactSyncRequestSchema", prepareArtifactSyncRequestSchema],
  ["prepareArtifactSyncResponseSchema", prepareArtifactSyncResponseSchema],
  ["commitArtifactSyncResponseSchema", commitArtifactSyncResponseSchema],
  ["machineLoopArtifactsResponseSchema", machineLoopArtifactsResponseSchema],
  ["artifactSyncErrorReportRequestSchema", artifactSyncErrorReportRequestSchema],
  ["artifactSyncErrorReportResponseSchema", artifactSyncErrorReportResponseSchema],
  ["deliveryArtifactConfigSchema", deliveryArtifactConfigSchema],
  ["artifactSyncStatusSchema", artifactSyncStatusSchema],
  ["loopArtifactsResponseSchema", loopArtifactsResponseSchema],
  ["runArtifactsBoundSchema", runArtifactsBoundSchema],
  ["runArtifactsMissingSchema", runArtifactsMissingSchema],
  ["runArtifactsResponseSchema", runArtifactsResponseSchema],
  ["artifactDownloadQuerySchema", artifactDownloadQuerySchema],
  ["artifactDiffQuerySchema", artifactDiffQuerySchema],
  ["artifactSnapshotRefSchema", artifactSnapshotRefSchema],
  ["artifactDiffEntrySchema", artifactDiffEntrySchema],
  ["artifactDiffResponseSchema", artifactDiffResponseSchema],
];

describe("AT7: the wire never names a storage namespace (ADR-010 决策 7)", () => {
  it("no artifact wire schema DECLARES a namespace-named key", () => {
    for (const [name, schema] of NAMESPACE_FREE_SCHEMAS) {
      const keys = [...collectPropertyKeys(z.toJSONSchema(schema, { unrepresentable: "any" }))];
      expect(
        keys.filter((key) => /namespace/i.test(key)),
        `${name} declares a namespace-named key`,
      ).toEqual([]);
    }
  });

  it("an injected namespaceId strips away from every request/response golden", () => {
    const goldens: ReadonlyArray<readonly [string, z.ZodTypeAny, Record<string, unknown>]> = [
      ["artifactWatchItemSchema", artifactWatchItemSchema, { loopId: "l", artifactDir: "d", workdir: null, roots: [], configRevision: 0 }],
      [
        "prepareArtifactSyncRequestSchema",
        prepareArtifactSyncRequestSchema,
        { requestId: "r", loopId: "l", configRevision: 0, baseManifestRevision: 0, entries: [] },
      ],
      ["machineLoopArtifactsResponseSchema", machineLoopArtifactsResponseSchema, { loopId: "l", artifactDir: "d", configRevision: 0, manifestRevision: 0 }],
      [
        "artifactSyncErrorReportRequestSchema",
        artifactSyncErrorReportRequestSchema,
        { failure: "timeout", configRevision: 0, baseManifestRevision: 0 },
      ],
      ["artifactSyncErrorReportResponseSchema", artifactSyncErrorReportResponseSchema, { ok: true, recorded: true }],
      ["deliveryArtifactConfigSchema", deliveryArtifactConfigSchema, { dir: "d", configRevision: 0 }],
      ["loopArtifactsResponseSchema", loopArtifactsResponseSchema, GOLDEN_LOOP_VIEW],
      ["runArtifactsBoundSchema", runArtifactsBoundSchema, GOLDEN_RUN_BOUND],
      ["runArtifactsMissingSchema", runArtifactsMissingSchema, GOLDEN_RUN_MISSING],
      ["artifactDownloadQuerySchema", artifactDownloadQuerySchema, { snapshotId: "s", path: "a/b.txt" }],
      ["artifactDiffQuerySchema", artifactDiffQuerySchema, { to: "s" }],
      ["artifactDiffResponseSchema", artifactDiffResponseSchema, GOLDEN_DIFF_RESPONSE],
    ];
    for (const [name, schema, golden] of goldens) {
      const parsed = schema.parse({ ...golden, namespaceId: "ns-secret" }) as Record<string, unknown>;
      expect(parsed, `${name}`).toEqual(golden);
      expectNoNamespaceKey(parsed);
    }
  });

  it("a namespaced NESTED payload strips away too (delivery artifact config)", () => {
    const delivery = {
      runId: "r_01",
      runToken: `rk_${"b2".repeat(16)}`,
      role: "exec",
      loop: {
        id: "loop-01",
        name: "nightly",
        workdir: null,
        taskFile: null,
        workflow: null,
        model: null,
        allowControl: true,
        artifact: { dir: "dist", configRevision: 2, namespaceId: "ns-secret" },
      },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "do it",
    };
    const parsed = deliverySchema.parse(delivery);
    expect(parsed.loop.artifact).toEqual({ dir: "dist", configRevision: 2 });
    expectNoNamespaceKey(parsed);
  });
});
