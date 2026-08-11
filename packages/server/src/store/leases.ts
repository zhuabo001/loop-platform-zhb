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
}

/**
 * Is this lease dead at `nowMs`? The ONE predicate shared by the read-side
 * resolve, the report transaction's re-check, and (by the same rule) the
 * sweep's prune — "dead" can never drift between surfaces.
 *
 * Fail closed for terminal-grace (Day 8–10 plan §1): its window stamp
 * MISSING or UNPARSEABLE means dead — a grace lease must never linger as a
 * reusable credential. An ACTIVE lease's null expiresAt is its documented
 * Infinity (the sweep, not lease expiry, is the vanished-machine guard); only
 * a present, past expiresAt kills it. `now >= expiresAt` ⇒ dead: a lease
 * dies AT its expiresAt.
 */
export function isLeaseDead(lease: RunLeaseRow, nowMs: number): boolean {
  if (lease.state === "terminal-grace") {
    if (lease.expiresAt == null) return true;
    const expiryMs = Date.parse(lease.expiresAt);
    return Number.isNaN(expiryMs) || nowMs >= expiryMs;
  }
  return lease.expiresAt != null && nowMs >= Date.parse(lease.expiresAt);
}

/**
 * Resolve a lease by credential hash. A dead lease (expired window, or a
 * fail-closed terminal-grace) is dropped lazily on resolve — it can never be
 * reused — and reported as not-found.
 */
export async function resolveLiveLease(deps: LeaseStoreDeps, tokenHash: string): Promise<RunLeaseRow | undefined> {
  const row = (await deps.db.select().from(runLeases).where(eq(runLeases.tokenHash, tokenHash)))[0];
  if (!row) return undefined;
  if (isLeaseDead(row, deps.clock.now().getTime())) {
    await deps.db.delete(runLeases).where(eq(runLeases.tokenHash, tokenHash));
    return undefined;
  }
  return row;
}
