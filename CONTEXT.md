# Loop Platform Domain

Loop Platform coordinates Runs that execute on a user's machine while the server retains scheduling,
state, authentication, and reliability responsibilities.

## Language

**Run Credential**:
A bearer secret that proves possession of the authority represented by one RunLease.
_Avoid_: Run token when referring to the authority itself

**RunLease**:
The durable grant that authorizes actions against exactly one Run.
_Avoid_: Session, machine credential

**Sweep**:
The server process that identifies open Runs whose machine activity has gone stale.
_Avoid_: Reclaim

**Reclaim**:
The recovery of one stale running Run into an observable failure while preserving its one-time
reconciliation opportunity.
_Avoid_: Sweep, cancel

**Run Transition Time**:
The time of a Run's most recent lifecycle transition.
_Avoid_: Run creation time

**Machine Heartbeat Watermark**:
Durable recent proof that an authenticated Machine has contacted the server; Machine presence is
derived from this watermark rather than stored as a separate fact.
_Avoid_: Exact last-Poll audit time, online flag

**Supersede**:
The replacement of unclaimed pending Exec Runs from earlier triggers by a newer trigger.
Superseded Runs are skipped; running Runs are never superseded.
_Avoid_: Cancel, retry

**Run Capability**:
The effective authority formed by a coherent live RunLease and its Run, presented through a Run
Credential.
_Avoid_: Token, authentication

**Capability Invalidation**:
The permanent end of a Run Capability because its grant was consumed, revoked, expired, orphaned, or
became incoherent with the Run lifecycle.
_Avoid_: Generic failure, conflict

**Capability Denial**:
The rejection of an action because a valid Run Capability does not grant that permission.
_Avoid_: Invalidation, conflict

**Capability Conflict**:
The rejection of an action because a valid Run Capability exists but the Run or lease lifecycle does
not currently allow that action.
_Avoid_: Invalidation, denial

**Open Loop**:
A Loop whose Goal is `null`; it runs until paused and can never Finish.
_Avoid_: Unbounded loop, free loop

**Closed Loop**:
A Loop with a non-null Goal; only its qualifying Exec Runs may declare Finish.
_Avoid_: Bounded loop, task loop

**Paused Loop**:
A Loop with `enabled=false` that is not Completed; automatic scheduling stops, but Run Now remains
allowed.
_Avoid_: Disabled loop, stopped loop

**Completed Loop**:
A Loop whose Completion triple (goal, completedAt, completionReason) is present; `enabled=false` is
implied, and only Reopen can make it runnable again.
_Avoid_: Done loop, finished loop (Finish is the act, Completed is the state)

**Finish**:
The terminal command by which a qualifying Closed Loop exec Run declares its Goal achieved,
completing the Loop atomically with its final Report.
_Avoid_: Complete, close, resolve (resolve is a Run status, not the Loop act)

**Reopen**:
The management operation that clears a Completed Loop's completion fields, re-enables it, and
restores its schedule with a new activation boundary—without backfilling occurrences missed while
completed.
_Avoid_: Restart, resume, unpause

**Terminal Journal**:
The per-Run local directory where the daemon's in-run control CLI records exactly one report/finish
command as a file, with no network access.
_Avoid_: Control channel, callback socket

**Terminal Protocol**:
The versioned contract, captured in the RunLease at claim time, that determines whether a final
Report follows Phase 3 semantics (v0) or consumes the Terminal Journal's terminal command, state,
and Task File sync result (v1).
_Avoid_: API version, negotiation handshake
