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

**Artifact Home**:
The single owner of a Loop's artifact synchronization: it negotiates a manifest, accepts verified
blob uploads, commits one immutable snapshot, and serves the current view and snapshots.
_Avoid_: Artifact service, sync API

**Artifact Manifest**:
The complete `{path, hash, size}` list a sync declares for a Loop's artifact directory; a path
absent from the next committed manifest is a deletion.
_Avoid_: File list, delta, diff

**Artifact Snapshot**:
The immutable committed manifest identified by its manifest ID, which doubles as a Run's
`artifactSnapshotId`; a Run's final report may reference at most one.
_Avoid_: Version, revision, backup

**Manifest Revision**:
The Loop-scoped monotone counter a committed snapshot advances by exactly one.
_Avoid_: Version, build number, config generation

**Config Generation**:
The monotone `artifactConfigRevision` counter of a Loop's artifact-directory configuration; a
change keeps the last manifest pointer and marks the view stale by generation.
_Avoid_: Config version, epoch

**Sync Session**:
One prepare negotiation keyed by trusted namespace, Machine, and client requestId, with a
canonical payload fingerprint; it expires while pending and becomes a fixed receipt at commit.
_Avoid_: Upload session, transaction, job

**Blob**:
Content-addressed bytes stored under one storage namespace and SHA-256 hash; manifest paths never
map to disk paths.
_Avoid_: File, object, upload

**BlobStore**:
The server-internal storage contract of verified write, presence, and read; this batch has no
deletion or garbage collection.
_Avoid_: Filesystem, storage backend

**Storage Namespace**:
The artifact isolation boundary derived only from trusted Machine attribution; wire input can
never name one.
_Avoid_: Team id, tenant, bucket, prefix

**Never-sync**:
The shared path rules that the daemon and the server both exclude, so the two sides never
disagree about what may sync.
_Avoid_: Ignore list, blacklist

**Snapshot Binding**:
The guarded link between a Run and a committed manifest whose identity chain and config
generation were verified at write time.
_Avoid_: Snapshot attach, reference update
