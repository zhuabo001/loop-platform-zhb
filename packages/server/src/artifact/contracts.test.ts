import { describe, expect, it } from "vitest";

import type { ArtifactAttribution, ArtifactAttributionResolver } from "./attribution.js";
import type { BlobKey, BlobStore, BlobStoreFailure } from "./blob-store.js";

/**
 * Compile-level evidence for the slice-1 contract freeze: the two internal
 * interfaces are satisfiable, their result unions discriminate, and the
 * failure literals stay exhaustively switchable. The stubs are THROWING
 * placeholders — not working implementations (the adapters and their shared
 * contract test land in slice 3); they double as the slice 2/3 fake starting
 * point.
 */

const blobStore: BlobStore = {
  writeVerified() {
    throw new Error("not implemented");
  },
  has() {
    throw new Error("not implemented");
  },
  read() {
    throw new Error("not implemented");
  },
};

const resolver: ArtifactAttributionResolver = {
  resolve() {
    throw new Error("not implemented");
  },
};

describe("artifact internal contracts (frozen in Batch 1 slice 1)", () => {
  it("BlobStore failure literals stay exhaustive and discriminable", () => {
    const failures: readonly BlobStoreFailure[] = [
      "invalid_key",
      "content_mismatch",
      "blob_missing",
      "not_regular_file",
      "storage_error",
    ];
    for (const failure of failures) {
      switch (failure) {
        case "invalid_key":
        case "content_mismatch":
        case "blob_missing":
        case "not_regular_file":
        case "storage_error":
          break;
        default: {
          const exhaustive: never = failure;
          throw new Error(`unhandled BlobStoreFailure: ${exhaustive as string}`);
        }
      }
    }
    expect(failures).toHaveLength(5);
  });

  it("the attribution union discriminates ok from attribution_missing", () => {
    const ok: ArtifactAttribution = { ok: true, namespaceId: "ns-1", machineId: "m-0123456789abcdef" };
    const missing: ArtifactAttribution = { ok: false, failure: "attribution_missing" };
    if (ok.ok) expect(ok.namespaceId).toBe("ns-1");
    if (!missing.ok) expect(missing.failure).toBe("attribution_missing");
    expect(ok.ok).toBe(true);
    expect(missing.ok).toBe(false);
  });

  it("the stubs satisfy the interfaces (compile-level) and refuse to work", async () => {
    const key: BlobKey = { namespaceId: "ns-1", hash: "a".repeat(64) };
    await expect(async () => blobStore.has(key)).rejects.toThrow("not implemented");
    await expect(async () => resolver.resolve({ machineId: "m-0123456789abcdef" })).rejects.toThrow("not implemented");
  });
});
