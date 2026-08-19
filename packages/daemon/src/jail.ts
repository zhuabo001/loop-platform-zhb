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

/** Canonicalize the daemon roots ONCE at construction: every root must be an
 *  absolute, `..`-free path to an existing directory; realpath collapses
 *  symlink aliases, exact duplicates drop out (first-seen order). Any
 *  rejection is a JailError — the daemon fails fast at startup (fail-closed). */
async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root) || root.split(path.sep).includes("..")) {
      throw new JailError(`allowed root must be an absolute path without .. segments: ${JSON.stringify(root)}`);
    }
    let real: string;
    try {
      real = await fs.realpath(root);
    } catch {
      throw new JailError(`allowed root does not exist: ${JSON.stringify(root)}`);
    }
    if (!(await fs.stat(real)).isDirectory()) {
      throw new JailError(`allowed root is not a directory: ${JSON.stringify(root)}`);
    }
    if (!canonical.includes(real)) canonical.push(real);
  }
  if (canonical.length === 0) throw new JailError("allowedRoots must contain at least one root");
  return canonical;
}

export async function createWorkdirJail(config: {
  allowedRoots: string[];
  scratchParent: string;
}): Promise<WorkdirJail> {
  const daemonRoots = await canonicalizeRoots(config.allowedRoots);
  void config.scratchParent;
  return {
    daemonRoots,
    resolve: () => Promise.resolve({ cwd: "/", effectiveRoots: [], scratchDir: null }),
    release: () => Promise.reject(new JailError("release is not implemented yet")),
  };
}
