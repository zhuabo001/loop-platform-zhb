/**
 * SE4 (unit layer): the frozen cookie attribute matrix — names, Path,
 * Max-Age, HttpOnly/SameSite=Lax, Secure exactly iff the origin is https —
 * plus the minimal Cookie-header parser's edge behavior.
 */
import { describe, expect, it } from "vitest";

import {
  buildOAuthTxCookie,
  buildOAuthTxCookieClear,
  buildSessionCookie,
  buildSessionCookieClear,
  OAUTH_TX_COOKIE,
  parseCookieHeader,
  SESSION_COOKIE,
} from "./cookies.js";

describe("Set-Cookie builders (SE4)", () => {
  it("session cookie: exact attribute string, insecure variant", () => {
    expect(buildSessionCookie("sk_abc", { secure: false })).toBe(
      "loopzhb_session=sk_abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800",
    );
  });

  it("session cookie: Secure appears exactly when the origin is https", () => {
    expect(buildSessionCookie("sk_abc", { secure: true })).toBe(
      "loopzhb_session=sk_abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800; Secure",
    );
  });

  it("oauth tx cookie: scoped to /auth/github with a 600s lifetime", () => {
    expect(buildOAuthTxCookie("tx-1", { secure: false })).toBe(
      "loopzhb_oauth_tx=tx-1; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=600",
    );
    expect(buildOAuthTxCookie("tx-1", { secure: true })).toBe(
      "loopzhb_oauth_tx=tx-1; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=600; Secure",
    );
  });

  it("clear cookies: same name and Path, empty value, Max-Age=0", () => {
    expect(buildSessionCookieClear({ secure: false })).toBe(
      "loopzhb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    expect(buildOAuthTxCookieClear({ secure: true })).toBe(
      "loopzhb_oauth_tx=; HttpOnly; SameSite=Lax; Path=/auth/github; Max-Age=0; Secure",
    );
  });

  it("no cookie ever carries a Domain attribute", () => {
    for (const header of [
      buildSessionCookie("v", { secure: true }),
      buildSessionCookieClear({ secure: false }),
      buildOAuthTxCookie("v", { secure: false }),
      buildOAuthTxCookieClear({ secure: true }),
    ]) {
      expect(header).not.toMatch(/Domain/i);
    }
  });
});

describe("parseCookieHeader", () => {
  it("round-trips the module's own cookie values", () => {
    const header = `${SESSION_COOKIE}=sk_abc-123; ${OAUTH_TX_COOKIE}=deadbeef`;
    const parsed = parseCookieHeader(header);
    expect(parsed.get(SESSION_COOKIE)).toBe("sk_abc-123");
    expect(parsed.get(OAUTH_TX_COOKIE)).toBe("deadbeef");
  });

  it("undefined or empty header parses to an empty map", () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader("").size).toBe(0);
  });

  it("splits values on the FIRST '=' only (base64 padding survives)", () => {
    expect(parseCookieHeader("k=abc==").get("k")).toBe("abc==");
  });

  it("drops entries without '=' and entries with an empty name", () => {
    const parsed = parseCookieHeader("flag; =novalue; good=1");
    expect([...parsed.entries()]).toEqual([["good", "1"]]);
  });

  it("the FIRST occurrence of a duplicate name wins", () => {
    expect(parseCookieHeader("a=1; a=2").get("a")).toBe("1");
  });

  it("trims whitespace around names and values", () => {
    expect(parseCookieHeader("  a  =  1  ; b=2").get("a")).toBe("1");
  });
});
