/**
 * The ONE JSON error shape shared by the JSON API and the Dashboard's
 * pre-route gates (`{ "error": ... }`, plus the optional additive `code`).
 *
 * Extracted from app.ts so that the Dashboard's Host gate can return a 404
 * that is BYTE-IDENTICAL to `app.notFound`'s — the whole point of that gate is
 * that "not mounted", "hostile Host" and "unknown path" are indistinguishable,
 * and two hand-written copies of the same shape would eventually drift.
 */
import type { Context } from "hono";

/** The statuses either surface may emit. Deliberately explicit: a typo'd
 *  status must not compile. 303 is absent on purpose — a redirect carries no
 *  error body and is never built through this helper. */
export type JsonErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500;

export function jsonError(c: Context, status: JsonErrorStatus, error: string, code?: string): Response {
  return c.json(code === undefined ? { error } : { error, code }, status);
}
