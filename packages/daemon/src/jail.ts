/**
 * The workdir jail (Phase 2 batch 2, plan §2.2): safe cwd SELECTION for the
 * agent subprocess. This module is NOT a runtime filesystem security
 * boundary — batch 3's OS sandbox is what stops a running process from
 * touching paths outside its roots. The jail only guarantees that the spawn
 * cwd resolves inside the daemon ∩ server root intersection, or inside an
 * isolated per-run scratch directory owned by the daemon.
 *
 * POINT-IN-TIME semantics (round-1 P1, contract downgrade accepted by
 * review): resolve() validates the canonical path AT RESOLVE TIME. Between
 * resolve() and spawn() a hostile rename/symlink swap can redirect the cwd
 * outside the roots (TOCTOU) — Node's spawn cwd is a path string, so no
 * handle-based atomicity is available at this layer. Batch 3 closes the
 * window with `revalidate()`: the adapter MUST revalidate the resolution
 * immediately before spawning (and does — plan §2.2), and the fail-closed OS
 * sandbox — not this module — remains the real runtime boundary.
 */
import { createHash } from "node:crypto";
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
  /** The owned, unpredictable per-start scratch root. Exposed for lifecycle
   * observability only; callers must release it through dispose(). */
  readonly scratchRoot: string;
  resolve(input: ResolveWorkdirInput): Promise<ResolvedWorkdir>;
  /** Pre-spawn re-validation (batch 3, plan §2.2): re-realpath/lstat the cwd
   *  and every effective root and confirm nothing was renamed, deleted or
   *  symlink-swapped since resolve(). Fail-closed: ANY drift throws a
   *  JailError and the caller MUST NOT spawn. This narrows the resolve→spawn
   *  TOCTOU window; the OS sandbox remains the runtime boundary. */
  revalidate(resolved: ResolvedWorkdir): Promise<void>;
  release(resolved: ResolvedWorkdir): Promise<void>;
  /** Owner-level shutdown cleanup. Idempotent for an already-disposed root,
   * but fail-closed if the path was replaced. */
  dispose(): Promise<void>;
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
 *  confuse "/foo" with "/foobar". Equal counts as within. Exported for the
 *  Phase 4 task-file resolver, which applies the same canonical-containment
 *  discipline to the task file target. */
export function isWithinOrEqual(parent: string, child: string): boolean {
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
  /** Base directory the scratch ROOT is minted INSIDE. Never used directly
   *  as the scratch parent: a predictable pre-existing path could be
   *  pre-occupied or symlink-swapped by another local user (round-1 P1). */
  scratchBase: string;
}): Promise<WorkdirJail> {
  const daemonRoots = await canonicalizeRoots(config.allowedRoots, "allowed root");
  if (!path.isAbsolute(config.scratchBase)) {
    throw new JailError(`scratchBase must be an absolute path: ${JSON.stringify(config.scratchBase)}`);
  }
  await fs.mkdir(config.scratchBase, { recursive: true });
  const scratchBase = await fs.realpath(config.scratchBase);
  // The scratch ROOT is minted per jail (≈ per daemon start): unpredictable
  // mkdtemp name, 0700 — it cannot collide, be pre-occupied, or be swapped
  // ahead of time. Owner shutdown disposes this root; only an uncatchable
  // process/host crash can leave tmp residue for the OS janitor. Runs never
  // write into a previous start's root.
  const scratchRoot = await fs.mkdtemp(path.join(scratchBase, "loopzhb-runs-"));
  try {
    await fs.chmod(scratchRoot, 0o700);
  } catch (err) {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  /** Every scratch dir THIS jail minted — release() deletes nothing else. */
  const mintedScratch = new Set<string>();
  let disposed = false;
  return {
    daemonRoots,
    scratchRoot,
    async resolve(input: ResolveWorkdirInput): Promise<ResolvedWorkdir> {
      const narrowed = input.serverRoots.length > 0;
      const serverRoots = narrowed ? await canonicalizeRoots(input.serverRoots, "server root") : [];
      const effectiveRoots = narrowed ? intersectRoots(daemonRoots, serverRoots) : [...daemonRoots];
      if (effectiveRoots.length === 0) {
        throw new JailError("server roots are disjoint from every daemon root — no permitted workdir");
      }
      if (input.workdir === null) {
        // Per-RUN scratch (J20–J22): hash(loopId+runId) is only the prefix —
        // mkdtemp's random suffix means even a repeated runId gets a fresh,
        // never-reused directory. chmod defends the 0700 contract beyond
        // POSIX mkdtemp's own guarantee.
        const prefix = createHash("sha256").update(`${input.loopId} ${input.runId}`).digest("hex").slice(0, 16);
        const scratchDir = await fs.mkdtemp(path.join(scratchRoot, `${prefix}-`));
        await fs.chmod(scratchDir, 0o700);
        mintedScratch.add(scratchDir);
        return { cwd: scratchDir, effectiveRoots, scratchDir };
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
    async revalidate(resolved: ResolvedWorkdir): Promise<void> {
      // Every effective root must still realpath to EXACTLY the canonical
      // value recorded at resolve time and still be a directory — a root
      // swapped for a symlink or renamed away would make the sandbox profile
      // (derived from these paths) alias the wrong tree.
      for (const root of resolved.effectiveRoots) {
        let real: string;
        try {
          real = await fs.realpath(root);
        } catch {
          throw new JailError(`effective root vanished before spawn: ${JSON.stringify(root)}`);
        }
        if (real !== root) {
          throw new JailError(`effective root moved before spawn: ${JSON.stringify(root)} → ${JSON.stringify(real)}`);
        }
        if (!(await fs.stat(real)).isDirectory()) {
          throw new JailError(`effective root is no longer a directory: ${JSON.stringify(root)}`);
        }
      }
      // The cwd must still resolve to itself and still be a directory.
      let cwd: string;
      try {
        cwd = await fs.realpath(resolved.cwd);
      } catch {
        throw new JailError(`workdir vanished before spawn: ${JSON.stringify(resolved.cwd)}`);
      }
      if (cwd !== resolved.cwd) {
        throw new JailError(`workdir moved before spawn: ${JSON.stringify(resolved.cwd)} → ${JSON.stringify(cwd)}`);
      }
      if (!(await fs.stat(cwd)).isDirectory()) {
        throw new JailError(`workdir is no longer a directory: ${JSON.stringify(resolved.cwd)}`);
      }
      if (resolved.scratchDir !== null) {
        // A scratch resolution's cwd IS the scratch dir — re-check the same
        // fail-closed identity release() uses (minted here, direct child of
        // this jail's scratch root, lstat not a symlink).
        if (resolved.cwd !== resolved.scratchDir) {
          throw new JailError("scratch resolution drifted: cwd is no longer the minted scratch dir");
        }
        await assertScratchIdentity(resolved.scratchDir, "before spawn");
      } else if (!resolved.effectiveRoots.some((root) => isWithinOrEqual(root, cwd))) {
        // A workdir resolution must still sit inside the just-re-verified
        // effective roots.
        throw new JailError(`workdir escaped the effective roots before spawn: ${JSON.stringify(resolved.cwd)}`);
      }
    },
    async release(resolved: ResolvedWorkdir): Promise<void> {
      const dir = resolved.scratchDir;
      if (dir === null) return; // a non-scratch resolution owns nothing
      // Fail-closed (J23–J25): only delete a directory THIS jail minted, that
      // is STILL a direct child of this jail's scratch root, and that has
      // not been swapped for a symlink. lstat (not stat) sees the swap.
      await assertScratchIdentity(dir, "before release");
      await fs.rm(dir, { recursive: true });
      mintedScratch.delete(dir);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      if (path.dirname(scratchRoot) !== scratchBase || !path.basename(scratchRoot).startsWith("loopzhb-runs-")) {
        throw new JailError(`scratch root identity mismatch: ${JSON.stringify(scratchRoot)}`);
      }
      let stat;
      try {
        stat = await fs.lstat(scratchRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          mintedScratch.clear();
          disposed = true;
          return;
        }
        throw err;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new JailError(`scratch root was replaced before dispose: ${JSON.stringify(scratchRoot)}`);
      }
      await fs.rm(scratchRoot, { recursive: true });
      mintedScratch.clear();
      disposed = true;
    },
  };

  /** The shared scratch identity check: minted by THIS jail, still a direct
   *  child of THIS jail's scratch root, and still a real directory (a symlink
   *  or non-directory swap fails). Used by both revalidate() and release(). */
  async function assertScratchIdentity(dir: string, when: string): Promise<void> {
    if (!mintedScratch.has(dir) || path.dirname(dir) !== scratchRoot) {
      throw new JailError(`refusing a scratch path this jail did not mint here: ${JSON.stringify(dir)}`);
    }
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch {
      throw new JailError(`scratch dir vanished ${when}: ${JSON.stringify(dir)}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new JailError(`scratch dir was replaced (symlink or non-directory) ${when}: ${JSON.stringify(dir)}`);
    }
  }
}
