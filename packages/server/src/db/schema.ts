/**
 * Loop-platform-zhb business schema (Drizzle, Postgres `pg-core` dialect) — the
 * HEART tables: machines / loops / runs / run_leases. See docs/adr/003-heart-schema.md.
 *
 * Conventions (mirror the reference implementation, loop-platform
 * packages/server/src/db/schema.ts):
 *  - timestamps are ISO strings in `text` columns (no db-side defaults; the
 *    writer stamps them — portable across the pglite/postgres tiers);
 *  - JSON columns use `jsonb().$type<>()` for typed (de)serialization;
 *  - enums are TS-only (`text(col, {enum})`, no DB CHECK) so WIDENING a value
 *    set never needs a migration (ADR-002: enums only ever GROW);
 *  - NO foreign keys: cascades live in the store layer (like the reference's
 *    `store.deleteLoop`), keeping write-order semantics explicit.
 *
 * Enum value lists are NOT declared here — they are imported from
 * `@loopzhb/protocol`, the single source (this is that single source's first
 * payoff: the DB can never drift from the wire). `{enum: [...CONST]}` spreads
 * the readonly const tuple into the mutable tuple drizzle's type wants; the
 * VALUE list stays single-sourced.
 *
 * Column sets are the reference's, PRUNED to what the heart path (poll claim /
 * report finalize / sweep / supersede) reads and writes — later phases add
 * their columns additively (ADR-003 has the full deferral map).
 */
import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import {
  CODING_AGENTS,
  LEASE_STATES,
  RUN_OUTCOMES,
  RUN_PHASES,
  RUN_ROLES,
  RUN_STATUSES,
  TASK_FILE_SYNC_ERRORS,
} from "@loopzhb/protocol";
import type { RunArtifact, TranscriptStep } from "@loopzhb/protocol";

// ---- shared storage shapes ----
//
// These are STORAGE shapes, not wire shapes, so they live here rather than in
// the protocol package: `RunUsage` carries `attempts` (daemon-internal resume
// accounting) and no `usd` (the aggregable USD figure is its own real column);
// `RunProgressRow` carries the server-stamped `at` the wire progress entry
// lacks. `RunArtifact`/`TranscriptStep` ARE identical on the wire and in
// storage (the daemon pushes exactly what gets persisted), so those two are
// imported from the protocol above.

/** Token-usage breakdown reported alongside a run's cost (all optional — a
 *  timed-out run reports none). Rides in a JSON column; the aggregable USD
 *  figure gets its own real column (`runs.costUsd`). */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  numTurns?: number;
  /** Total agent invocations for the run — present only when > 1 (transient-
   *  failure resume; cost/tokens are the sum across attempts). */
  attempts?: number;
}

/** This run's observation snapshot — numeric metrics plus scalar values. */
export type RunState = Record<string, number | string>;

/** Live "what's it doing" signal while running — pushed on the poll heartbeat
 *  (NOT the full transcript). Cleared at finalize. `at` is the freshness stamp
 *  the SWEEP reads as last-heard-from (load-bearing for the inactivity
 *  reclaim); the wire progress entry lacks it — the server stamps it. */
export interface RunProgressRow {
  step: number;
  label: string;
  at?: string;
}

// ---- machines: a user's daemon (machine == identity unit) ----

export const machines = pgTable("machines", {
  /** m-sha256(deviceToken)[:16] — see `@loopzhb/protocol/node` machineIdFromToken. */
  id: text("id").primaryKey(),
  /** Friendly name (set after the daemon connects; empty string = unnamed). */
  name: text("name").notNull(),
  /** Daemon-reported machine identity (captured on first connect / on change). */
  hostname: text("hostname"),
  platform: text("platform"),
  arch: text("arch"),
  /** Daemon package version reported on poll; null until the first report. */
  daemonVersion: text("daemon_version"),
  /** sha256 of the device token. HASH ONLY — no plaintext token column (the
   *  reference keeps one for UI re-show; without a UI there is no re-show need,
   *  and a DB leak must not hand out live machine credentials). */
  tokenHash: text("token_hash").notNull(),
  /** Workdir allowlist the daemon enforces as cwd jail; null/[] = unrestricted. */
  roots: jsonb("roots").$type<string[]>(),
  /** Persisted Machine heartbeat watermark (ISO), not an exact per-Poll audit
   *  timestamp. Presence is DERIVED from this stamp + current time — there is
   *  deliberately no `online` boolean column (even the reference recomputes
   *  `now - lastSeen` on every read; its column is a redundant cache). */
  lastSeen: text("last_seen"),
  /** Phase 4: the daemon's LATEST capability snapshot (deduped + sorted at the
   *  store layer; null = never declared / pre-Phase-4 daemon). Batch 1 keeps
   *  this column write-closed — poll parses capabilities but does not persist
   *  them (ADR-009 决策 11). */
  capabilities: jsonb("capabilities").$type<string[]>(),
  createdAt: text("created_at").notNull(),
});

// ---- loops: a scheduled behavior bound to one machine ----

export const loops = pgTable(
  "loops",
  {
    id: text("id").primaryKey(),
    /** Execution machine (set at creation; no cross-machine fallback). */
    machineId: text("machine_id").notNull(),
    name: text("name"),
    /** Absolute project dir ON THE MACHINE the agent runs in (cwd). Null ⇒ daemon scratch dir. */
    workdir: text("workdir"),
    /** Path ON THE MACHINE to the loop's durable context+log doc. */
    taskFile: text("task_file"),
    /** Latest synced snapshot of `taskFile`'s content — the daemon pushes it on
     *  report. Null ⇒ never synced (no run yet / no file). */
    taskFileContent: text("task_file_content"),
    /** When `taskFileContent` was last synced from the machine (ISO). */
    taskFileSyncedAt: text("task_file_synced_at"),
    /** Zero-LLM pre-filter JS (async function body). Runs on the machine. */
    workflow: text("workflow"),
    model: text("model"),
    /** May a run change its own schedule (reschedule/set-cron)? Default TRUE —
     *  false = the owner PINS the schedule. */
    allowControl: boolean("allow_control").notNull().default(true),
    /** Coding agent this loop is executed with. TS-only enum DERIVED from the
     *  protocol's CODING_AGENTS single source, so widening the set is a one-line
     *  edit there with no migration and no change here. */
    agent: text("agent", { enum: [...CODING_AGENTS] }).notNull().default("claude-code"),
    enabled: boolean("enabled").notNull().default(true),
    /** Workflow cursor: last returned state, passed back to the next run as `prev`. */
    state: jsonb("state").$type<unknown>(),
    /** Standard five-segment cron expression (minute hour day month weekday).
     *  Null = manual-only loop (no automatic scheduling). */
    cron: text("cron"),
    /** IANA timezone for cron interpretation (e.g., 'UTC', 'Asia/Shanghai',
     *  'America/New_York'). Must be recognizable by the runtime. */
    timezone: text("timezone").notNull().default("UTC"),
    /** Next planned automatic execution time (ISO). Phase 3 keeps this
     *  write-closed (always null) — schema declaration only. */
    nextRunAt: text("next_run_at"),
    /** Schedule configuration revision number — increments on every effective
     *  configuration change (cron/timezone/enabled). Used to detect stale
     *  schedule updates and track configuration history. */
    scheduleRevision: integer("schedule_revision").notNull().default(0),
    /** Activation timestamp (ISO) for the current schedule configuration. Set
     *  when enabled=true && cron!=null; cleared when paused or manual-only.
     *  Establishes the boundary for occurrence calculation — runs are never
     *  backfilled before this timestamp. */
    scheduleActivatedAt: text("schedule_activated_at"),
    /** Last automatic scheduling trigger timestamp (ISO). Watermark for
     *  occurrence calculation — cleared on configuration change, advanced on
     *  each automatic trigger. Phase 3 Batch 1 keeps this write-closed. */
    lastScheduledAt: text("last_scheduled_at"),
    /** Phase 4: the loop's normalized goal (null = Open Loop, ADR-009 决策 2).
     *  Write-closed in Batch 1 — the goal management route mounts in Batch 2. */
    goal: text("goal"),
    /** Monotonic goal-change counter (0 at creation; +1 per effective
     *  set/change/clear; never reset, never overflowing int32). Leases capture
     *  it at claim time — a stale-goal finish is rejected (ADR-009 决策 4). */
    goalRevision: integer("goal_revision").notNull().default(0),
    /** Phase 4 completion triple: all-or-nothing with completionReason and
     *  (goal, enabled=false) — enforced by the loops_completion_ck CHECK
     *  below AND re-validated by the domain kernel (ADR-009 决策 3). */
    completedAt: text("completed_at"),
    completionReason: text("completion_reason"),
    /** Last task-file sync ATTEMPT (ISO) — set on both success and failure,
     *  unlike task_file_synced_at which only a success advances. */
    taskFileSyncAttemptedAt: text("task_file_sync_attempted_at"),
    /** Why the last task-file sync failed (TS-only enum from the protocol's
     *  TASK_FILE_SYNC_ERRORS single source). Null after a successful sync. */
    taskFileSyncError: text("task_file_sync_error", { enum: [...TASK_FILE_SYNC_ERRORS] }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("loops_machine_idx").on(t.machineId),
    /** Covers the Scheduler's active-schedule scan (enabled loops with cron).
     *  Partial index keeps it small — only rows where enabled=true AND cron IS NOT NULL. */
    index("loops_active_schedule_idx").on(t.id).where(sql`${t.enabled} = true AND ${t.cron} IS NOT NULL`),
    /** ADR-009 决策 3: the persisted completion state is either fully absent
     *  or fully present (goal + completed_at + completion_reason, paused).
     *  Half-completed rows can never be committed. */
    check(
      "loops_completion_ck",
      sql`(${t.completedAt} IS NULL AND ${t.completionReason} IS NULL)
          OR (${t.goal} IS NOT NULL AND ${t.completedAt} IS NOT NULL
              AND ${t.completionReason} IS NOT NULL AND ${t.enabled} = false)`,
    ),
  ],
);

// ---- runs: one execution record ----

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    machineId: text("machine_id").notNull(),
    phase: text("phase", { enum: [...RUN_PHASES] }).notNull(),
    role: text("role", { enum: [...RUN_ROLES] }).notNull(),
    /** NOT the creation time: re-stamped at EVERY lifecycle transition (claim,
     *  finalize, reclaim, supersede) — read it as "last transition at". The
     *  sweep's inactivity window measures from `max(ts, progress.at)`. */
    ts: text("ts").notNull(),
    /** Terminal classification. `error`/`skipped` are SERVER-ASSIGNED only
     *  (sweep reclaim / supersede), never daemon-reported (protocol report.ts). */
    outcome: text("outcome", { enum: [...RUN_OUTCOMES] }),
    status: text("status", { enum: [...RUN_STATUSES] }),
    message: text("message"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    state: jsonb("state").$type<RunState>(),
    /** Agent session id on the machine (locates the local transcript). */
    sessionId: text("session_id"),
    /** Agent's own USD estimate for the run. A real column (not JSON) so
     *  per-loop totals are one SUM. Null: workflow-only run, or the run never
     *  reached a terminal result event. */
    costUsd: doublePrecision("cost_usd"),
    usage: jsonb("usage").$type<RunUsage>(),
    /** Files the run's agent session created/edited (path relative to workdir). */
    artifacts: jsonb("artifacts").$type<RunArtifact[]>(),
    /** Slimmed execution trace. Null for workflow-only runs (no agent). */
    transcript: jsonb("transcript").$type<TranscriptStep[]>(),
    progress: jsonb("progress").$type<RunProgressRow>(),
  },
  (t) => [
    index("runs_loop_idx").on(t.loopId),
    index("runs_loop_ts_idx").on(t.loopId, t.ts),
    /** Covers the sweep's open-runs scan (`phase IN (pending, running)`). */
    index("runs_phase_idx").on(t.phase),
    /** The poll claim scan (`WHERE machineId=? AND phase='pending'`) is the hot
     *  path — every poll from every machine. Partial index per ADR-001: pending
     *  rows are always a handful, so this stays tiny. */
    index("runs_pending_idx").on(t.machineId).where(sql`${t.phase} = 'pending'`),
  ],
);

// ---- run_leases: the per-run credential (durable across restarts) ----
//
// A RUN LEASE is minted per delivery and authorizes every in-run verb plus the
// final report. Only the sha256 of the wire token is stored — a DB leak must
// not hand out live run credentials. Lifecycle (the state machine ADR-001
// requires to be fixed NOW):
//
//   active ──[any finalize: normal report / enriching report / the ONE
//             reconciling wake-report]──▶ retired (row DELETEd)
//   active ──[owner cancel: run → canceled + lease DELETE in ONE tx]──▶ retired
//   active ──[sweep reclaim, and ONLY the sweep]──▶ terminal-grace
//   terminal-grace ──[ONE reconciling wake-report]──▶ retired
//   past expiresAt ──▶ lazy drop on resolve / prune in the sweep
//
// `terminal-grace` UNIQUELY marks a swept run — that is what lets report()'s
// reconcile branch fire only for swept runs, never a normal failure. `finish`
// (Phase 4) deliberately does NOT terminalize: it leaves the lease active for
// one enriching report. `expiresAt` null encodes the active lease's Infinity —
// the server's inactivity sweep, not lease expiry, is the vanished-machine guard;
// ONLY an active lease held by a running run may carry null (a canceled run
// never leaves an active lease — cancel deletes it in the same transaction).

export const runLeases = pgTable(
  "run_leases",
  {
    /** sha256 hex of the full wire token (`rk_…`). */
    tokenHash: text("token_hash").primaryKey(),
    runId: text("run_id").notNull(),
    loopId: text("loop_id").notNull(),
    machineId: text("machine_id").notNull(),
    role: text("role", { enum: [...RUN_ROLES] }).notNull(),
    allowControl: boolean("allow_control").notNull().default(false),
    canSetUi: boolean("can_set_ui").notNull().default(false),
    canSetSchema: boolean("can_set_schema").notNull().default(false),
    canSetWorkflow: boolean("can_set_workflow").notNull().default(false),
    canFinish: boolean("can_finish").notNull().default(false),
    state: text("state", { enum: [...LEASE_STATES] }).notNull().default("active"),
    /** Null while active (never expires); ISO once terminalized (grace window). */
    expiresAt: text("expires_at"),
    /** Phase 4: the terminal protocol this lease's report must follow (ADR-009
     *  决策 7 — the AUTHORITATIVE switch; capabilities or request fields can
     *  never upgrade a v0 lease). Batch 1 claims write 0 explicitly. */
    terminalProtocolVersion: integer("terminal_protocol_version").notNull().default(0),
    /** The loop's goalRevision captured at claim time; a finish presented
     *  against a different current revision is stale_goal (ADR-009 决策 4). */
    goalRevision: integer("goal_revision").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  // runId is UNIQUE: at most one LIVE lease row per run (terminalizeLease
  // targets by runId). The "never re-minted, ever" lifetime guarantee is NOT
  // the index's job — it falls out of the run's terminal phase + the atomic
  // claim + the gateway's no-re-delivery guard. The loop cascade deletes by loopId.
  (t) => [uniqueIndex("run_leases_run_idx").on(t.runId), index("run_leases_loop_idx").on(t.loopId)],
);

export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type Loop = typeof loops.$inferSelect;
export type NewLoop = typeof loops.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunLeaseRow = typeof runLeases.$inferSelect;
export type NewRunLease = typeof runLeases.$inferInsert;

/** Drizzle table bag (single schema object shared by the db handle). */
export const businessSchema = { machines, loops, runs, runLeases };
