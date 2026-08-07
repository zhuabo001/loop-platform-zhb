/**
 * Error shape for the classic machine routes (poll / report / …): JSON
 * `{error: string}` plus an HTTP status. `code` is an optional machine-readable
 * slug for callers that branch programmatically (the reference's CLI transport
 * renders TOON `code:` lines; the classic routes carry plain `error`).
 *
 * Status conventions (mirror the reference gateway):
 *  - 400 malformed body / validation failure
 *  - 401 missing / malformed / unknown credential (device token or run lease)
 *  - 403 authenticated but out of scope (owner-only verb, cross-loop target)
 *  - 404 flat not-found (existence never leaks across scope)
 *  - 409 conflict (e.g. a mutation attempted against a terminal-grace lease)
 *  - 413 body over the route's byte cap
 *  - 429 rate limited (machine routes only; byte-ingress routes exempt)
 */
import { z } from "zod";

/** The one machine-readable code whose semantics are fixed in Phase 1: a Run
 *  Capability is permanently invalid, so a daemon must stop reporting with it. */
export const RUN_CAPABILITY_INVALID_CODE = "run_capability_invalid" as const;

export const apiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
