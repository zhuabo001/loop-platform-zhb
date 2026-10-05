/**
 * Artifact root resolution (Phase 5 Batch 2 slice 3, ADR-010 决策 23): turn
 * `{artifactDir, workdir, serverRoots}` into the ONE real path a scan may
 * walk, or a closed failure class.
 *
 * The jail discipline is the workdir jail's (jail.ts), NOT the task file's:
 *
 *  - the permitted set is the daemon ∩ server roots intersection, recomputed
 *    on every call — the server is never trusted to have normalized, and a
 *    disjoint delivery gets no artifact tree at all;
 *  - a RELATIVE artifactDir resolves against the explicit `workdir` only;
 *    with no workdir it is refused rather than silently resolving against
 *    the daemon's process cwd;
 *  - realpath runs BEFORE the containment check, so a root that is itself a
 *    symlink is followed and judged by where it LANDS (inside ⇒ ok, outside
 *    ⇒ outside_jail). This deliberately does NOT copy the task file's
 *    symlink-alias following for entries INSIDE the tree: there, any symlink
 *    fails the whole scan (artifact-scan.ts).
 *
 * Zero scratch: this module never mints a directory (no mkdtemp, no
 * createWorkdirJail) — an artifact tree is read-only from the daemon's side.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ArtifactSyncFailure } from "@loopzhb/protocol";

import { JailError, canonicalizeRoots, intersectRoots, isWithinOrEqual } from "./jail.js";

/** The failure classes a LOCAL scan can produce: the shared nine-value client
 *  taxonomy minus the two the scanner must never invent — `watcher_error` is
 *  the slice-5 watcher's and `timeout` the caller's (slice 4/6). Pinned at the
 *  type level so no scan code path can return them. */
export type ArtifactScanFailure = Exclude<ArtifactSyncFailure, "watcher_error" | "timeout">;

export interface ResolveArtifactRootInput {
  /** `loop.artifactDir` from the Delivery — relative resolves against `workdir`. */
  artifactDir: string;
  /** `loop.workdir` from the Delivery; null ⇒ an absolute artifactDir is required. */
  workdir: string | null;
  /** Delivery.roots; [] ⇒ no narrowing. Re-canonicalized on every call. */
  serverRoots: readonly string[];
  /** Canonical (realpath'd, deduped) daemon roots — `WorkdirJail.daemonRoots`.
   *  PRECONDITION: already canonical; a raw config value may fail containment
   *  closed rather than resolving the tree the operator meant. */
  daemonRoots: readonly string[];
}

export interface ResolvedArtifactRoot {
  /** Canonical absolute tree root the scan may walk. */
  root: string;
  /** The daemon ∩ server intersection the root was validated against. */
  effectiveRoots: readonly string[];
}

export type ArtifactRootResolution =
  | { kind: "ok"; resolved: ResolvedArtifactRoot }
  | { kind: "failed"; failure: ArtifactScanFailure; detail: string };

function failed(failure: ArtifactScanFailure, detail: string): ArtifactRootResolution {
  return { kind: "failed", failure, detail };
}

export async function resolveArtifactRoot(input: ResolveArtifactRootInput): Promise<ArtifactRootResolution> {
  // Fixed evaluation order (ADR-010 决策 23): empty root set → empty/NUL dir
  // → server-root canonicalization → intersection → relative resolution →
  // realpath → directory check → containment.
  if (input.daemonRoots.length === 0) {
    return failed("outside_jail", "no daemon root is configured");
  }
  if (input.artifactDir === "") {
    return failed("directory_missing", "artifactDir is empty");
  }
  if (input.artifactDir.includes("\0")) {
    return failed("unreadable", "artifactDir contains a NUL byte");
  }
  const narrowed = input.serverRoots.length > 0;
  let effectiveRoots: string[];
  if (narrowed) {
    let serverRoots: string[];
    try {
      serverRoots = await canonicalizeRoots([...input.serverRoots], "server root");
    } catch (error) {
      if (!(error instanceof JailError)) throw error;
      return failed("outside_jail", error.message);
    }
    effectiveRoots = intersectRoots(input.daemonRoots, serverRoots);
    if (effectiveRoots.length === 0) {
      return failed("outside_jail", "server roots are disjoint from every daemon root");
    }
  } else {
    effectiveRoots = [...input.daemonRoots];
  }
  let target: string;
  if (path.isAbsolute(input.artifactDir)) {
    target = input.artifactDir;
  } else {
    if (input.workdir === null) {
      return failed("outside_jail", `a relative artifactDir needs an explicit workdir: ${JSON.stringify(input.artifactDir)}`);
    }
    if (!path.isAbsolute(input.workdir)) {
      // Never resolve against the daemon's process cwd.
      return failed("outside_jail", `workdir must be an absolute path: ${JSON.stringify(input.workdir)}`);
    }
    target = path.resolve(input.workdir, input.artifactDir);
  }
  // realpath FIRST (collapses `..` and symlink aliases), then a lexical
  // containment test against the canonical roots — never a string prefix.
  let root: string;
  try {
    root = await fs.realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failed("directory_missing", `artifactDir does not exist: ${JSON.stringify(input.artifactDir)}`);
    }
    if (code === "ELOOP") return failed("symlink", `artifactDir resolves through a symlink loop: ${JSON.stringify(input.artifactDir)}`);
    if (code === "EACCES" || code === "EPERM") {
      return failed("unreadable", `artifactDir is not readable: ${JSON.stringify(input.artifactDir)}`);
    }
    return failed("unreadable", `artifactDir could not be resolved: ${JSON.stringify(input.artifactDir)}`);
  }
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failed("directory_missing", `artifactDir vanished while resolving: ${JSON.stringify(input.artifactDir)}`);
    }
    return failed("unreadable", `artifactDir could not be inspected: ${JSON.stringify(input.artifactDir)}`);
  }
  if (!stat.isDirectory()) {
    return failed("directory_missing", `artifactDir is not a directory: ${JSON.stringify(input.artifactDir)}`);
  }
  if (!effectiveRoots.some((effective) => isWithinOrEqual(effective, root))) {
    return failed("outside_jail", `artifactDir escapes every effective root: ${JSON.stringify(input.artifactDir)}`);
  }
  return { kind: "ok", resolved: { root, effectiveRoots } };
}
