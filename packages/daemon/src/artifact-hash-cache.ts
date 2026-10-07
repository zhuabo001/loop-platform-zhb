/**
 * The artifact hash cache (Phase 5 Batch 2 slice 3, ADR-010 决策 23): the
 * per-daemon memo of absolute path → verified file identity + SHA-256.
 *
 * Reuse requires the FULL five-field identity to match — dev, ino, size,
 * mtimeMs, ctimeMs — never size alone (plan §1: "其他缓存需比较
 * size/mtime/ctime 与文件身份，不能仅凭大小复用"). A same-size rewrite moves
 * mtime/ctime; a swap-and-recreate moves dev/ino.
 *
 * Scope (slice 3): the mechanism plus its pins. The scanner rehashes every
 * file by default; only the slice-5 event path opts into cached reuse, and
 * the pre-upload verifier ALWAYS re-reads. The cache is a plain in-memory map
 * the CALLER owns — no singleton, no timers, no I/O. Eviction is
 * insertion-order FIFO at a bound derived from the manifest entry ceiling; a
 * bounded scan can never legitimately visit more, so the cache never needs to
 * hold more either.
 */
import { ARTIFACT_MANIFEST_MAX_ENTRIES } from "@loopzhb/protocol";

/** The five fields that must ALL match before a cached hash may be reused.
 *  Node's Stats exposes mtimeMs/ctimeMs as float milliseconds; the comparison
 *  is exact (same source, same representation). */
export interface ArtifactFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ArtifactHashCacheEntry extends ArtifactFileIdentity {
  /** Lowercase hex SHA-256 of the file's bytes (ARTIFACT_HASH_RE shape). */
  hash: string;
}

export interface ArtifactHashCache {
  get(absolutePath: string): ArtifactHashCacheEntry | undefined;
  set(absolutePath: string, entry: ArtifactHashCacheEntry): void;
  delete(absolutePath: string): void;
  clear(): void;
  readonly size: number;
}

/** A scan visits bounded dirents (4× the entry cap) and only fully verified
 *  reads enter the cache, so this bound cannot evict a live scan's entries. */
export const ARTIFACT_HASH_CACHE_MAX_ENTRIES = 4 * ARTIFACT_MANIFEST_MAX_ENTRIES;

/** True when `observed` may reuse `cached`'s hash: every identity field is
 *  equal. Deliberately NOT a size-only shortcut — a same-size rewrite would
 *  slip through (ADR-010 决策 23). */
export function sameArtifactFileIdentity(cached: ArtifactFileIdentity, observed: ArtifactFileIdentity): boolean {
  return (
    cached.dev === observed.dev &&
    cached.ino === observed.ino &&
    cached.size === observed.size &&
    cached.mtimeMs === observed.mtimeMs &&
    cached.ctimeMs === observed.ctimeMs
  );
}

export function createArtifactHashCache(maxEntries: number = ARTIFACT_HASH_CACHE_MAX_ENTRIES): ArtifactHashCache {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error(`artifact hash cache bound must be a positive safe integer: ${maxEntries}`);
  }
  // Map iteration order IS insertion order, which is the FIFO queue. A set()
  // of an EXISTING key updates the value without moving it to the back
  // (FIFO, not LRU — the cache is a per-scan memo, not a hot set).
  const entries = new Map<string, ArtifactHashCacheEntry>();
  return {
    get(absolutePath) {
      return entries.get(absolutePath);
    },
    set(absolutePath, entry) {
      if (!entries.has(absolutePath) && entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(absolutePath, entry);
    },
    delete(absolutePath) {
      entries.delete(absolutePath);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
