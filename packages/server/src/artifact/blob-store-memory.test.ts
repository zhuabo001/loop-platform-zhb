/**
 * Memory BlobStore adapter — runs the ONE shared contract suite
 * (testkit/blob-store-contract.ts, AB3/AB9/AB10) plus the memory-specific
 * pins below. The local adapter runs the same suite in
 * blob-store-local.test.ts — that is the AB10 dual-adapter parity.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { BlobStreamChunk } from "./blob-store.js";
import { createMemoryBlobStore } from "./blob-store-memory.js";
import { runBlobStoreContractSuite, type BlobStoreHarness } from "../testkit/blob-store-contract.js";

function keyString(key: { namespaceId: string; hash: string }): string {
  return `${key.namespaceId}/${key.hash}`;
}

function makeHarness(): BlobStoreHarness {
  const notRegularKeys = new Set<string>();
  const failReadAfterChunks = new Map<string, number>();
  return {
    store: createMemoryBlobStore({ faults: { notRegularKeys, failReadAfterChunks } }),
    faults: {
      parkNotRegular(key) {
        notRegularKeys.add(keyString(key));
      },
      failMidRead(key, afterChunks = 1) {
        failReadAfterChunks.set(keyString(key), afterChunks);
      },
    },
    async cleanup() {},
  };
}

runBlobStoreContractSuite("memory", makeHarness);

describe("memory BlobStore specifics", () => {
  it("a stored blob is immune to later source-buffer mutation (copy on store)", async () => {
    const store = createMemoryBlobStore();
    const source = new Uint8Array([1, 2, 3]);
    const key = { namespaceId: "ns-1", hash: createHash("sha256").update(source).digest("hex") };
    await store.writeVerified({
      ...key,
      expectedSize: 3,
      bytes: (async function* () {
        yield source;
      })(),
    });
    source[0] = 99; // mutate the caller's buffer AFTER the write
    const rd = await store.read(key);
    expect(rd.ok).toBe(true);
    if (!rd.ok) throw new Error("unreachable");
    const elements: BlobStreamChunk[] = [];
    for await (const element of rd.bytes) elements.push(element);
    const received = Buffer.concat(elements.flatMap((e) => (e.ok ? [Buffer.from(e.chunk)] : [])));
    expect(received.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("chunks a consumer mutates are copies — the stored blob does not change", async () => {
    const store = createMemoryBlobStore();
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const key = { namespaceId: "ns-1", hash: createHash("sha256").update(bytes).digest("hex") };
    await store.writeVerified({
      ...key,
      expectedSize: 4,
      bytes: (async function* () {
        yield bytes;
      })(),
    });
    const first = await store.read(key);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    for await (const element of first.bytes) {
      if (element.ok) element.chunk[0] = 0; // corrupt the delivered chunk
    }
    const second = await store.read(key);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    const elements: BlobStreamChunk[] = [];
    for await (const element of second.bytes) elements.push(element);
    const received = Buffer.concat(elements.flatMap((e) => (e.ok ? [Buffer.from(e.chunk)] : [])));
    expect(received.equals(Buffer.from([7, 7, 7, 7]))).toBe(true);
  });
});
