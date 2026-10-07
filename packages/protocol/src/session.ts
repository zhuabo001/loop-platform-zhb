/**
 * `GET /api/session` wire shape (Phase 5 Batch 3 slice 2, ADR-011): the
 * authenticated browser's current identity — User, personal Team, the Login
 * Session's absolute expiry, and the session-level form CSRF token.
 *
 * The `csrfToken` plaintext rides ONLY this response (on `Cache-Control:
 * no-store`). The token is DERIVED from the session credential
 * (`sha256(credential + ":csrf")`, ADR-011 决策 11) and is NEVER persisted —
 * the retracted migration-0007 hash column does not exist. The field is part
 * of the frozen DTO now so the slice-6 dashboard wiring never touches this
 * schema.
 *
 * Tolerant-reader convention: structure is pinned, server-internal invariants
 * (numeric GitHub id, `t-<hex>` team id) are NOT re-declared here — those
 * rules live in the server schema (ADR-011 决策 1/2) and are pinned by the
 * server's own route tests.
 */
import { z } from "zod";

/** Admin wire timestamps are real ISO datetimes (admin.ts convention). */
const isoTimestampSchema = z.iso.datetime({ offset: true });

export const sessionInfoResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
  }),
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
  session: z.object({
    /** Absolute expiry (ISO), writer-stamped at login; never slides. */
    expiresAt: isoTimestampSchema,
  }),
  /** The session-level form CSRF token (plaintext; derived from the session
   *  credential, never stored). */
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoResponseSchema>;
