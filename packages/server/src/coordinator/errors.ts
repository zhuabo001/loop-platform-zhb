/**
 * Coordinator-level errors. The HTTP adapter maps these onto the unified
 * error taxonomy (G-04) — the coordinator itself never speaks HTTP status.
 */
export class InvalidMachineCredentialError extends Error {
  constructor(message = "invalid machine credential") {
    super(message);
    this.name = "InvalidMachineCredentialError";
  }
}

/**
 * The unified run-capability denial (C-02/A-09): unknown, expired, consumed,
 * revoked, race-loser, orphaned-run and stale-phase credentials ALL map to the
 * same external 401 `{error, code: "run_capability_invalid"}`. The specific
 * `reason` is server-log material only — it never reaches the wire.
 */
export class RunCapabilityInvalidError extends Error {
  constructor(readonly reason: "unknown_or_expired" | "consumed_or_revoked" | "orphaned_run" | "stale_phase") {
    super(`run capability invalid: ${reason}`);
    this.name = "RunCapabilityInvalidError";
  }
}

/**
 * The report transaction's BOUNDED re-resolve also lost its CAS (a second
 * competitor committed during the single retry — real multi-connection
 * Postgres only; single-connection PGlite serializes the window away).
 * Deliberately NOT a RunCapabilityInvalidError: the report was NOT consumed,
 * so it must never earn the coded 401 the daemon reads as terminal
 * confirmation (it would drop an unapplied truth forever). The HTTP adapter
 * maps this to a plain 500 — the daemon keeps the pending report and retries,
 * converging on the winner's stable state (reconcile / coded 401) next time.
 */
export class ReportRaceLostError extends Error {
  constructor(readonly runId: string) {
    super(`report race lost twice for run ${runId} — no terminal write applied`);
    this.name = "ReportRaceLostError";
  }
}
