/**
 * The RunCoordinator — the package-internal DEEP MODULE that owns every run
 * lifecycle write (plan §1). Its interface is EXACTLY three methods —
 * `enqueueExecRun` / `poll` / `report` (A-02; pinned by a structural test):
 * adapters (owner/manual trigger, machine poll, machine report — and the
 * Phase 3 scheduler) each call exactly their own method, and the module
 * interface is NOT the HTTP permission surface. Owner cancel and sweep
 * reclaim stay STORE-level primitives (`cancelRunTx` / `reclaimStaleRunTx`)
 * consumed directly by their future adapters — they are deliberately NOT on
 * this interface.
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

import { isDeviceTokenShape, type Delivery, type PollRequest, type ReportRequest } from "@loopzhb/protocol";
import { machineIdFromToken, sha256 } from "@loopzhb/protocol/node";

import { buildDelivery } from "../gateway/delivery.js";
import { resolveLiveLease } from "../store/leases.js";
import { applyMachinePollContact, getMachine, registerMachineOnPoll } from "../store/machines.js";
import { executeReportTx, type ReportTxResult } from "../store/report.js";
import {
  claimRunWithLeaseTx,
  enqueueExecRunTx,
  getLoop,
  pendingExecRunsForMachine,
  type EnqueueExecRunResult,
  type RunStoreDeps,
} from "../store/runs.js";
import { InvalidMachineCredentialError, RunCapabilityInvalidError } from "./errors.js";

export interface CoordinatorHooks {
  /** Runs after the loop lookup, BEFORE the enqueue write transaction opens —
   *  lets a test commit a competing claim on the (then-idle) single pglite
   *  connection, proving the in-transaction re-check skips/rolls back. */
  beforeEnqueueTx?(loopId: string): void | Promise<void>;
  /** Runs after the report's read-side lease resolve, BEFORE the write
   *  transaction opens — the report/cancel interleaving gate (lets a test
   *  commit a real cancel in between). */
  afterReportResolve?(tokenHash: string): void | Promise<void>;
  /** Fires INSIDE the report transaction between the run update and the lease
   *  delete — the fault-injection seam proving those two writes are atomic. */
  insideReportTx?(runId: string): void | Promise<void>;
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

    /**
     * The daemon's heartbeat + run claim (plan §2).
     *
     * Order matters: cheap shape filter → derived-id + full-hash verification
     * (self-registering on first contact) → heartbeat/identity write (OUTSIDE
     * any claim transaction — confirmed contact survives a lost claim race) →
     * the per-candidate atomic claims. `progress`/`wait` are parse-only in
     * Phase 1. Throws InvalidMachineCredentialError on any credential
     * failure; the HTTP adapter maps that to the unified 401.
     */
    async poll(deviceToken: string, body: PollRequest): Promise<{ deliveries: Delivery[] }> {
      if (!isDeviceTokenShape(deviceToken)) throw new InvalidMachineCredentialError();
      const machineId = machineIdFromToken(deviceToken);
      const tokenHash = sha256(deviceToken);

      let machine = await getMachine(deps.db, machineId);
      if (machine) {
        // Full-hash verification on top of the derived id — a 64-bit
        // truncation collision must not hand one machine's authority to a
        // different token (reference audit H-01).
        if (machine.tokenHash !== tokenHash) throw new InvalidMachineCredentialError();
        machine = await applyMachinePollContact(deps, machine, body);
      } else {
        machine = await registerMachineOnPoll(deps, { machineId, tokenHash, identity: body });
      }

      const deliveries: Delivery[] = [];
      for (const candidate of await pendingExecRunsForMachine(deps.db, machineId)) {
        const loop = await getLoop(deps.db, candidate.loopId);
        if (!loop) continue; // undeliverable: stays pending, never fails the batch
        const claimed = await claimRunWithLeaseTx(deps, {
          runId: candidate.id,
          loopId: loop.id,
          machineId,
          role: candidate.role,
        });
        if (!claimed) continue; // race loser — another poll owns this run now
        deliveries.push(buildDelivery({ loop, run: claimed.run, roots: machine.roots ?? [], runToken: claimed.runToken }));
      }
      return { deliveries };
    },

    /**
     * The daemon's run finalize (plan §3). The credential is OPAQUE — hashed
     * and resolved, never shape-filtered on the read side. Two-phase resolve:
     * a cheap read-side check (unknown/expired → 401, expired terminal-grace
     * lazily dropped), then the write transaction re-resolves and re-checks
     * phase, catching any cancel that committed in between. `body.runId` is
     * an echo only — the lease's run is authoritative.
     */
    async report(runCredential: string, body: ReportRequest): Promise<ReportTxResult> {
      const tokenHash = sha256(runCredential);
      const lease = await resolveLiveLease(deps, tokenHash);
      if (!lease) throw new RunCapabilityInvalidError("unknown_or_expired");
      await deps.hooks?.afterReportResolve?.(tokenHash);
      return executeReportTx(deps, { tokenHash, body, insideTxHook: deps.hooks?.insideReportTx });
    },
  };
}

export type RunCoordinator = ReturnType<typeof createRunCoordinator>;
