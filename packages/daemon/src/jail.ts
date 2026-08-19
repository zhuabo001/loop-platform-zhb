/**
 * The workdir jail (Phase 2 batch 2, plan §2.2): safe cwd SELECTION for the
 * agent subprocess. This module is NOT a runtime filesystem security
 * boundary — batch 3's OS sandbox is what stops a running process from
 * touching paths outside its roots. The jail only guarantees that the spawn
 * cwd resolves inside the daemon ∩ server root intersection, or inside an
 * isolated per-run scratch directory owned by the daemon.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export class JailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JailError";
  }
}

export interface ResolveWorkdirInput {
  /** `loop.workdir` from the Delivery; null ⇒ a per-run scratch dir is minted. */
  workdir: string | null;
  /** Delivery.roots: [] ⇒ no extra narrowing; otherwise the intersection input. */
  serverRoots: string[];
  loopId: string;
  runId: string;
}

export interface ResolvedWorkdir {
  /** Canonical absolute cwd for the subprocess. */
  cwd: string;
  /** Canonical daemon ∩ server intersection that cwd was validated against. */
  effectiveRoots: string[];
  /** Non-null only when this resolve() minted a per-run scratch directory. */
  scratchDir: string | null;
}

export interface WorkdirJail {
  /** Canonicalized (realpath'd, deduped) daemon roots — the intersection input. */
  readonly daemonRoots: readonly string[];
  resolve(input: ResolveWorkdirInput): Promise<ResolvedWorkdir>;
  release(resolved: ResolvedWorkdir): Promise<void>;
}

/** Canonicalize a root set: every root must be an absolute, `..`-free path to
 *  an existing directory; realpath collapses symlink aliases, exact
 *  duplicates drop out (first-seen order). Used for the daemon roots ONCE at
 *  construction (fail-fast startup) AND for server roots on EVERY resolve —
 *  the server is never trusted to have normalized. Any rejection is a
 *  JailError (fail-closed). */
async function canonicalizeRoots(roots: string[], label: string): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root) || root.split(path.sep).includes("..")) {
      throw new JailError(`${label} must be an absolute path without .. segments: ${JSON.stringify(root)}`);
    }
    let real: string;
    try {
      real = await fs.realpath(root);
    } catch {
      throw new JailError(`${label} does not exist: ${JSON.stringify(root)}`);
    }
    if (!(await fs.stat(real)).isDirectory()) {
      throw new JailError(`${label} is not a directory: ${JSON.stringify(root)}`);
    }
    if (!canonical.includes(real)) canonical.push(real);
  }
  if (canonical.length === 0) throw new JailError(`${label} set must contain at least one root`);
  return canonical;
}

/** path.relative() boundary test — NEVER a string-prefix check, which would
 *  confuse "/foo" with "/foobar". Equal counts as within. */
function isWithinOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Pairwise directory-tree intersection: when one root contains the other,
 *  the NARROWER one survives. Exact duplicates and children already covered
 *  by a parent in the result set are dropped. Empty ⇒ the caller rejects —
 *  the server may only ever NARROW the daemon's roots, and a disjoint
 *  delivery gets no workdir at all. */
function intersectRoots(daemonRoots: readonly string[], serverRoots: string[]): string[] {
  const pairs: string[] = [];
  for (const d of daemonRoots) {
    for (const s of serverRoots) {
      if (isWithinOrEqual(d, s)) pairs.push(s);
      else if (isWithinOrEqual(s, d)) pairs.push(d);
    }
  }
  const deduped = [...new Set(pairs)];
  return deduped.filter((r) => !deduped.some((other) => other !== r && isWithinOrEqual(other, r)));
}

export async function createWorkdirJail(config: {
  allowedRoots: string[];
  scratchParent: string;
}): Promise<WorkdirJail> {
  const daemonRoots = await canonicalizeRoots(config.allowedRoots, "allowed root");
  const scratchParent = config.scratchParent;
  return {
    daemonRoots,
    async resolve(input: ResolveWorkdirInput): Promise<ResolvedWorkdir> {
      const narrowed = input.serverRoots.length > 0;
      const serverRoots = narrowed ? await canonicalizeRoots(input.serverRoots, "server root") : [];
      const effectiveRoots = narrowed ? intersectRoots(daemonRoots, serverRoots) : [...daemonRoots];
      if (effectiveRoots.length === 0) {
        throw new JailError("server roots are disjoint from every daemon root — no permitted workdir");
      }
      void scratchParent;
      if (input.workdir === null) {
        throw new JailError("per-run scratch workdir is not implemented yet");
      }
      // Boundary discipline (J6–J13): realpath FIRST (collapses `..` and
      // symlinks), then containment against the canonical effectiveRoots via
      // path.relative() — never a string-prefix check. A symlink pointing
      // inside resolves inside and passes; one pointing outside resolves
      // outside and is rejected. Every failure is a JailError (fail-closed).
      const workdir = input.workdir;
      if (!path.isAbsolute(workdir)) {
        throw new JailError(`workdir must be an absolute path: ${JSON.stringify(workdir)}`);
      }
      let cwd: string;
      try {
        cwd = await fs.realpath(workdir);
      } catch {
        throw new JailError(`workdir does not exist: ${JSON.stringify(workdir)}`);
      }
      if (!(await fs.stat(cwd)).isDirectory()) {
        throw new JailError(`workdir is not a directory: ${JSON.stringify(workdir)}`);
      }
      if (!effectiveRoots.some((root) => isWithinOrEqual(root, cwd))) {
        throw new JailError(`workdir escapes every effective root: ${JSON.stringify(workdir)}`);
      }
      return { cwd, effectiveRoots, scratchDir: null };
    },
    release: () => Promise.resolve(),
  };
}
