/**
 * Config pins: every malformed explicit value fails fast; unset/blank takes
 * the default; the credential is NEVER echoed into an error message.
 */
import { describe, expect, it } from "vitest";

import { DaemonConfigError, loadDaemonConfig } from "./config.js";

const VALID = {
  LOOPZHB_SERVER_URL: "http://127.0.0.1:3000",
  LOOPZHB_MACHINE_CREDENTIAL: "dk_test_machine",
};

describe("loadDaemonConfig", () => {
  it("parses a minimal valid config and defaults pollMs to 3000", () => {
    expect(loadDaemonConfig(VALID)).toEqual({
      serverUrl: "http://127.0.0.1:3000",
      machineCredential: "dk_test_machine",
      pollMs: 3000,
    });
  });

  it("requires LOOPZHB_SERVER_URL (missing or blank fails fast)", () => {
    expect(() => loadDaemonConfig({ ...VALID, LOOPZHB_SERVER_URL: undefined })).toThrow(DaemonConfigError);
    expect(() => loadDaemonConfig({ ...VALID, LOOPZHB_SERVER_URL: "   " })).toThrow(/required/);
  });

  it("rejects non-URLs, non-http(s) schemes, userinfo, query and fragment", () => {
    for (const bad of [
      "not-a-url",
      "ftp://example.com",
      "http://user:pass@example.com",
      "http://example.com?x=1",
      "http://example.com#frag",
    ]) {
      expect(() => loadDaemonConfig({ ...VALID, LOOPZHB_SERVER_URL: bad }), bad).toThrow(DaemonConfigError);
    }
  });

  it("strips trailing slashes so route joins are exact", () => {
    const cfg = loadDaemonConfig({ ...VALID, LOOPZHB_SERVER_URL: "http://example.com/" });
    expect(cfg.serverUrl).toBe("http://example.com");
    const nested = loadDaemonConfig({ ...VALID, LOOPZHB_SERVER_URL: "https://example.com/base//" });
    expect(nested.serverUrl).toBe("https://example.com/base");
  });

  it("requires the credential and shape-checks it WITHOUT echoing the value", () => {
    expect(() => loadDaemonConfig({ ...VALID, LOOPZHB_MACHINE_CREDENTIAL: undefined })).toThrow(/required/);
    expect(() => loadDaemonConfig({ ...VALID, LOOPZHB_MACHINE_CREDENTIAL: "  " })).toThrow(/required/);
    const secret = "rk_not_a_device_token";
    try {
      loadDaemonConfig({ ...VALID, LOOPZHB_MACHINE_CREDENTIAL: secret });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonConfigError);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("accepts a shape-valid dk_ credential", () => {
    expect(loadDaemonConfig({ ...VALID, LOOPZHB_MACHINE_CREDENTIAL: "dk_demo_cookie_unified" }).machineCredential).toBe(
      "dk_demo_cookie_unified",
    );
  });

  it("parses LOOPZHB_POLL_MS strictly: decimal integer in 250–60000", () => {
    expect(loadDaemonConfig({ ...VALID, LOOPZHB_POLL_MS: "250" }).pollMs).toBe(250);
    expect(loadDaemonConfig({ ...VALID, LOOPZHB_POLL_MS: "60000" }).pollMs).toBe(60000);
    for (const bad of ["249", "60001", "3.5", "1e3", "+500", "abc"]) {
      expect(() => loadDaemonConfig({ ...VALID, LOOPZHB_POLL_MS: bad }), bad).toThrow(DaemonConfigError);
    }
    // a bare trim is the only normalization (same discipline as the server's parsePort)
    expect(loadDaemonConfig({ ...VALID, LOOPZHB_POLL_MS: "500 " }).pollMs).toBe(500);
    // blank = unset → default
    expect(loadDaemonConfig({ ...VALID, LOOPZHB_POLL_MS: " " }).pollMs).toBe(3000);
  });
});
