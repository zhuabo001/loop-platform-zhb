/**
 * Pre-upload verification (Phase 5 Batch 2 slice 3, plan §2 Slice 3 /
 * ADR-010 决策 23): re-read ONE manifest entry from disk and prove it still
 * matches the hash and size the manifest declares, immediately before those
 * bytes are sent. The scanner's consistency is point-in-time; this is what
 * covers the drift between the scan and the upload ("上传前重新读取并验证
 * hash/size" — 决策 13).
 *
 * Two rules that are easy to get wrong:
 *
 *  - the cache is NEVER a fast path here (U3). Verification always re-reads
 *    and recomputes; a cached hash may only be WRITTEN back afterwards, so
 *    the slice-5 event path can reuse it.
 *  - the containment guard runs FIRST and refuses without touching the disk:
 *    a path that escapes the resolved root (an absolute path, a `..` chain)
 *    is `changed`, never read, never even lstat'ed.
 */
import path from "node:path";

import { ARTIFACT_FILE_MAX_BYTES, type NormalizedManifestEntry } from "@loopzhb/protocol";

import type { ArtifactHashCache } from "./artifact-hash-cache.js";
import type { ResolvedArtifactRoot } from "./artifact-jail.js";
import { isWithinOrEqual } from "./jail.js";
import { readArtifactFile, type ArtifactScanIo } from "./artifact-scan.js";

/** Deliberately FINER than the wire taxonomy: the caller (slice 4) maps
 *  `changed`/`missing` onto the `unstable` re-scan-and-report path and passes
 *  the rest through unchanged. The shared nine-value taxonomy gains no
 *  member. */
export type ArtifactVerifyFailure = "changed" | "missing" | "unreadable" | "symlink" | "special_file" | "too_large";

export type ArtifactVerifyResult =
  | { kind: "ok"; entry: NormalizedManifestEntry }
  | { kind: "failed"; failure: ArtifactVerifyFailure; detail: string };

export async function verifyArtifactEntry(
  resolved: ResolvedArtifactRoot,
  /** A path/hash/size triple that already passed the shared policy — normally
   *  an entry of the scan's own output. */
  expected: { path: string; hash: string; size: number },
  options: { cache: ArtifactHashCache; io?: ArtifactScanIo },
): Promise<ArtifactVerifyResult> {
  // Containment before any I/O: resolve() collapses `..` and lets an absolute
  // path win outright, and the lexical containment test then refuses both.
  const absolutePath = path.resolve(resolved.root, expected.path);
  if (!isWithinOrEqual(resolved.root, absolutePath)) {
    return {
      kind: "failed",
      failure: "changed",
      detail: `entry escapes the artifact root: ${JSON.stringify(expected.path)}`,
    };
  }
  const read = await readArtifactFile(absolutePath, { maxBytes: ARTIFACT_FILE_MAX_BYTES, io: options.io });
  if (read.kind !== "ok") {
    if (read.kind === "changed") {
      return { kind: "failed", failure: "changed", detail: `entry changed while being verified: ${JSON.stringify(expected.path)}` };
    }
    return { kind: "failed", failure: read.kind, detail: `entry is not verifiable (${read.kind}): ${JSON.stringify(expected.path)}` };
  }
  if (read.hash !== expected.hash || read.size !== expected.size) {
    return {
      kind: "failed",
      failure: "changed",
      detail: `entry content moved since the scan: ${JSON.stringify(expected.path)}`,
    };
  }
  // Only a fully verified read is cached — and only AFTER the comparison.
  options.cache.set(absolutePath, read.identity);
  return { kind: "ok", entry: { path: expected.path, hash: read.hash, size: read.size } };
}
