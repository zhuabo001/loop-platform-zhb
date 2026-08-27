# ADR-007: Online Scheduler Architecture

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
- Scheduler failures are non-fatal (server continues without scheduling)
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

Croner callbacks fire at approximately the scheduled minute, but may be delayed by system load. The Scheduler uses `latestOccurrence()` to reconstruct the canonical UTC timestamp:

```typescript
function latestOccurrence(schedule: NormalizedSchedule, atInclusive: Date): Date | null
```

**Algorithm**:
1. Look back 1 minute from callback firing time
2. Use `nextOccurrence()` to find the scheduled occurrence
3. If that occurrence ≤ firing time, it's the canonical timestamp

This ensures deterministic `scheduledFor` values across callback delays.

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
4. Validate `scheduledFor > scheduleActivatedAt` (reject before activation)
5. Validate `scheduledFor > lastScheduledAt` (reject duplicate/old)
6. **Atomically advance `lastScheduledAt = scheduledFor`** (watermark)
7. If running run exists, skip new pending but **watermark still advances**
8. Supersede old pending runs and insert new pending

**Manual triggers** bypass all schedule validation (Phase 1-2 semantics preserved).

### 4. Dynamic Reconcile

`scheduler.reconcile(loop)` is called by management API after schedule commits:

**No-op conditions**:
- Loop unchanged: `revision`, `cron`, `timezone` all match
- Scheduler already stopped

**Job replacement**:
- Stop old Croner job (if exists)
- Create new job with updated config
- Captures schedule state at registration time (closure)

**Job removal**:
- `enabled=false` OR `cron=null` → stop and remove job

**Reconcile is synchronous**: HTTP response waits for job registration, ensuring immediate effect.

### 5. Error Isolation

**Per-loop isolation**:
- One loop's bad cron expression doesn't prevent others from registering
- Registration errors logged, loop skipped, startup continues
- Callback errors caught and logged, don't crash scheduler

**Startup failure handling**:
- `scheduler.start()` errors are caught in `main()`
- Server continues without scheduling (non-fatal)
- Logged as `[scheduler] startup failed`

**Callback error handling**:
- Croner's `catch` option logs errors
- Coordinator enqueue failures logged per-loop
- Other callbacks continue normally

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
✅ **Non-fatal failures**: Scheduler errors don't crash server  
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

**Production Croner factory** (`src/scheduler/croner-factory.ts`):
```typescript
export const productionCronFactory: CronFactory = {
  create(pattern, options, callback) {
    const cron = new Cron(pattern, { timezone: options.timezone }, callback);
    return { stop: () => cron.stop() };
  },
};
```

**Scheduler logs** (fixed classifications, no user data):
- `scheduler: failed to register job for loop ${loopId}: ${error}`
- `scheduler: failed to stop job for loop ${loopId}: ${error}`
- `scheduler: overrun protection triggered for loop ${loopId}`
- `scheduler: croner error for loop ${loopId}: ${error}`
- `scheduler: failed to calculate occurrence for loop ${loopId}`
- `scheduler: enqueue failed for loop ${loopId}: ${error}`

All logs include loop ID (public) but never expose task content, workdir, or user data.

## References

- **Plan**: `docs/phase3-batch2-plan.md`
- **Protocol**: `packages/protocol/src/admin.ts` (UpdateScheduleRequest/Response)
- **Time semantics**: `packages/server/src/schedule/time-semantics.ts`
- **Coordinator**: `packages/server/src/coordinator/index.ts` (ExecTrigger)
- **Scheduler**: `packages/server/src/scheduler/index.ts`
- **Integration**: `packages/server/src/start.ts` (bootstrap, shutdown)

## Related ADRs

- **ADR-001**: Run lifecycle transaction boundaries
- **ADR-002**: Wire schema vs server policy (schedule field caps)
- **ADR-003**: Clock injection and timestamp ownership
