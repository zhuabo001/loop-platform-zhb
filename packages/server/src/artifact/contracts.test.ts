import { describe, expect, it } from "vitest";

import type { ArtifactAttribution, ArtifactAttributionResolver } from "./attribution.js";
import type {
  BlobPresenceFailure,
  BlobReadFailure,
  BlobStoreFailure,
  BlobStreamChunk,
} from "./blob-store.js";

/**
 * Compile-level evidence for the slice-1 contract freeze: the two internal
 * interfaces are satisfiable, their result unions discriminate, and the
 * failure literals stay exhaustively switchable. Slice 3 replaces the
 * throwing BlobStore stub with real adapters (blob-store-memory.ts,
 * blob-store-local.ts) running the ONE shared contract suite
 * (testkit/blob-store-contract.ts), so that stub is RETIRED here; the
 * attribution resolver stub remains — its implementation lands with the
 * ArtifactHome state machine (slice 4+).
 */

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

  it("pins the per-method failure sets (slice-1 review S1)", () => {
    // has(): a symlink/special file parked at the blob path is an ANOMALY
    // (not_regular_file), never a clean "missing" — that would route it onto
    // the re-upload path. content_mismatch is a write-side failure only.
    const presence: readonly BlobPresenceFailure[] = ["invalid_key", "not_regular_file", "storage_error"];
    expect(presence).toHaveLength(3);
    // read() opening failures: everything except content_mismatch (reading
    // never re-verifies content; the write path already did).
    const readFailures: readonly BlobReadFailure[] = [
      "invalid_key",
      "blob_missing",
      "not_regular_file",
      "storage_error",
    ];
    expect(readFailures).toHaveLength(4);
  });

  it("a MID-STREAM storage failure is a terminal stream element, never a throw (S1)", async () => {
    // Fake stream: two good chunks, then the disk fails mid-read. The
    // consumer classifies the failure by branching on the union — no
    // try/catch around the iteration. Once {ok:false} arrives the stream is
    // over (terminal element).
    async function* failingStream(): AsyncIterable<BlobStreamChunk> {
      yield { ok: true, chunk: new Uint8Array([1, 2]) };
      yield { ok: true, chunk: new Uint8Array([3]) };
      yield { ok: false, failure: "storage_error", cause: new Error("EIO") };
    }
    const received: number[] = [];
    let terminal: string | null = null;
    for await (const element of failingStream()) {
      if (element.ok) received.push(...element.chunk);
      else terminal = element.failure;
    }
    expect(received).toEqual([1, 2, 3]);
    expect(terminal).toBe("storage_error");
    // Type-level pin: only storage_error can occur mid-stream.
    const bad: Extract<BlobStreamChunk, { ok: false }> = { ok: false, failure: "storage_error" };
    expect(bad.failure).toBe("storage_error");
  });

  it("the attribution union discriminates ok from attribution_missing", () => {
    const ok: ArtifactAttribution = { ok: true, namespaceId: "ns-1", machineId: "m-0123456789abcdef" };
    const missing: ArtifactAttribution = { ok: false, failure: "attribution_missing" };
    if (ok.ok) expect(ok.namespaceId).toBe("ns-1");
    if (!missing.ok) expect(missing.failure).toBe("attribution_missing");
    expect(ok.ok).toBe(true);
    expect(missing.ok).toBe(false);
  });

  it("the attribution resolver stub satisfies its interface (compile-level) and refuses to work", async () => {
    await expect(async () => resolver.resolve({ machineId: "m-0123456789abcdef" })).rejects.toThrow("not implemented");
  });
});
