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
import { eq } from "drizzle-orm";
import type { RunCoordinator } from "../coordinator/index.js";
import type { Clock } from "../time.js";
import { latestOccurrence } from "../schedule/time-semantics.js";

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

  // Track in-flight callbacks for drain
  const inFlightCallbacks = new Set<Promise<unknown>>();

  // Shutdown flag
  let stopped = false;

  /**
   * Registers or updates a Croner job for the given loop.
   * No-op if the loop's schedule hasn't changed.
   * Removes the job if the loop is no longer active.
   */
  function reconcile(loop: Loop): void {
    if (stopped) return;

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

          // Enqueue with scheduled trigger. The enqueue promise is RETURNED to
          // Croner: the job stays "busy" until the write settles, which is what
          // makes the protect (overrun) handler able to skip a re-entrant tick.
          const promise = coordinator
            .enqueueExecRun(loop.id, {
              kind: "scheduled",
              scheduledFor: scheduledFor.toISOString(),
              scheduleRevision: capturedRevision,
            })
            .then((result) => {
              if (!result.enqueued) {
                log(`scheduler: enqueue_skipped loop=${loop.id} reason=${result.reason}`);
              }
            })
            .catch(() => {
              log(`scheduler: enqueue_failed loop=${loop.id}`);
            });

          // Track in-flight callback
          inFlightCallbacks.add(promise);
          try {
            await promise;
          } finally {
            inFlightCallbacks.delete(promise);
          }
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
     * Starts the scheduler: scans active loops and registers jobs.
     * Scan-level DB errors propagate (startup failure); per-loop
     * registration errors are isolated and logged.
     */
    async start(): Promise<void> {
      if (stopped) throw new Error("Scheduler already stopped");

      // Scan active loops (enabled=true AND cron IS NOT NULL)
      const activeLoops = await db
        .select()
        .from(loops)
        .where(eq(loops.enabled, true));

      // Filter to only those with cron
      const scheduledLoops = activeLoops.filter((loop) => loop.cron !== null);

      console.log(`[scheduler] starting: found ${scheduledLoops.length} active scheduled loops`);

      for (const loop of scheduledLoops) {
        reconcile(loop);
      }

      console.log(`[scheduler] started: ${registry.size} jobs registered`);
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
