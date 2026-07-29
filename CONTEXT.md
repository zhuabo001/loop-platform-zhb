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
