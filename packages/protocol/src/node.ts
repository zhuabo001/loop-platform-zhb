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

import {
  canonicalPreparePayloadString,
  canonicalWatchConfigString,
  type NormalizedPreparePayload,
} from "./artifact-policy.js";
import type { ArtifactWatchItem } from "./artifact.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Derive the stable machine id from its device token (`m-<sha256(token)[:16]>`). */
export function machineIdFromToken(token: string): string {
  return `m-${sha256(token).slice(0, 16)}`;
}

// ---- artifact sync fingerprints (ADR-010 决策 6) ----

/** The session idempotency fingerprint: sha256 over the canonical prepare
 *  payload (everything except `requestId`). Same key + same fingerprint ⇒
 *  reuse the session; same key + different fingerprint ⇒ conflict. The
 *  canonicalization itself is pure and lives in the main entry; the hash
 *  composition lives here because sha256 needs node:crypto. */
export function preparePayloadFingerprint(payload: NormalizedPreparePayload): string {
  return sha256(canonicalPreparePayloadString(payload));
}

/** The watch-configuration digest echoed in poll as `watchDigest`: sha256
 *  over the canonical watch set (config only, never file content). */
export function watchConfigDigest(items: readonly ArtifactWatchItem[]): string {
  return sha256(canonicalWatchConfigString(items));
}
