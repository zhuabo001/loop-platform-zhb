/**
 * The workdir jail (Phase 2 batch 2, plan §2.2): safe cwd SELECTION for the
 * agent subprocess. This module is NOT a runtime filesystem security
 * boundary — batch 3's OS sandbox is what stops a running process from
 * touching paths outside its roots. The jail only guarantees that the spawn
 * cwd resolves inside the daemon ∩ server root intersection, or inside an
 * isolated per-run scratch directory owned by the daemon.
 */

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

export async function createWorkdirJail(config: {
  allowedRoots: string[];
  scratchParent: string;
}): Promise<WorkdirJail> {
  void config;
  return {
    daemonRoots: [],
    resolve: () => Promise.reject(new JailError("resolve is not implemented yet")),
    release: () => Promise.reject(new JailError("release is not implemented yet")),
  };
}
