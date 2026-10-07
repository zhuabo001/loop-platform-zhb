/**
 * Artifact hash cache pins (slice 3, ADR-010 决策 23): the five-field reuse
 * rule (each field independently invalidates), FIFO eviction at the bound,
 * and the bound itself — 4× the shared manifest entry ceiling.
 */
import { ARTIFACT_MANIFEST_MAX_ENTRIES } from "@loopzhb/protocol";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_HASH_CACHE_MAX_ENTRIES,
  createArtifactHashCache,
  sameArtifactFileIdentity,
  type ArtifactHashCacheEntry,
} from "./artifact-hash-cache.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const entry = (overrides: Partial<ArtifactHashCacheEntry> = {}): ArtifactHashCacheEntry => ({
  dev: 1,
  ino: 2,
  size: 3,
  mtimeMs: 4.5,
  ctimeMs: 6.5,
  hash: HASH_A,
  ...overrides,
});

describe("ARTIFACT_HASH_CACHE_MAX_ENTRIES", () => {
  it("is four times the shared manifest entry ceiling", () => {
    expect(ARTIFACT_HASH_CACHE_MAX_ENTRIES).toBe(4 * ARTIFACT_MANIFEST_MAX_ENTRIES);
    expect(ARTIFACT_HASH_CACHE_MAX_ENTRIES).toBe(20_000);
  });
});

describe("sameArtifactFileIdentity", () => {
  it("accepts an exact five-field match", () => {
    expect(sameArtifactFileIdentity(entry(), entry())).toBe(true);
  });

  it("rejects when EACH field individually differs (never size-only)", () => {
    const cached = entry();
    expect(sameArtifactFileIdentity(cached, entry({ dev: 99 }))).toBe(false);
    expect(sameArtifactFileIdentity(cached, entry({ ino: 99 }))).toBe(false);
    expect(sameArtifactFileIdentity(cached, entry({ size: 99 }))).toBe(false);
    expect(sameArtifactFileIdentity(cached, entry({ mtimeMs: 99.5 }))).toBe(false);
    expect(sameArtifactFileIdentity(cached, entry({ ctimeMs: 99.5 }))).toBe(false);
  });

  it("rejects a same-size rewrite that only moved the timestamps", () => {
    // The exact shape a size-only comparison would let through.
    const cached = entry({ size: 4096, mtimeMs: 100.25 });
    const rewritten = entry({ size: 4096, mtimeMs: 100.5, ctimeMs: 100.5 });
    expect(sameArtifactFileIdentity(cached, rewritten)).toBe(false);
  });
});

describe("createArtifactHashCache", () => {
  it("stores, reads back, deletes and clears", () => {
    const cache = createArtifactHashCache();
    expect(cache.size).toBe(0);
    expect(cache.get("/a")).toBeUndefined();
    cache.set("/a", entry({ hash: HASH_A }));
    cache.set("/b", entry({ hash: HASH_B }));
    expect(cache.size).toBe(2);
    expect(cache.get("/a")?.hash).toBe(HASH_A);
    expect(cache.get("/b")?.hash).toBe(HASH_B);
    cache.delete("/a");
    expect(cache.size).toBe(1);
    expect(cache.get("/a")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("evicts in insertion order once the bound is reached (FIFO)", () => {
    const cache = createArtifactHashCache(2);
    cache.set("/a", entry({ ino: 1 }));
    cache.set("/b", entry({ ino: 2 }));
    cache.set("/c", entry({ ino: 3 }));
    expect(cache.size).toBe(2);
    expect(cache.get("/a")).toBeUndefined(); // oldest evicted
    expect(cache.get("/b")?.ino).toBe(2);
    expect(cache.get("/c")?.ino).toBe(3);
  });

  it("updates an existing key in place without refreshing its FIFO position", () => {
    const cache = createArtifactHashCache(2);
    cache.set("/a", entry({ ino: 1 }));
    cache.set("/b", entry({ ino: 2 }));
    cache.set("/a", entry({ ino: 10 })); // same key, new value
    expect(cache.size).toBe(2);
    cache.set("/c", entry({ ino: 3 })); // must evict /a (still the oldest)
    expect(cache.get("/a")).toBeUndefined();
    expect(cache.get("/b")?.ino).toBe(2);
    expect(cache.get("/c")?.ino).toBe(3);
  });

  it("holds the full default bound without evicting", () => {
    const cache = createArtifactHashCache(ARTIFACT_HASH_CACHE_MAX_ENTRIES);
    for (let i = 0; i < ARTIFACT_HASH_CACHE_MAX_ENTRIES; i++) cache.set(`/p/${i}`, entry({ ino: i }));
    expect(cache.size).toBe(ARTIFACT_HASH_CACHE_MAX_ENTRIES);
    expect(cache.get("/p/0")?.ino).toBe(0); // the very first entry survives
  });

  it("refuses a non-positive or non-integer bound (programmer error, fail closed)", () => {
    expect(() => createArtifactHashCache(0)).toThrow();
    expect(() => createArtifactHashCache(-1)).toThrow();
    expect(() => createArtifactHashCache(1.5)).toThrow();
    expect(() => createArtifactHashCache(Number.NaN)).toThrow();
  });
});
