/**
 * Scheduler — the deep module that owns automatic cron-based loop execution.
 *
 * Phase 3 Batch 2: Manages in-memory Croner jobs for active scheduled loops.
 * Each job is identified by `loopId + scheduleRevision`. Configuration changes
 * trigger immediate job replacement via reconcile().
 *
 * Responsibilities:
 *  - Register/unregister Croner jobs for active loops
 *  - Invoke RunCoordinator on each occurrence
 *  - Isolate per-loop errors (one bad config doesn't block others)
 *  - Graceful shutdown with drain (wait for in-flight callbacks)
 *
 * Dependencies:
 *  - db: for scanning active loops on start
 *  - coordinator: the ONLY write entry point (enqueueExecRun)
 *  - clock: for occurrence calculation
 *  - cronFactory: injectable Croner factory (real in prod, fake in tests)
 *  - log: error classification (no user data)
 *
 * Log discipline (Batch 2 plan §2): every line is a FIXED classification plus
 * the loop id — never an exception message, cron pattern or timezone (those
 * can carry user input and newline injection).
 *
 * See ADR-008 for the complete scheduler contract.
 */

import type { Db } from "../db/index.js";
import { loops, type Loop } from "../db/schema.js";
import { and, eq, isNotNull } from "drizzle-orm";
import type { RunCoordinator } from "../coordinator/index.js";
import type { EnqueueExecRunResult } from "../store/runs.js";
import type { Clock } from "../time.js";
import { isValidPersistedScheduleState, latestOccurrence } from "../schedule/time-semantics.js";

/**
 * Croner job interface — abstracts the real Croner for testing.
 */
export interface CronJob {
  stop(): void;
}

/**
 * Croner factory — production uses real Croner, tests inject FakeCronFactory.
 */
export interface CronFactory {
  create(
    pattern: string,
    options: {
      timezone: string;
      protect?: (job: unknown) => void;
      catch?: (err: unknown) => void;
    },
    callback: () => void | Promise<void>,
  ): CronJob;
}

/**
 * Scheduler dependencies.
 */
export interface SchedulerDeps {
  db: Db;
  coordinator: RunCoordinator;
  clock: Clock;
  cronFactory: CronFactory;
  log?: (line: string) => void;
}

/**
 * Job registry entry — tracks one loop's active Croner job.
 */
interface JobEntry {
  revision: number;
  cron: string;
  timezone: string;
  job: CronJob;
}

/**
 * Creates a Scheduler instance.
 */
export function createScheduler(deps: SchedulerDeps) {
  const { db, coordinator, clock, cronFactory, log = console.warn } = deps;

  // Registry: loopId → JobEntry
  const registry = new Map<string, JobEntry>();

  // Highest authoritative revision observed for each loop. This survives job
  // removal so a delayed pre-pause object cannot resurrect an obsolete job.
  const highestRevisions = new Map<string, number>();

  // Track in-flight callbacks for drain
  const inFlightCallbacks = new Set<Promise<unknown>>();

  // Shutdown flag
  let stopped = false;

  /**
   * Shared in-flight enqueue lifecycle — the ONE shape used by both the
   * online callback and the restart catch-up (review P3: the two paths used
   * to duplicate it). The promise is added to the SHARED drain set
   * SYNCHRONOUSLY, before any await, so stopAndDrain() covers both paths
   * alike; a thrown enqueue always earns the fixed `enqueue_failed`
   * classification. A resolved non-enqueue is a benign race outcome: only the
   * online callback observes it (`enqueue_skipped` with the reason); the
   * catch-up passes no observer and stays silent (§2.3).
   */
  async function drainTrackedEnqueue(
    loopId: string,
    result: Promise<EnqueueExecRunResult>,
    onSkip?: (reason: Extract<EnqueueExecRunResult, { enqueued: false }>["reason"]) => void,
  ): Promise<void> {
    const promise = result
      .then((r) => {
        if (!r.enqueued) onSkip?.(r.reason);
      })
      .catch(() => {
        log(`scheduler: enqueue_failed loop=${loopId}`);
      });
    inFlightCallbacks.add(promise);
    try {
      await promise;
    } finally {
      inFlightCallbacks.delete(promise);
    }
  }

  /**
   * Registers or updates a Croner job for the given loop.
   * No-op if the loop's schedule hasn't changed.
   * Removes the job if the loop is no longer active.
   */
  function reconcile(loop: Loop): void {
    if (stopped) return;

    const highestRevision = highestRevisions.get(loop.id);
    if (highestRevision !== undefined && loop.scheduleRevision < highestRevision) return;
    highestRevisions.set(loop.id, loop.scheduleRevision);

    const existing = registry.get(loop.id);

    // Determine if loop is active (enabled && cron != null)
    const isActive = loop.enabled && loop.cron !== null;

    if (!isActive) {
      // Remove job if it exists
      if (existing) {
        try {
          existing.job.stop();
        } catch {
          log(`scheduler: job_stop_failed loop=${loop.id}`);
        }
        registry.delete(loop.id);
      }
      return;
    }

    // Check if config changed
    const configChanged =
      !existing ||
      existing.revision !== loop.scheduleRevision ||
      existing.cron !== loop.cron ||
      existing.timezone !== loop.timezone;

    if (!configChanged) {
      return; // No-op
    }

    // Stop old job if exists
    if (existing) {
      try {
        existing.job.stop();
      } catch {
        log(`scheduler: job_stop_failed loop=${loop.id}`);
      }
    }

    // Create new job
    try {
      const job = cronFactory.create(
        loop.cron!,
        {
          timezone: loop.timezone,
          protect: () => {
            log(`scheduler: overrun loop=${loop.id}`);
          },
          catch: () => {
            log(`scheduler: croner_error loop=${loop.id}`);
          },
        },
        async () => {
          // A stopped scheduler must never touch the (possibly already closed)
          // database — a timer that outlived stop() fires into this guard.
          if (stopped) return;

          // Callback captures loop state at registration time
          const capturedRevision = loop.scheduleRevision;
          const capturedCron = loop.cron!;
          const capturedTimezone = loop.timezone;

          // Calculate canonical occurrence using latestOccurrence
          let scheduledFor: Date | null = null;
          try {
            const now = clock.now();
            scheduledFor = latestOccurrence(
              { cron: capturedCron, timezone: capturedTimezone },
              now,
            );
          } catch {
            log(`scheduler: occurrence_rebuild_failed loop=${loop.id}`);
            return;
          }

          if (scheduledFor === null) {
            log(`scheduler: occurrence_rebuild_failed loop=${loop.id}`);
            return;
          }

          // The enqueue is awaited INSIDE the callback so the promise Croner
          // sees stays pending until the write settles — that is what makes
          // the protect (overrun) handler able to skip a re-entrant tick.
          await drainTrackedEnqueue(
            loop.id,
            coordinator.enqueueExecRun(loop.id, {
              kind: "scheduled",
              scheduledFor: scheduledFor.toISOString(),
              scheduleRevision: capturedRevision,
            }),
            (reason) => log(`scheduler: enqueue_skipped loop=${loop.id} reason=${reason}`),
          );
        },
      );

      registry.set(loop.id, {
        revision: loop.scheduleRevision,
        cron: loop.cron!,
        timezone: loop.timezone,
        job,
      });
    } catch {
      log(`scheduler: job_register_failed loop=${loop.id}`);
    }
  }

  return {
    /**
     * Starts the scheduler: scans active loops, registers jobs, then runs the
     * Batch 3 restart catch-up.
     *
     * Scan-level DB errors propagate (startup failure); per-loop errors are
     * isolated and logged with fixed classifications.
     *
     * Catch-up contract (Batch 3 plan §2.1):
     *  1. Scan-level DB errors fail the boot (propagate).
     *  2. Persisted schedule state is validated per loop (shared fail-closed
     *     rule) — a corrupt row is logged + skipped: NO job, NO catch-up.
     *  3. Jobs are ALL registered first; a loop joins the recovery set only
     *     when the registry (same lexical scope) holds its CURRENT revision —
     *     a failed registration (`job_register_failed`) never catches up.
     *     Timers therefore already cover occurrences past the cutoff while a
     *     slow recovery is still running.
     *  4. ONE recovery cutoff is snapshot after registration.
     *  5. Only a latest occurrence STRICTLY after both the scan row's
     *     activation and watermark reaches the single write entry point; the
     *     transaction re-decides from the latest row (the snapshot is an
     *     eligibility hint only).
     *  6. Every catch-up enqueue is awaited serially, shares the in-flight
     *     set with online callbacks (registered SYNCHRONOUSLY before any
     *     await), and re-checks `stopped` before each loop — a mid-recovery
     *     stopAndDrain() never writes into a closing DB (E10).
     */
    async start(): Promise<void> {
      if (stopped) throw new Error("Scheduler already stopped");

      // Scan active loops (enabled=true AND cron IS NOT NULL) — the SQL
      // predicate matches the loops_active_schedule_idx partial index.
      const scheduledLoops = await db
        .select()
        .from(loops)
        .where(and(eq(loops.enabled, true), isNotNull(loops.cron)));

      console.log(`[scheduler] starting: found ${scheduledLoops.length} active scheduled loops`);

      // Step 2: fail-closed persisted-state validation. Corrupt rows are
      // skipped entirely — the classification never carries the cron,
      // timezone or any other untrusted value (X1/X3).
      const validLoops: Loop[] = [];
      for (const loop of scheduledLoops) {
        if (!isValidPersistedScheduleState({ ...loop, cron: loop.cron! })) {
          log(`scheduler: invalid_schedule_state loop=${loop.id}`);
          continue;
        }
        validLoops.push(loop);
      }

      // Step 3: register every job BEFORE any catch-up work.
      for (const loop of validLoops) {
        reconcile(loop);
      }

      console.log(`[scheduler] started: ${registry.size} jobs registered`);

      // Step 4: one cutoff for the whole recovery pass.
      const recoveryCutoff = clock.now();

      for (const loop of validLoops) {
        // A stop mid-recovery abandons the remaining loops (they recover on
        // the next restart or the next normal tick) — and must never touch a
        // closing database.
        if (stopped) return;

        // Registry read-back: only a loop whose CURRENT revision has a live
        // job may catch up. reconcile() swallows registration failures into
        // `job_register_failed`, so this read is the success signal.
        const entry = registry.get(loop.id);
        if (entry === undefined || entry.revision !== loop.scheduleRevision) continue;

        let occurrence: Date | null = null;
        try {
          occurrence = latestOccurrence({ cron: loop.cron!, timezone: loop.timezone }, recoveryCutoff);
        } catch {
          log(`scheduler: occurrence_rebuild_failed loop=${loop.id}`);
          continue;
        }
        // No occurrence yet — the normal case, deliberately NOT logged.
        if (occurrence === null) continue;

        // Snapshot eligibility: strictly after BOTH activation and watermark.
        // The enqueue transaction re-validates against the latest row, so a
        // stale snapshot can only cause a benign controlled skip, never a
        // double run.
        const occIso = occurrence.toISOString();
        if (loop.scheduleActivatedAt !== null && occIso <= loop.scheduleActivatedAt) continue;
        if (loop.lastScheduledAt !== null && occIso <= loop.lastScheduledAt) continue;

        // Benign skips (already_scheduled, running_exists, stale_revision, …)
        // are normal race outcomes and stay silent (§2.3); only a thrown
        // enqueue is an error worth a line.
        await drainTrackedEnqueue(
          loop.id,
          coordinator.enqueueExecRun(loop.id, {
            kind: "scheduled",
            scheduledFor: occIso,
            scheduleRevision: loop.scheduleRevision,
          }),
        );
      }
    },

    /**
     * Reconciles a single loop's schedule.
     * Called by management API after config commits.
     */
    reconcile,

    /**
     * Stops all jobs and drains in-flight callbacks.
     * After stop, no new jobs can be registered or callbacks fired.
     */
    async stopAndDrain(): Promise<void> {
      stopped = true;

      // Stop all jobs
      for (const [loopId, entry] of registry.entries()) {
        try {
          entry.job.stop();
        } catch {
          log(`scheduler: job_stop_failed loop=${loopId}`);
        }
      }
      registry.clear();

      // Wait for in-flight callbacks
      if (inFlightCallbacks.size > 0) {
        await Promise.allSettled(Array.from(inFlightCallbacks));
      }
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
