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
