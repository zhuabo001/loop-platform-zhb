/**
 * The Dashboard's CSRF primitive (Batch 3 plan §2 切片二): ONE token per
 * server bootstrap, held only in that instance's memory, submitted as a hidden
 * form field and verified BEFORE the coordinator is ever called.
 *
 * Why not `c.req.parseBody()`: it collapses repeated keys (last one wins), so
 * a body carrying the token twice is indistinguishable from one carrying it
 * once. The plan requires duplicates to be rejected, hence an explicit
 * `URLSearchParams` scan. Reading the raw text also keeps the decision inside
 * one pure, directly testable function — no request object, no I/O.
 *
 * The token never reaches a URL, a log line or an error body; only the
 * rendered form carries it, on a response marked `Cache-Control: no-store`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes of CSPRNG, base64url so the value is attribute- and
 *  query-safe without escaping. */
export function mintCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The single form field the Dashboard's own form submits. */
export const CSRF_FIELD = "csrf";

export type CsrfVerdict =
  /** Exactly one `csrf` field, matching the expected token. */
  | "ok"
  /** The body is not the Dashboard's single-field form (an extra field). */
  | "bad_form"
  | "token_missing"
  | "token_duplicate"
  | "token_mismatch";

export type CsrfFieldVerdict =
  | { ok: true; values: Map<string, string> }
  | { ok: false; verdict: Exclude<CsrfVerdict, "ok"> | "field_duplicate" };

/**
 * Pure verdict for an `application/x-www-form-urlencoded` body carrying the
 * CSRF token PLUS a caller-declared field whitelist (Batch 2 slice 7's
 * artifact-config form). `checkCsrfForm` is EXACTLY this function with an
 * empty whitelist — one implementation, so the run form's frozen verdicts
 * can never drift from the generalized form.
 *
 * A field outside the whitelist is `bad_form`, exactly as an unknown field
 * always was: it means this is not the form we rendered. A whitelisted field
 * appearing twice is the new `field_duplicate` (400, not a token verdict).
 */
export function checkCsrfFormFields(
  body: string,
  expected: string,
  allowedFields: readonly string[],
): CsrfFieldVerdict {
  if (!isWellFormedFormBody(body)) return { ok: false, verdict: "bad_form" };

  const params = new URLSearchParams(body);
  // Pass 1 — the FROZEN order of the original single-field check: a stray
  // field means "not the form we rendered" and is judged before ANY token
  // verdict. (A merged single pass would classify `csrf=WRONG&extra=1` as
  // token_mismatch — a behavior change the run-form pin catches.)
  for (const key of new Set(params.keys())) {
    if (key !== CSRF_FIELD && !allowedFields.includes(key)) return { ok: false, verdict: "bad_form" };
  }

  const submitted = params.getAll(CSRF_FIELD);
  if (submitted.length === 0) return { ok: false, verdict: "token_missing" };
  if (submitted.length > 1) return { ok: false, verdict: "token_duplicate" };
  if (!tokensEqual(submitted[0]!, expected)) return { ok: false, verdict: "token_mismatch" };

  // Pass 2 — the whitelisted fields: single occurrence each, values for the
  // caller. A repeat is the new `field_duplicate` (400, not a token verdict).
  const values = new Map<string, string>();
  for (const key of new Set(params.keys())) {
    if (key === CSRF_FIELD) continue;
    const all = params.getAll(key);
    if (all.length > 1) return { ok: false, verdict: "field_duplicate" };
    values.set(key, all[0]!);
  }
  return { ok: true, values };
}

/**
 * Pure verdict for an `application/x-www-form-urlencoded` body carrying ONLY
 * the CSRF token (the run form's frozen contract).
 *
 * A stray field is `bad_form` rather than a token verdict: it means this is
 * not the form we rendered, and the distinction keeps 400 (malformed) and 403
 * (token) separable in the response taxonomy. An empty body is NOT malformed —
 * it is simply a missing token.
 *
 * Well-formedness is checked with `decodeURIComponent`, which throws on BOTH a
 * bad escape (`%`, `%GG`) and a bad UTF-8 sequence (`%C3%28`). `URLSearchParams`
 * is deliberately tolerant and would leave those as literal text, so a
 * corrupt body would be reported as "wrong token" (403) instead of the
 * "malformed form" (400) the plan requires. The check can never reject the
 * Dashboard's own submission: the token alphabet is base64url, so the form it
 * renders contains no escapes at all.
 */
export function checkCsrfForm(body: string, expected: string): CsrfVerdict {
  const verdict = checkCsrfFormFields(body, expected, []);
  if (verdict.ok) return "ok";
  // `field_duplicate` is unreachable with an empty whitelist (no whitelisted
  // field exists to repeat) — the cast narrows the type, not the runtime.
  return verdict.verdict as Exclude<CsrfVerdict, "ok">;
}

function isWellFormedFormBody(body: string): boolean {
  try {
    decodeURIComponent(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison. Length is checked first because `timingSafeEqual`
 * throws on unequal lengths — and an empty `expected` must never match.
 */
function tokensEqual(submitted: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = Buffer.from(submitted, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
