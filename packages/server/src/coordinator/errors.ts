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
