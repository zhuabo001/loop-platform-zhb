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
 * Resolve a lease by credential hash. An expired terminal-grace lease is dead:
 * drop it lazily on resolve (it can never be reused) and report not-found.
 * Active leases carry `expiresAt: null` — the sweep, not lease expiry, is the
 * vanished-machine guard.
 */
export async function resolveLiveLease(deps: LeaseStoreDeps, tokenHash: string): Promise<RunLeaseRow | undefined> {
  const row = (await deps.db.select().from(runLeases).where(eq(runLeases.tokenHash, tokenHash)))[0];
  if (!row) return undefined;
  if (row.expiresAt != null && deps.clock.now().getTime() > Date.parse(row.expiresAt)) {
    await deps.db.delete(runLeases).where(eq(runLeases.tokenHash, tokenHash));
    return undefined;
  }
  return row;
}
