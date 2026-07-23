/**
 * Node-only helpers (node:crypto) — the SUBPATH `@loopzhb/protocol/node`.
 *
 * Kept OUT of the main entry so the main entry stays importable from a browser
 * bundle (the server's TanStack client code may import protocol types/schemas).
 *
 * `machineIdFromToken` is THE machine-id derivation, shared by server and
 * daemon — the reference's daemon re-implements it (create.ts idempotency
 * keys), which is exactly the drift this package exists to kill.
 * Mirrors loop-platform packages/server/src/gateway/tokens.ts:23-35.
 */
import { createHash } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Derive the stable machine id from its device token (`m-<sha256(token)[:16]>`). */
export function machineIdFromToken(token: string): string {
  return `m-${sha256(token).slice(0, 16)}`;
}
