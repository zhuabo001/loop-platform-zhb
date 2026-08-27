# ADR-008: Online Scheduler Architecture

**Status**: Accepted
**Date**: 2026-08-27
**Context**: Phase 3 Batch 2 - Scheduled Loop Execution

## Context and Problem Statement

Phase 3 Batch 2 introduces automatic cron-based loop execution. The system needs to:
- Schedule recurring loop executions based on cron expressions
- Support dynamic schedule updates without restart
- Isolate per-loop failures (one bad config doesn't block others)
- Gracefully shutdown with in-flight callback drain
- Integrate with existing RunCoordinator and lifecycle

**Key Constraints**:
- Single-process, file-backed SQLite (no distributed scheduling needed)
- Phase 1-2 manual-trigger semantics remain unchanged
- Scan-level scheduler startup failure is a BOOT failure (cleanup + non-zero exit); per-loop registration/callback failures are isolated and non-fatal
- Zero-downtime reconcile on schedule updates

## Decision

We implement an **online Scheduler deep module** with the following architecture:

### 1. Scheduler Module (`src/scheduler/`)

**Responsibilities**:
- Scan active loops (enabled=true AND cron IS NOT NULL) on startup
- Register Croner jobs for each active scheduled loop
- Invoke RunCoordinator on each occurrence
- Dynamically reconcile jobs on schedule changes
- Graceful shutdown with callback drain

**Interface**:
```typescript
interface Scheduler {
  start(): Promise<void>;           // Scan DB and register jobs
  reconcile(loop: Loop): void;      // Update/remove job for one loop
  stopAndDrain(): Promise<void>;    // Stop all jobs, wait for callbacks
}
```

**Job Registry**:
- In-memory Map<loopId, JobEntry>
- JobEntry = { revision, cron, timezone, job: CronJob }
- Jobs identified by `loopId + scheduleRevision`
- Configuration changes trigger immediate job replacement

### 2. Occurrence Reconstruction (`latestOccurrence`)

Croner callbacks fire at approximately the scheduled minute, but may be delayed by system load, event-loop stalls, or process suspension. The Scheduler uses `latestOccurrence()` to reconstruct the canonical UTC timestamp:

```typescript
function latestOccurrence(schedule: NormalizedSchedule, atInclusive: Date): Date | null
```

**Algorithm (adaptive lookback — no arbitrary fixed drop window)**:
1. Start with a 2-minute lookback window (the common case)
2. Find the first occurrence after (firing time - window), then walk forward occurrence-by-occurrence, keeping the last one ≤ firing time (dense schedules have several occurrences inside the window; the first is NOT the latest)
3. If the window holds no occurrence ≤ firing time, double the window and retry, up to a 5-year cap (covers Feb-29-only crons)

A fired callback is a live occurrence: it must NEVER be silently dropped because of its delay (Round 2 review). Cost stays bounded — dense crons succeed on the first small window; only sparse crons expand (few occurrences per window). Multiple late callbacks firing after a suspension collapse onto the SAME latest occurrence, and the watermark dedups them to at most one run (no catch-up backlog — full restart catch-up remains Batch 3 scope).

### 3. Scheduled Enqueue Transaction

`RunCoordinator.enqueueExecRun()` accepts optional `ExecTrigger`:

```typescript
type ExecTrigger =
  | { kind: "manual" }
  | { kind: "scheduled"; scheduledFor: string; scheduleRevision: number };
```

**Scheduled trigger validation** (atomic transaction):
1. Re-read loop within transaction for latest state
2. Validate `scheduleRevision` matches (reject stale)
3. Validate `enabled=true` AND `cron IS NOT NULL` (reject inactive)
4. Validate `scheduledFor` parses and IS a genuine occurrence of the loop's current cron/timezone (`isOccurrence` — reject `not_an_occurrence`)
5. Validate `scheduledFor` is not in the future (reject `future_occurrence`)
6. **Canonicalize to UTC ISO** (`new Date(ms).toISOString()`) — every equivalent representation of the same instant (offset forms like `+08:00`) behaves identically; ALL subsequent comparisons and the persisted watermark use ONLY the canonical form
7. Validate `scheduledFor > scheduleActivatedAt` (reject before activation)
8. Validate `scheduledFor > lastScheduledAt` (reject duplicate/old)
9. **Atomically advance `lastScheduledAt = canonicalFor`** (watermark)
10. If running run exists, skip new pending but **watermark still advances**
11. Supersede old pending runs and insert new pending

Steps 4–6 close the watermark-pollution paths: an arbitrary, future, or non-canonically-encoded timestamp can never advance `lastScheduledAt` and thereby swallow later real ticks.

**Manual triggers** bypass all schedule validation (Phase 1-2 semantics preserved).

### 4. Dynamic Reconcile

The management surface syncs the scheduler through ONE injected seam: `onScheduleCommitted(loop)`, wired at composition (`start.ts`) to `scheduler.reconcile`:

**Call sites**:
- `POST /api/loops` after a committed create of an active scheduled loop — the seam receives the authoritative row returned by the INSERT (no post-commit re-read: a failed re-read would turn a committed create into a 500)
- `PATCH /api/loops/:id/schedule` after an EFFECTIVE change (`result.changed`) — a no-op patch must not replace the job
- Seam errors are caught at the call site and logged with a fixed classification; they never roll back the committed configuration nor fail the response

**No-op conditions**:
- Loop unchanged: `revision`, `cron`, `timezone` all match
- Scheduler already stopped

**Job replacement**:
- Stop old Croner job (if exists)
- Create new job with updated config
- Captures schedule state at registration time (closure)

**Job removal**:
- `enabled=false` OR `cron=null` → stop and remove job

**Reconcile is synchronous**: the HTTP response is shaped after the job registration attempt, ensuring immediate effect.

### 5. Error Isolation

**Per-loop isolation**:
- One loop's bad cron expression doesn't prevent others from registering
- Registration errors logged, loop skipped, startup continues
- Callback errors caught and logged, don't crash scheduler

**Startup failure handling**:
- A scan-level DB error from `scheduler.start()` is a BOOT failure. Cleanup follows the fixed shutdown order: drain the scheduler, then DRAIN THE LISTENER (await in-flight requests), and only then may the outer catch close the DB — an in-flight request must never meet a closed database
- The boot error rethrown to the entry layer carries a FIXED message (`scheduler startup scan failed`, original as `cause`) — the scan's original exception (DB internals) never reaches entry-layer logs
- Per-loop registration errors are isolated: logged with a fixed classification, loop skipped, startup continues

**Callback error handling**:
- Croner's `catch` option logs a fixed classification
- The callback RETURNS the enqueue promise, so Croner's `protect` sees the job as busy until the write settles — overrun protection actually blocks re-entrant ticks
- A callback firing after `stopAndDrain()` returns immediately (stopped guard) and never touches a closed database
- Coordinator enqueue failures logged per-loop with fixed classifications

### 6. Lifecycle Integration

**Startup sequence** (`src/start.ts`):
1. Bootstrap: create DB, coordinator, admin, sweep, **scheduler**
2. Start HTTP listener (wait for bind)
3. **Start scheduler** (scan and register jobs)
4. Arm sweep timer

**Shutdown sequence** (ordered chain):
1. **Stop scheduler and drain callbacks** (`stopAndDrain`)
2. Stop sweep and drain pass (`stopAndDrain`)
3. Close HTTP server
4. Close DB

**Rationale**: Scheduler callbacks may enqueue runs, so scheduler must drain before sweep (which operates on runs). Sweep must drain before DB close (mid-transaction protection).

### 7. Testing Strategy

**FakeCronFactory** for deterministic tests:
- Jobs fire on-demand via `triggerAll()`
- No real timers, full control over occurrence timing
- Test both happy path and error scenarios

**Test groups**:
- **A-group**: API surface (CreateLoop, UpdateSchedule, LoopSummary)
- **O-group**: Atomic occurrence handling (watermark, validation, transaction)
- **S-group**: Scheduler registration, reconcile, lifecycle
- **F-group**: Integration (HTTP routes, bootstrap, shutdown)

## Consequences

### Positive

✅ **Zero-downtime updates**: Schedule changes take effect immediately via reconcile
✅ **Deterministic occurrence**: `latestOccurrence` ensures canonical timestamps
✅ **Isolation**: One loop's failure doesn't affect others
✅ **Graceful shutdown**: In-flight callbacks complete before process exit
✅ **Manual-trigger preserved**: Phase 1-2 semantics unchanged
✅ **Fail-fast boot**: A scheduler scan failure fails boot with full cleanup instead of falsely reporting ready
✅ **Testable**: FakeCronFactory enables deterministic testing

### Negative

⚠️ **Single-process only**: No distributed scheduling (Phase 6 concern)
⚠️ **Clock skew**: System clock changes affect scheduling (acceptable for Phase 3)
⚠️ **Memory overhead**: One Croner job per active scheduled loop
⚠️ **Reconcile latency**: HTTP PATCH waits for job registration (typically <10ms)

### Trade-offs

**Watermark on running skip**: When a run is already running, new scheduled occurrences advance `lastScheduledAt` but don't create pending runs. This prevents backlog buildup but means some occurrences are silently skipped.

**Accepted**: This is correct behavior. A long-running execution should not accumulate pending runs. The watermark ensures we don't re-attempt skipped occurrences after the run completes.

**Callback closure captures schedule**: Each Croner job callback captures `cron`, `timezone`, `scheduleRevision` at registration time. This ensures callbacks use consistent schedule state even if reconcile happens mid-flight.

**Accepted**: Closure capture is safe because reconcile stops the old job before starting a new one. In-flight callbacks complete with their original schedule state, which is correct.

## Alternatives Considered

### Alt 1: External Scheduler (e.g., systemd timers, cron)

**Rejected**: Adds external dependency, complicates deployment, no dynamic reconcile without restart.

### Alt 2: DB-polling scheduler

Poll DB periodically for loops with `nextFireAt <= NOW()`, enqueue, update `nextFireAt`.

**Rejected**:
- Adds polling overhead
- Harder to test deterministically
- `nextFireAt` persistence creates consistency challenges
- Croner handles DST/timezone edge cases correctly

### Alt 3: Persist watermark in separate table

Store `lastScheduledAt` in a `loop_schedule_watermarks` table instead of `loops`.

**Rejected**: Adds table complexity for no benefit. `lastScheduledAt` is schedule state, belongs in `loops` table.

### Alt 4: Allow pending backlog accumulation

Don't skip occurrences when running run exists; let pendings accumulate.

**Rejected**: A 2-hour execution would create 120 pending runs (for a minutely schedule). Supersede semantics would cancel 119 of them anyway. Current approach (advance watermark, skip pending creation) is simpler and equivalent.

## Implementation Notes

**Production Croner factory** (`src/scheduler/croner-factory.ts`) — fixed options per plan §2:
```typescript
export const productionCronFactory: CronFactory = {
  create(pattern, options, callback) {
    const cron = new Cron(
      pattern,
      {
        timezone: options.timezone,
        protect: options.protect,
        catch: options.catch,
        mode: "5-part",  // lock five-segment parsing
        unref: true,     // timers never keep the process alive
      },
      callback,
    );
    return { stop: () => cron.stop() };
  },
};
```

**Scheduler logs** (fixed classifications, no user data — never an exception message, cron pattern or timezone):
- `scheduler: job_register_failed loop=<id>`
- `scheduler: job_stop_failed loop=<id>`
- `scheduler: overrun loop=<id>`
- `scheduler: croner_error loop=<id>`
- `scheduler: occurrence_rebuild_failed loop=<id>`
- `scheduler: enqueue_failed loop=<id>`
- `scheduler: enqueue_skipped loop=<id> reason=<fixed enum>`

All logs include loop ID (public) but never expose task content, workdir, or user data.

## References

- **Plan**: `docs/plan/codex-phase3-batch2-plan.md`
- **Protocol**: `packages/protocol/src/admin.ts` (UpdateScheduleRequest/Response)
- **Time semantics**: `packages/server/src/schedule/time-semantics.ts`
- **Coordinator**: `packages/server/src/coordinator/index.ts` (ExecTrigger)
- **Scheduler**: `packages/server/src/scheduler/index.ts`
- **Integration**: `packages/server/src/start.ts` (bootstrap, shutdown)

## Related ADRs

- **ADR-001**: Run lifecycle transaction boundaries
- **ADR-002**: Wire schema vs server policy (schedule field caps)
- **ADR-003**: Clock injection and timestamp ownership
