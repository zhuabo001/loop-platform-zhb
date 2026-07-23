/**
 * Wire enum single sources. Every enum is a `const` array (the value list) + a
 * zod schema (runtime validation) + an inferred type — all three derive from the
 * one array, so WIDENING a set is a one-line edit (ADR-002: enums only ever GROW;
 * a tolerant reader must treat an unknown enum value as a parse failure at its
 * own boundary, never crash a peer).
 *
 * Value lists mirror the reference implementation (loop-platform
 * packages/server/src/db/schema.ts:77-91, src/types.ts CODING_AGENTS) verbatim.
 */
import { z } from "zod";

export const RUN_PHASES = ["pending", "running", "done", "error", "canceled"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const runPhaseSchema = z.enum(RUN_PHASES);

export const RUN_ROLES = ["exec", "evolve", "edit"] as const;
export type RunRole = (typeof RUN_ROLES)[number];
export const runRoleSchema = z.enum(RUN_ROLES);

/**
 * Terminal classification of a run. `error` and `skipped` are SERVER-ASSIGNED
 * only — a daemon may never report them (see `reportOutcomeSchema` in report.ts
 * for the wire-claimable subset). `skipped`: a deferred pending run retired
 * without executing; neither success nor failure.
 */
export const RUN_OUTCOMES = ["silent", "direct", "exec", "error", "evolve", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const runOutcomeSchema = z.enum(RUN_OUTCOMES);

export const RUN_STATUSES = ["new", "resolved", "nothing-new"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const runStatusSchema = z.enum(RUN_STATUSES);

/** Run-lease lifecycle: active → terminal-grace (swept run's reconcile window). */
export const LEASE_STATES = ["active", "terminal-grace"] as const;
export type LeaseState = (typeof LEASE_STATES)[number];
export const leaseStateSchema = z.enum(LEASE_STATES);

export const CODING_AGENTS = ["claude-code", "codex", "grok"] as const;
export type CodingAgent = (typeof CODING_AGENTS)[number];
export const codingAgentSchema = z.enum(CODING_AGENTS);

export const NOTIFY_POLICIES = ["always", "auto", "never"] as const;
export type NotifyPolicy = (typeof NOTIFY_POLICIES)[number];
export const notifyPolicySchema = z.enum(NOTIFY_POLICIES);
