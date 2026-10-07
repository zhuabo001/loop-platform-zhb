/**
 * The artifact tree scanner (Phase 5 Batch 2 slice 3, plan §2 Slice 3 /
 * ADR-010 决策 23): turn a resolved artifact root into the CURRENT COMPLETE
 * manifest, or one closed failure class. There is no third outcome — a
 * partial manifest would DELETE the absent paths on commit, so a scan that
 * cannot be trusted fails instead.
 *
 * The invariants, in the order they are enforced:
 *
 *  - never-sync pruning happens BEFORE any I/O: a pruned directory is not
 *    descended, a pruned file is not lstat'ed and not opened. A secret file
 *    must never be opened even once.
 *  - a path that the wire cannot represent never enters the manifest, and is
 *    never skipped or truncated: the whole scan fails (mapping in
 *    `mapPathFailure`).
 *  - any symlink or special file inside the tree fails the WHOLE scan; the
 *    target is never read (unlike the Phase 4 task file, which follows a
 *    symlink aliasing the same file — that behaviour is deliberately NOT
 *    reused here).
 *  - every regular file is read through the shared no-follow bounded read
 *    and re-checked afterwards: pre-lstat and post-lstat must agree on
 *    dev/ino/size/mtime/ctime AND the bytes read must match the size. A file
 *    that grows, shrinks, is rewritten or is swapped between the two lstats
 *    is a "dirty" observation.
 *  - every visited directory is re-checked after its subtree, so an entry
 *    added, removed or renamed while it was being enumerated also marks the
 *    attempt dirty. A dirty attempt is DISCARDED whole and rescanned, up to
 *    ARTIFACT_SCAN_MAX_ATTEMPTS; a tree that never settles is `unstable`.
 *  - a re-check the kernel REFUSES (EACCES/EPERM, …) is not a change: it is
 *    the deterministic `unreadable` failure and is reported at once, never
 *    retried three times and mislabelled `unstable` (review #88).
 *
 * Residual (same wording as bounded-read.ts): O_NOFOLLOW guards only the
 * terminal path component, and a swapped INTERMEDIATE directory between the
 * caller's realpath and this open is out of Node's cross-platform reach. Scan
 * consistency is point-in-time up to each read; drift between a read and the
 * later upload is the upload-time verifier's job (artifact-verify.ts).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_MANIFEST_MAX_ENTRIES,
  ARTIFACT_MANIFEST_MAX_TOTAL_BYTES,
  isNeverSyncPath,
  normalizeManifestEntries,
  validateArtifactPath,
  type ArtifactManifestFailure,
  type ArtifactPathFailure,
  type NormalizedManifestEntry,
} from "@loopzhb/protocol";

import { sameArtifactFileIdentity, type ArtifactHashCache, type ArtifactHashCacheEntry } from "./artifact-hash-cache.js";
import type { ArtifactScanFailure, ResolvedArtifactRoot } from "./artifact-jail.js";
import { readRegularFileNoFollow } from "./bounded-read.js";

/** The numeric (non-bigint) lstat result — the daemon never opts into bigint. */
type FileStat = Stats;

/** TEST-ONLY seams (the spawnImpl/openImpl precedent): the scanner's own I/O
 *  passes through here so a test can replay a swap, an EACCES, a special file,
 *  or an entry created mid-enumeration without racing the real filesystem. */
export interface ArtifactScanIo {
  open?: typeof fs.open;
  lstat?: (absolutePath: string) => Promise<FileStat>;
  listNames?: (dir: string, max: number) => Promise<string[]>;
}

/** TEST-ONLY overrides; the production values ARE the shared policy (ADR-010
 *  决策 3), pinned by test. `maxVisitedDirents` is a DAEMON-LOCAL denial-of-
 *  service bound, not a wire policy: the server neither enforces nor knows it. */
export interface ArtifactScanLimits {
  fileMaxBytes: number;
  manifestMaxEntries: number;
  manifestMaxTotalBytes: number;
  maxVisitedDirents: number;
}

export const ARTIFACT_SCAN_DEFAULT_LIMITS: Readonly<ArtifactScanLimits> = Object.freeze({
  fileMaxBytes: ARTIFACT_FILE_MAX_BYTES,
  manifestMaxEntries: ARTIFACT_MANIFEST_MAX_ENTRIES,
  manifestMaxTotalBytes: ARTIFACT_MANIFEST_MAX_TOTAL_BYTES,
  maxVisitedDirents: 4 * ARTIFACT_MANIFEST_MAX_ENTRIES,
});

/** A dirty attempt is discarded and rescanned; the third dirty attempt is
 *  reported as `unstable` rather than looping forever on a busy tree. */
export const ARTIFACT_SCAN_MAX_ATTEMPTS = 3;

export type ArtifactScanResult =
  | { kind: "ok"; root: string; entries: NormalizedManifestEntry[] }
  /** The caller's signal aborted the scan (slice-5 drain, slice-6 deadline):
   *  a structural NON-result — never a partial manifest, never a failure class
   *  to report. */
  | { kind: "cancelled" }
  | { kind: "failed"; failure: ArtifactScanFailure; detail: string };

export interface ArtifactScanOptions {
  cache: ArtifactHashCache;
  /** Default FALSE = rehash every file (startup / 60 s / run-final scans).
   *  TRUE reuses a cached hash only on an exact five-field identity match —
   *  the slice-5 event path opts in; slice 3 only pins the mechanism. */
  reuseCachedHashes?: boolean;
  limits?: Partial<ArtifactScanLimits>;
  io?: ArtifactScanIo;
  /** Cooperative cancellation (ADR-010 决策 25): checked at the rescan-loop,
   *  per traversal frame and per entry. Aborting returns `{kind:"cancelled"}`
   *  — the scan owns no partial state, so there is structurally no truncated
   *  manifest. `undefined` (the default) is byte-identical to slice 3. */
  signal?: AbortSignal;
}

/** Raised when the shared policy rejects an entry the scanner itself built:
 *  the scanner's own invariant is broken, so it must NOT be reported as a
 *  legitimate failure class (ADR-010 决策 23). */
export class ArtifactScanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactScanInvariantError";
  }
}

export type ArtifactFileRead =
  | { kind: "ok"; hash: string; size: number; identity: ArtifactHashCacheEntry }
  /** The path disappeared between the caller's lstat and the read. */
  | { kind: "missing" }
  /** The path stopped being the SAME regular file (identity or size moved). */
  | { kind: "changed" }
  | { kind: "symlink" }
  | { kind: "special_file" }
  | { kind: "unreadable" }
  | { kind: "too_large" };

/** `ArtifactFileRead` plus the BYTES that were hashed, so an uploader can send
 *  exactly what it verified (ADR-010 决策 24): a second read of the path would reopen the
 *  verify→upload window this closes. Same failure arms, same classification. */
export type ArtifactFileBytesRead =
  | { kind: "ok"; hash: string; size: number; identity: ArtifactHashCacheEntry; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "changed" }
  | { kind: "symlink" }
  | { kind: "special_file" }
  | { kind: "unreadable" }
  | { kind: "too_large" };

/** One bounded, no-follow, identity-verified read of a regular file — the
 *  scan's and the pre-upload verifier's single read path, kept in ONE place so
 *  the byte-returning and byte-less forms can never drift apart. `preStat` is
 *  the caller's own lstat when it already has one; the post-read lstat runs
 *  here regardless (it is the check that makes the hash trustworthy). */
export async function readArtifactFileWithBytes(
  absolutePath: string,
  options: { maxBytes: number; preStat?: FileStat; io?: ArtifactScanIo },
): Promise<ArtifactFileBytesRead> {
  const lstat = options.io?.lstat ?? fs.lstat;
  let before: FileStat;
  if (options.preStat !== undefined) {
    before = options.preStat;
  } else {
    try {
      before = await lstat(absolutePath);
    } catch (error) {
      return classifyStatError(error) === "missing" ? { kind: "missing" } : { kind: "unreadable" };
    }
  }
  if (before.isSymbolicLink()) return { kind: "symlink" };
  if (!before.isFile()) return { kind: "special_file" };
  if (before.size > options.maxBytes) return { kind: "too_large" };

  const read = await readRegularFileNoFollow(absolutePath, options.maxBytes, options.io?.open);
  if (read.kind === "not_found") return { kind: "missing" };
  if (read.kind === "not_regular") return { kind: "special_file" };
  if (read.kind !== "ok") return { kind: read.kind };

  let after: FileStat;
  try {
    after = await lstat(absolutePath);
  } catch (error) {
    // A path that MOVED is a transient observation (dirty, rescan); a kernel
    // refusal is deterministic and must be reported as `unreadable` at once.
    return classifyRecheckError(error) === "moved" ? { kind: "changed" } : { kind: "unreadable" };
  }
  if (after.isSymbolicLink() || !after.isFile()) return { kind: "changed" };
  // The same file, before and after — and the same file the fd was opened on.
  if (!sameArtifactFileIdentity(before, after)) return { kind: "changed" };
  if (read.dev !== after.dev || read.ino !== after.ino) return { kind: "changed" };
  if (read.bytes.length !== after.size) return { kind: "changed" };
  const hash = createHash("sha256").update(read.bytes).digest("hex");
  return {
    kind: "ok",
    hash,
    size: after.size,
    identity: { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, hash },
    bytes: read.bytes,
  };
}

/** The same pipeline with the bytes dropped: the scan wants only the identity,
 *  and not retaining the buffer lets each file's contents go as soon as its
 *  hash is taken. Failure arms pass through unchanged. */
export async function readArtifactFile(
  absolutePath: string,
  options: { maxBytes: number; preStat?: FileStat; io?: ArtifactScanIo },
): Promise<ArtifactFileRead> {
  const read = await readArtifactFileWithBytes(absolutePath, options);
  if (read.kind !== "ok") return read;
  return { kind: "ok", hash: read.hash, size: read.size, identity: read.identity };
}

export async function scanArtifactRoot(
  resolved: ResolvedArtifactRoot,
  options: ArtifactScanOptions,
): Promise<ArtifactScanResult> {
  const limits: ArtifactScanLimits = { ...ARTIFACT_SCAN_DEFAULT_LIMITS, ...options.limits };
  const reuseCachedHashes = options.reuseCachedHashes ?? false;
  for (let attempt = 1; attempt <= ARTIFACT_SCAN_MAX_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { kind: "cancelled" };
    const outcome = await walkAttempt(resolved, limits, reuseCachedHashes, options.cache, options.io, options.signal);
    if (outcome.kind === "aborted") return { kind: "cancelled" };
    if (outcome.kind === "failed") return outcome;
    if (!outcome.dirty) return closeOut(resolved, outcome.entries);
  }
  return {
    kind: "failed",
    failure: "unstable",
    detail: `artifact tree kept changing across ${ARTIFACT_SCAN_MAX_ATTEMPTS} scan attempts`,
  };
}

// ---- traversal ----

type DirIdentity = Pick<ArtifactHashCacheEntry, "dev" | "ino" | "mtimeMs" | "ctimeMs">;

type Frame =
  | { kind: "dir"; absDir: string; relPrefix: string; identity: DirIdentity }
  /** Re-checked AFTER the subtree, so an entry added or removed while the
   *  directory was being enumerated marks the attempt dirty. */
  | { kind: "check"; absDir: string; identity: DirIdentity };

type WalkOutcome =
  | { kind: "failed"; failure: ArtifactScanFailure; detail: string }
  /** Cooperative cancellation (决策 25): like a failure, it structurally
   *  carries NO partial manifest. */
  | { kind: "aborted" }
  | { kind: "ok"; entries: NormalizedManifestEntry[]; dirty: boolean };

const dirIdentity = (stat: FileStat): DirIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

const sameDirIdentity = (a: DirIdentity, b: DirIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function classifyStatError(error: unknown): "missing" | "symlink" | "unreadable" {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "ELOOP") return "symlink";
  return "unreadable";
}

/** The post-read and post-subtree RE-checks answer a different question from
 *  the first inspection: did the path MOVE (a transient observation — the
 *  attempt is dirty and gets rescanned) or did the kernel REFUSE to look at
 *  it (a deterministic failure that must surface at once, review #88)? A
 *  terminal symlink is caught by a SUCCESSFUL lstat, so ELOOP here means an
 *  INTERMEDIATE component changed. */
function classifyRecheckError(error: unknown): "moved" | "unreadable" {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return "moved";
  return "unreadable";
}

/** The wire cannot represent this path, so the WHOLE scan fails. `path_too_long`
 *  belongs to the capacity group; every other defensive rejection is
 *  `unreadable` with the reason in the detail. Never skip, never truncate. */
function mapPathFailure(failure: ArtifactPathFailure): ArtifactScanFailure {
  switch (failure) {
    case "path_too_long":
      return "too_large";
    case "path_empty":
    case "path_contains_nul":
    case "path_malformed_unicode":
    case "path_backslash":
    case "path_absolute":
    case "path_drive_letter":
    case "path_empty_segment":
    case "path_dot_segment":
      return "unreadable";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/** The close-out classification for a shared-policy rejection the scanner
 *  believes it made impossible: `"invariant"` means the scanner's own
 *  bookkeeping is broken and the scan must throw, not invent a failure class. */
function classifyManifestFailure(failure: ArtifactManifestFailure): ArtifactScanFailure | "invariant" {
  switch (failure) {
    // Reachable only through a limits override above the shared constants.
    case "path_too_long":
    case "file_too_large":
    case "too_many_entries":
    case "manifest_too_large":
      return "too_large";
    case "path_empty":
    case "path_contains_nul":
    case "path_malformed_unicode":
    case "path_backslash":
    case "path_absolute":
    case "path_drive_letter":
    case "path_empty_segment":
    case "path_dot_segment":
      return "unreadable";
    // Impossible from a correct walk: pruning, dedupe, the authoritative hash
    // and the bounded read make each of these unreachable.
    case "path_never_sync":
    case "hash_malformed":
    case "size_invalid":
    case "duplicate_path":
    case "file_dir_conflict":
    case "hash_size_mismatch":
      return "invariant";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function closeOut(resolved: ResolvedArtifactRoot, entries: readonly NormalizedManifestEntry[]): ArtifactScanResult {
  const validation = normalizeManifestEntries(entries);
  if (!validation.ok) {
    const failure = classifyManifestFailure(validation.failure);
    if (failure === "invariant") {
      throw new ArtifactScanInvariantError(
        `artifact scan produced an entry the shared policy rejects as impossible: ${validation.failure} at ${JSON.stringify(validation.path ?? validation.index ?? "?")}`,
      );
    }
    // A reachable rejection (only through a limits override) still reports the
    // class the wire understands — the entries map back to a detail.
    return { kind: "failed", failure, detail: `shared policy rejected the scan: ${validation.failure}` };
  }
  return { kind: "ok", root: resolved.root, entries: validation.entries };
}

/** Streaming, bounded name enumeration (the journal.ts template): always
 *  closed, stops the moment the budget is exceeded so a directory holding a
 *  million entries cannot be materialised. */
export async function listDirectoryNames(dir: string, max: number): Promise<string[]> {
  const names: string[] = [];
  const handle = await fs.opendir(dir);
  try {
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > max) break;
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return names;
}

async function walkAttempt(
  resolved: ResolvedArtifactRoot,
  limits: ArtifactScanLimits,
  reuseCachedHashes: boolean,
  cache: ArtifactHashCache,
  io: ArtifactScanIo | undefined,
  signal: AbortSignal | undefined,
): Promise<WalkOutcome> {
  const lstat = io?.lstat ?? fs.lstat;
  const listNames = io?.listNames ?? listDirectoryNames;
  const collected = new Map<string, NormalizedManifestEntry>();
  let totalBytes = 0;
  let visitedDirents = 0;
  let dirty = false;

  let rootStat: FileStat;
  try {
    rootStat = await lstat(resolved.root);
  } catch (error) {
    const failure = classifyStatError(error);
    if (failure === "missing") {
      return { kind: "failed", failure: "directory_missing", detail: `artifact root vanished: ${JSON.stringify(resolved.root)}` };
    }
    return { kind: "failed", failure, detail: `artifact root could not be inspected: ${JSON.stringify(resolved.root)}` };
  }
  if (rootStat.isSymbolicLink()) {
    return { kind: "failed", failure: "symlink", detail: `artifact root became a symlink: ${JSON.stringify(resolved.root)}` };
  }
  if (!rootStat.isDirectory()) {
    return { kind: "failed", failure: "directory_missing", detail: `artifact root is not a directory: ${JSON.stringify(resolved.root)}` };
  }

  const stack: Frame[] = [
    { kind: "dir", absDir: resolved.root, relPrefix: "", identity: dirIdentity(rootStat) },
  ];
  while (stack.length > 0) {
    if (signal?.aborted) return { kind: "aborted" };
    const frame = stack.pop()!;
    if (frame.kind === "check") {
      let after: FileStat;
      try {
        after = await lstat(frame.absDir);
      } catch (error) {
        if (classifyRecheckError(error) === "moved") {
          dirty = true;
          continue;
        }
        // A refused re-check is deterministic — never a third retry of a
        // permission fault (review #88).
        return {
          kind: "failed",
          failure: "unreadable",
          detail: `directory could not be re-checked: ${JSON.stringify(frame.absDir)}`,
        };
      }
      if (after.isSymbolicLink() || !after.isDirectory() || !sameDirIdentity(frame.identity, dirIdentity(after))) {
        dirty = true;
      }
      continue;
    }

    const remaining = limits.maxVisitedDirents - visitedDirents;
    let names: string[];
    try {
      names = await listNames(frame.absDir, remaining + 1); // +1 so the overflow is observable
    } catch (error) {
      const classified = classifyStatError(error);
      if (classified === "missing") {
        dirty = true; // the directory vanished while scanning — rescan
        continue;
      }
      return { kind: "failed", failure: classified, detail: `directory could not be listed: ${JSON.stringify(frame.absDir)}` };
    }
    visitedDirents += names.length;
    if (names.length > remaining) {
      return {
        kind: "failed",
        failure: "too_large",
        detail: `scan visited more than ${limits.maxVisitedDirents} directory entries`,
      };
    }
    // readdir order is not guaranteed; the traversal must be deterministic.
    names.sort();
    stack.push({ kind: "check", absDir: frame.absDir, identity: frame.identity });
    const childDirs: Frame[] = [];

    for (const name of names) {
      if (signal?.aborted) return { kind: "aborted" };
      const relPath = frame.relPrefix === "" ? name : `${frame.relPrefix}/${name}`;
      // Prune BEFORE any I/O: no lstat, no open, no descent.
      if (isNeverSyncPath(relPath)) continue;
      const pathCheck = validateArtifactPath(relPath);
      if (!pathCheck.ok) {
        return {
          kind: "failed",
          failure: mapPathFailure(pathCheck.failure),
          detail: `path is not representable on the wire (${pathCheck.failure}): ${JSON.stringify(relPath)}`,
        };
      }
      const absPath = path.join(frame.absDir, name);
      let stat: FileStat;
      try {
        stat = await lstat(absPath);
      } catch (error) {
        const classified = classifyStatError(error);
        if (classified === "missing") {
          dirty = true; // added/removed while scanning — rescan
          continue;
        }
        return { kind: "failed", failure: classified, detail: `entry could not be inspected: ${JSON.stringify(absPath)}` };
      }
      // A symlink INSIDE the tree fails the whole scan; the target is never
      // followed, never read (the task file's alias following is NOT reused).
      if (stat.isSymbolicLink()) {
        return { kind: "failed", failure: "symlink", detail: `symlink inside the artifact tree: ${JSON.stringify(relPath)}` };
      }
      if (stat.isDirectory()) {
        childDirs.push({ kind: "dir", absDir: absPath, relPrefix: relPath, identity: dirIdentity(stat) });
        continue;
      }
      if (!stat.isFile()) {
        return { kind: "failed", failure: "special_file", detail: `special file inside the artifact tree: ${JSON.stringify(relPath)}` };
      }
      // Capacity checks BEFORE the read: an over-limit tree never opens its
      // files (the same bounds the shared policy re-applies at close-out).
      if (stat.size > limits.fileMaxBytes) {
        return { kind: "failed", failure: "too_large", detail: `file over the per-file ceiling: ${JSON.stringify(relPath)}` };
      }
      if (collected.size >= limits.manifestMaxEntries) {
        return { kind: "failed", failure: "too_large", detail: `more than ${limits.manifestMaxEntries} entries in the manifest` };
      }
      if (totalBytes + stat.size > limits.manifestMaxTotalBytes) {
        return { kind: "failed", failure: "too_large", detail: `manifest over ${limits.manifestMaxTotalBytes} bytes` };
      }

      let entry: ArtifactHashCacheEntry | undefined;
      if (reuseCachedHashes) {
        const cached = cache.get(absPath);
        // Never a size-only shortcut: all five identity fields must match.
        if (cached !== undefined && sameArtifactFileIdentity(cached, stat)) entry = cached;
      }
      if (entry === undefined) {
        const read = await readArtifactFile(absPath, { maxBytes: limits.fileMaxBytes, preStat: stat, io });
        if (read.kind === "missing" || read.kind === "changed") {
          dirty = true; // vanished or rewritten mid-scan — rescan
          continue;
        }
        if (read.kind !== "ok") {
          return { kind: "failed", failure: read.kind, detail: `unreadable artifact file (${read.kind}): ${JSON.stringify(relPath)}` };
        }
        entry = read.identity;
      }
      // Only fully verified reads are ever cached.
      cache.set(absPath, entry);
      collected.set(relPath, { path: relPath, hash: entry.hash, size: entry.size });
      totalBytes += entry.size;
    }

    // LIFO: the reversed push pops the child directories in ascending order.
    for (let i = childDirs.length - 1; i >= 0; i--) stack.push(childDirs[i]!);
  }

  return { kind: "ok", entries: [...collected.values()], dirty };
}
