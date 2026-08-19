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

/**
 * Phase 2 batch 2 pins (plan C1–C16): LOOPZHB_ALLOWED_ROOTS is REQUIRED
 * (syntax-validated only — existence/canonicalization is the jail factory's
 * job, config parsing stays free of filesystem side effects);
 * LOOPZHB_CLAUDE_BIN and LOOPZHB_AGENT_TIMEOUT_MS take defaults when
 * unset/blank. New parse errors never echo the machine credential.
 */
describe("loadDaemonConfig — Phase 2 batch 2 fields", () => {
  const VALID_B2 = {
    ...VALID,
    LOOPZHB_ALLOWED_ROOTS: JSON.stringify(["/tmp/loopzhb-b2-root-a", "/tmp/loopzhb-b2-root-b"]),
  };

  it("C1/C2: requires LOOPZHB_ALLOWED_ROOTS (missing or blank fails fast)", () => {
    expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: undefined })).toThrow(DaemonConfigError);
    expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: "   " })).toThrow(/required/);
  });

  it("C3: rejects malformed JSON", () => {
    expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: "not-json" })).toThrow(DaemonConfigError);
    expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: '["/unclosed"' })).toThrow(DaemonConfigError);
  });

  it("C4: rejects non-array JSON (object/number/string)", () => {
    for (const bad of ['{"root":"/tmp"}', "42", '"/tmp"']) {
      expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: bad }), bad).toThrow(DaemonConfigError);
    }
  });

  it("C5: rejects an empty array", () => {
    expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: "[]" })).toThrow(DaemonConfigError);
  });

  it("C6: rejects non-string members", () => {
    for (const bad of ["[42]", "[null]", '[["/tmp"]]', '[{"root":"/tmp"}]']) {
      expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: bad }), bad).toThrow(DaemonConfigError);
    }
  });

  it("C7: rejects relative path members", () => {
    for (const bad of ['["relative/path"]', '["/abs/ok","relative/bad"]', '[""]']) {
      expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: bad }), bad).toThrow(DaemonConfigError);
    }
  });

  it("C8: rejects members containing .. segments", () => {
    for (const bad of ['["/foo/../bar"]', '["/foo/.."]', '["/../"]']) {
      expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: bad }), bad).toThrow(DaemonConfigError);
    }
  });

  it("C9/C10: parses one or more valid absolute roots", () => {
    expect(
      loadDaemonConfig({ ...VALID_B2, LOOPZHB_ALLOWED_ROOTS: JSON.stringify(["/tmp/solo-root"]) }).allowedRoots,
    ).toEqual(["/tmp/solo-root"]);
    expect(loadDaemonConfig(VALID_B2).allowedRoots).toEqual(["/tmp/loopzhb-b2-root-a", "/tmp/loopzhb-b2-root-b"]);
  });

  it("C11: dedupes exact duplicate roots, preserving first-seen order", () => {
    const cfg = loadDaemonConfig({
      ...VALID_B2,
      LOOPZHB_ALLOWED_ROOTS: JSON.stringify(["/tmp/a", "/tmp/b", "/tmp/a"]),
    });
    expect(cfg.allowedRoots).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("C12: defaults agentTimeoutMs to 1800000 when unset or blank", () => {
    expect(loadDaemonConfig(VALID_B2).agentTimeoutMs).toBe(1800000);
    expect(loadDaemonConfig({ ...VALID_B2, LOOPZHB_AGENT_TIMEOUT_MS: "  " }).agentTimeoutMs).toBe(1800000);
  });

  it("C13: rejects non-decimal, negative, zero and >2^31-1 timeouts", () => {
    for (const bad of ["3.5", "1e6", "+500", "abc", "-5", "0", "2147483648"]) {
      expect(() => loadDaemonConfig({ ...VALID_B2, LOOPZHB_AGENT_TIMEOUT_MS: bad }), bad).toThrow(DaemonConfigError);
    }
  });

  it("C14: accepts timeout bounds 1 and 2147483647", () => {
    expect(loadDaemonConfig({ ...VALID_B2, LOOPZHB_AGENT_TIMEOUT_MS: "1" }).agentTimeoutMs).toBe(1);
    expect(loadDaemonConfig({ ...VALID_B2, LOOPZHB_AGENT_TIMEOUT_MS: "2147483647" }).agentTimeoutMs).toBe(2147483647);
  });

  it("C15: defaults claudeBin to \"claude\"; trims explicit values", () => {
    expect(loadDaemonConfig(VALID_B2).claudeBin).toBe("claude");
    expect(loadDaemonConfig({ ...VALID_B2, LOOPZHB_CLAUDE_BIN: "  " }).claudeBin).toBe("claude");
    expect(loadDaemonConfig({ ...VALID_B2, LOOPZHB_CLAUDE_BIN: " /opt/claude/bin/claude " }).claudeBin).toBe(
      "/opt/claude/bin/claude",
    );
  });

  it("C16: new parse errors never echo the machine credential", () => {
    const secret = "dk_secret_b2_credential";
    const triggers: Array<Partial<typeof VALID_B2>> = [
      { LOOPZHB_ALLOWED_ROOTS: "not-json" },
      { LOOPZHB_ALLOWED_ROOTS: '["relative"]' },
      { LOOPZHB_AGENT_TIMEOUT_MS: "abc" },
      { LOOPZHB_AGENT_TIMEOUT_MS: "0" },
    ];
    for (const patch of triggers) {
      try {
        loadDaemonConfig({ ...VALID_B2, ...patch, LOOPZHB_MACHINE_CREDENTIAL: secret });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(DaemonConfigError);
        expect((err as Error).message).not.toContain(secret);
      }
    }
  });
});
