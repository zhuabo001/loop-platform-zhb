/**
 * Session-level CSRF (SE8 at the pure-function layer): derivation from the
 * session credential + the verdict matrix for a token-only form — sharing
 * the dashboard's frozen extraction rules.
 */
import { describe, expect, it } from "vitest";

import { sha256 } from "@loopzhb/protocol/node";

import { checkSessionCsrfForm, deriveSessionCsrfToken } from "./session-csrf.js";

describe("deriveSessionCsrfToken", () => {
  it("is deterministic per credential and distinct across credentials", () => {
    const a = deriveSessionCsrfToken("sk_a");
    expect(a).toBe(sha256("sk_a:csrf"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSessionCsrfToken("sk_a")).toBe(a);
    expect(deriveSessionCsrfToken("sk_b")).not.toBe(a);
  });
});

describe("checkSessionCsrfForm verdict matrix (SE8)", () => {
  const token = deriveSessionCsrfToken("sk_test_session");

  it("ok: exactly one csrf field matching the session's derived token", () => {
    expect(checkSessionCsrfForm(`csrf=${token}`, token)).toBe("ok");
  });

  it("token_mismatch: another session's token is rejected (SE7 isolation, unit layer)", () => {
    const other = deriveSessionCsrfToken("sk_other_session");
    expect(checkSessionCsrfForm(`csrf=${other}`, token)).toBe("token_mismatch");
  });

  it("token_missing: no csrf field — and an EMPTY body is missing, not malformed", () => {
    expect(checkSessionCsrfForm("", token)).toBe("token_missing");
  });

  it("token_duplicate: the field carried twice is rejected even if one matches", () => {
    expect(checkSessionCsrfForm(`csrf=${token}&csrf=${token}`, token)).toBe("token_duplicate");
    expect(checkSessionCsrfForm(`csrf=${token}&csrf=wrong`, token)).toBe("token_duplicate");
  });

  it("bad_form: a stray field means this is not the form we rendered", () => {
    expect(checkSessionCsrfForm(`csrf=${token}&extra=1`, token)).toBe("bad_form");
  });

  it("bad_form: a corrupt escape sequence is malformed, not a wrong token", () => {
    expect(checkSessionCsrfForm("csrf=%", token)).toBe("bad_form");
    expect(checkSessionCsrfForm("csrf=%C3%28", token)).toBe("bad_form");
  });

  it("never matches an empty expected token (length pre-check before timingSafeEqual)", () => {
    expect(checkSessionCsrfForm("csrf=", token)).toBe("token_mismatch");
    expect(checkSessionCsrfForm(`csrf=${token}`, "")).toBe("token_mismatch");
  });
});
