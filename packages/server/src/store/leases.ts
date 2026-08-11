/**
 * Store-internal lease reads. Only the sha256 of a run credential is ever
 * stored, so resolution is always by hash; the wire token stays opaque (the
 * reader side NEVER shape-filters — a legacy bare-UUID lease resolves
 * identically, ADR-002).
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { runLeases, type RunLeaseRow } from "../db/schema.js";
import type { Clock } from "../time.js";

export interface LeaseStoreDeps {
  db: Db;
  clock: Clock;
  /** Invariant lines: IDs + fixed classifications only — NEVER credentials
   * or untrusted database text. */
  log?: (line: string) => void;
}

/**
 * Is this lease dead at `nowMs`? The ONE predicate shared by the read-side
 * resolve, the report transaction's re-check, and the sweep's prune — "dead"
 * can never drift between surfaces. The input is deliberately narrowed to
 * exactly the two columns the rule reads, so partial projections (the sweep's
 * prune page) can share it directly.
 *
 * Fail closed for terminal-grace (Day 8–10 plan §1): its window stamp
 * MISSING or UNPARSEABLE means dead — a grace lease must never linger as a
 * reusable credential; `now >= expiresAt` ⇒ dead: a lease dies AT its
 * expiresAt.
 *
 * An ACTIVE lease is NEVER time-killed (review): only report, cancel or
 * reclaim may retire it. A non-null expiresAt on an active lease is
 * ANOMALOUS — every normal writer stores null — but deleting it would
 * manufacture a `running` run with NO active lease: an orphan that fails the
 * reclaim's conjunctive guard every pass and never self-heals. Treating it
 * as LIVE lets a normal report finalize the run (self-healing); the anomaly
 * is surfaced via `isActiveLeaseAnomalous` and one credential-free invariant
 * log at the report resolver boundary (before a retrying transaction starts).
 */
export function isLeaseDead(lease: Pick<RunLeaseRow, "state" | "expiresAt">, nowMs: number): boolean {
  if (lease.state === "terminal-grace") {
    if (lease.expiresAt == null) return true;
    const expiryMs = Date.parse(lease.expiresAt);
    return Number.isNaN(expiryMs) || nowMs >= expiryMs;
  }
  return false;
}

/** The invariant alarm for the anomalous `active + non-null expiresAt` combo
 *  (see isLeaseDead): never a death sentence, always worth a log line. */
export function isActiveLeaseAnomalous(lease: Pick<RunLeaseRow, "state" | "expiresAt">): boolean {
  return lease.state === "active" && lease.expiresAt != null;
}

/** A safe invariant line: expiry text is database input, so it is never
 * interpolated. This is the single vocabulary source for the report-side
 * anomaly event. */
export function activeLeaseAnomalyLine(runId: string): string {
  return `[lease] invariant violation run=${runId} classification=active_lease_has_expiry kept_live=true`;
}

/**
 * Resolve a lease by credential hash. A dead lease (expired window, or a
 * fail-closed terminal-grace) is dropped lazily on resolve — it can never be
 * reused — and reported as not-found. An ANOMALOUS active lease (non-null
 * expiresAt) stays live and logs one credential-free invariant event before
 * the report transaction may retry.
 */
export async function resolveLiveLease(deps: LeaseStoreDeps, tokenHash: string): Promise<RunLeaseRow | undefined> {
  const row = (await deps.db.select().from(runLeases).where(eq(runLeases.tokenHash, tokenHash)))[0];
  if (!row) return undefined;
  if (isLeaseDead(row, deps.clock.now().getTime())) {
    await deps.db.delete(runLeases).where(eq(runLeases.tokenHash, tokenHash));
    return undefined;
  }
  if (isActiveLeaseAnomalous(row)) (deps.log ?? console.warn)(activeLeaseAnomalyLine(row.runId));
  return row;
}
