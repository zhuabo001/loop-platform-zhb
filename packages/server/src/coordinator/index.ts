/**
 * The RunCoordinator — the package-internal DEEP MODULE that owns every run
 * lifecycle write (plan §1). Adapters (owner/manual trigger, machine poll,
 * machine report — and the Phase 3 scheduler) each call exactly their own
 * method; the module interface is NOT the HTTP permission surface. Nothing
 * bypasses it to orchestrate the store directly.
 *
 * Dependencies are injected as ONE object:
 *  - `db`: a concrete Drizzle handle — open/migrate/close lifecycle belongs to
 *    boot, not here;
 *  - `clock`: the ONLY time source for lifecycle writes (systemClock in prod,
 *    FakeClock in tests);
 *  - `newRunId` / `mintRunCredential`: kept DISTINCT — identity generation vs
 *    capability-secret minting (production: UUIDs, and `rk_` + 16 crypto-random
 *    bytes hex, mirroring the reference mint);
 *  - `hooks`: TEST-ONLY interleaving gates (never set by production boot).
 *    Pglite is single-connection, so the plan's race tests orchestrate real
 *    committed competitor writes at the APP level via these gates; real
 *    multi-connection lock contention stays with Phase 6 (ADR-001's honesty
 *    note).
 *
 * Deterministic derivations (sha256, machineIdFromToken) are plain imports,
 * not injected.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { enqueueExecRunTx, getLoop, type EnqueueExecRunResult, type RunStoreDeps } from "../store/runs.js";

export interface CoordinatorHooks {
  /** Runs after the loop lookup, BEFORE the enqueue write transaction opens —
   *  lets a test commit a competing claim on the (then-idle) single pglite
   *  connection, proving the in-transaction re-check skips/rolls back. */
  beforeEnqueueTx?(loopId: string): void | Promise<void>;
}

export interface RunCoordinatorDependencies extends RunStoreDeps {
  /** Mint a fresh run-lease wire token (`rk_…` in production). The store only
   *  ever persists its sha256 — the plaintext rides the Delivery. */
  mintRunCredential(): string;
  hooks?: CoordinatorHooks;
}

/** Production run-id factory (wired by src/start.ts). */
export function newUuidRunId(): string {
  return randomUUID();
}

/** Production run-credential mint: `rk_` + 16 crypto-random bytes as hex
 *  (mirrors the reference's `registerRunLease` token format). */
export function mintRunCredential(): string {
  return `rk_${randomBytes(16).toString("hex")}`;
}

export function createRunCoordinator(deps: RunCoordinatorDependencies) {
  // Per-loop in-process serialization for trigger writes (plan §1: multi-
  // instance DB contention is Phase 6). Chains never reject into the next
  // caller, and entries self-clean when the queue drains.
  const chains = new Map<string, Promise<unknown>>();
  function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    chains.set(key, next);
    const cleanup = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    // then(onFulfilled, onRejected) — a bare .finally() would float a second
    // rejecting promise (unhandled rejection) whenever `fn` throws.
    void next.then(cleanup, cleanup);
    return next;
  }

  return {
    /** T7: atomically supersede stale pendings and enqueue the loop's next
     *  exec run (zero-write skip while a run is running). */
    enqueueExecRun(loopId: string): Promise<EnqueueExecRunResult> {
      return serialize(`enqueue:${loopId}`, async () => {
        const loop = await getLoop(deps.db, loopId);
        if (!loop) return { enqueued: false as const, reason: "loop_not_found" as const };
        await deps.hooks?.beforeEnqueueTx?.(loopId);
        return enqueueExecRunTx(deps, loop);
      });
    },
  };
}

export type RunCoordinator = ReturnType<typeof createRunCoordinator>;
