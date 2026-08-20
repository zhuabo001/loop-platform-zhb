/**
 * Agent-env pins (plan E1–E14): the whitelist is an ALLOW-list — absence is
 * the default, so the exclusion pins (E6–E8, E14) are the security-critical
 * half. Redaction sorts by length desc, dedupes, and never replaces "".
 */
import { describe, expect, it } from "vitest";

import { buildAgentEnv, buildProbeEnv, redactSecrets } from "./agent-env.js";

describe("buildAgentEnv — whitelist", () => {
  it("E1: forwards system vars PATH/HOME/LANG/TMPDIR", () => {
    const { env } = buildAgentEnv({ PATH: "/usr/bin", HOME: "/home/x", LANG: "en_US.UTF-8", TMPDIR: "/tmp" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", LANG: "en_US.UTF-8", TMPDIR: "/tmp" });
  });

  it("E2: forwards LC_* prefixed vars", () => {
    const { env } = buildAgentEnv({ LC_ALL: "C", LC_CTYPE: "UTF-8", LC_MESSAGES: "en_US" });
    expect(env).toEqual({ LC_ALL: "C", LC_CTYPE: "UTF-8", LC_MESSAGES: "en_US" });
  });

  it("E3: forwards proxy vars in BOTH cases", () => {
    const source = {
      HTTP_PROXY: "http://proxy:8080",
      http_proxy: "http://proxy:8080",
      HTTPS_PROXY: "https://proxy:8443",
      https_proxy: "https://proxy:8443",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
      ALL_PROXY: "socks5://proxy:1080",
      all_proxy: "socks5://proxy:1080",
    };
    expect(buildAgentEnv(source).env).toEqual(source);
  });

  it("E4: forwards TLS cert vars", () => {
    const source = {
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
    };
    expect(buildAgentEnv(source).env).toEqual(source);
  });

  it("E5: forwards ANTHROPIC_* plus the Claude oauth token and config dir", () => {
    const source = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      CLAUDE_CONFIG_DIR: "/home/x/.claude",
    };
    expect(buildAgentEnv(source).env).toEqual(source);
  });

  it("E6: never forwards LOOPZHB_* (credential, server URL, roots, binary, timeout)", () => {
    const { env } = buildAgentEnv({
      LOOPZHB_SERVER_URL: "http://127.0.0.1:3000",
      LOOPZHB_MACHINE_CREDENTIAL: "dk_secret",
      LOOPZHB_POLL_MS: "3000",
      LOOPZHB_ALLOWED_ROOTS: '["/tmp"]',
      LOOPZHB_CLAUDE_BIN: "claude",
      LOOPZHB_AGENT_TIMEOUT_MS: "1800000",
    });
    expect(env).toEqual({});
  });

  it("E7: never forwards GITHUB_TOKEN / AWS_* / GOOGLE_* / OPENAI_API_KEY", () => {
    const { env } = buildAgentEnv({
      GITHUB_TOKEN: "ghp_x",
      AWS_ACCESS_KEY_ID: "AKIA…",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
      GOOGLE_API_KEY: "google-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json",
      OPENAI_API_KEY: "sk-openai",
    });
    expect(env).toEqual({});
  });

  it("E8: never forwards arbitrary non-whitelist vars", () => {
    const { env } = buildAgentEnv({ EDITOR: "vim", MY_CUSTOM: "x", npm_config_cache: "/x", RUN_TOKEN: "rt_x" });
    expect(env).toEqual({});
  });

  it("E23: startup probes receive no credential-bearing env values", () => {
    expect(
      buildProbeEnv({
        PATH: "/usr/bin",
        HOME: "/home/x",
        LANG: "C",
        CLAUDE_CONFIG_DIR: "/home/x/.claude",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
        HTTPS_PROXY: "https://user:pass@proxy.example",
        NO_PROXY: "localhost",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LANG: "C",
      CLAUDE_CONFIG_DIR: "/home/x/.claude",
    });
  });
});

describe("secretValues and redactSecrets", () => {
  it("E9: secretValues collect non-empty ANTHROPIC_*, the OAuth token and proxy values", () => {
    const { secretValues } = buildAgentEnv({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      HTTPS_PROXY: "https://user:proxy-pass@proxy:8443",
      PATH: "/usr/bin",
    });
    expect(secretValues).toContain("sk-ant-secret");
    expect(secretValues).toContain("oauth-secret");
    expect(secretValues).toContain("https://user:proxy-pass@proxy:8443");
    // plan §2.4: EVERY non-empty ANTHROPIC_* value is treated as a secret —
    // redacting a URL is harmless, missing a credential is fatal.
    expect(secretValues).toContain("https://api.anthropic.com");
  });

  it("E10: PATH/HOME/LANG are never treated as secrets", () => {
    const { env, secretValues } = buildAgentEnv({ PATH: "/usr/bin", HOME: "/home/x", LANG: "C" });
    expect(Object.keys(env)).toHaveLength(3);
    for (const value of Object.values(env)) expect(secretValues).not.toContain(value);
  });

  it("E11: an empty-string secret never participates in replacement", () => {
    const { secretValues } = buildAgentEnv({ ANTHROPIC_API_KEY: "" });
    expect(secretValues).toEqual([]);
    // replacing "" would inject [REDACTED] between every character — pinned shut
    expect(redactSecrets("hello world", ["", ""])).toBe("hello world");
  });

  it("E12: overlapping secrets redact longest-first (no partial leftovers)", () => {
    const out = redactSecrets("token=sk-abcdef", ["sk-abc", "sk-abcdef"]);
    expect(out).toHaveLength("token=sk-abcdef".length - "sk-abcdef".length + 1);
    expect(out).not.toContain("sk-abc");
  });

  it("E13: every secret in a multi-secret text is redacted, duplicates included", () => {
    const text = "key=sk-ant-secret oauth=oauth-secret again=sk-ant-secret proxy=proxy-pass";
    const secrets = ["oauth-secret", "sk-ant-secret", "sk-ant-secret", "proxy-pass"];
    const out = redactSecrets(text, secrets);
    for (const secret of secrets) expect(out).not.toContain(secret);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(text, "utf8"));
  });

  it("E14: machine credential, run token and server URL never reach the child env", () => {
    const credential = "dk_secret_machine";
    const runToken = "rt_secret_run";
    const serverUrl = "http://127.0.0.1:3000";
    const { env } = buildAgentEnv({
      LOOPZHB_MACHINE_CREDENTIAL: credential,
      LOOPZHB_SERVER_URL: serverUrl,
      RUN_TOKEN: runToken,
      PATH: "/usr/bin",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
    for (const sensitive of [credential, runToken, serverUrl]) {
      expect(Object.values(env)).not.toContain(sensitive);
    }
  });
});

describe("redactSecrets — serialized forms (round-1 hardening)", () => {
  it("E15: secrets containing newlines/quotes/backslashes are redacted in JSON-escaped form too", () => {
    const secret = 'sk-line1\nline2"q"\\back';
    const serialized = JSON.stringify({ token: secret, note: "keep-me" });
    const out = redactSecrets(serialized, [secret]);
    expect(out).not.toContain("line1");
    expect(out).not.toContain("line2");
    expect(out).toContain("keep-me"); // non-secret content survives
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(serialized, "utf8"));
  });
});

describe("redactSecrets — encoded forms (review round-1 P1)", () => {
  it("E16: base64, base64url and hex encodings of a secret are redacted too", () => {
    const secret = "sk-ant-api03-ExAmPlE_Secret-1234567890abcdef+/";
    const forms = [
      Buffer.from(secret, "utf8").toString("base64"),
      Buffer.from(secret, "utf8").toString("base64url"),
      Buffer.from(secret, "utf8").toString("hex"),
      Buffer.from(secret, "utf8").toString("hex").toUpperCase(),
    ];
    for (const encoded of new Set(forms)) {
      const out = redactSecrets(`leak: ${encoded} end`, [secret]);
      expect(out).not.toContain(encoded);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(`leak: ${encoded} end`, "utf8"));
    }
  });

  it("E17: encoded forms only apply at realistic secret length — a short secret's hex would false-positive", () => {
    // hex("Ab") === "4162": redacting encoded forms of a 2-char secret would
    // eat ordinary text. The raw form still redacts.
    const out = redactSecrets("4162 stays, Ab redacted", ["Ab"]);
    expect(out).toHaveLength("4162 stays, Ab redacted".length - 1);
    expect(out).not.toContain("Ab");
  });

  it("E18: single-char secrets redact in one bounded pass without replacement re-entry (review round-3 P2)", () => {
    // The round-2 DoS repro used R/E/D/A/C/T secrets to re-match inside
    // earlier marker replacements and balloon ~649×. A combined one-pass
    // replacement must still redact those values without reprocessing its own
    // output. Matches use a one-byte ASCII boundary absent from every
    // secret, while every non-empty secret still participates in redaction.
    const singleCharOut = redactSecrets("RR", ["R", "E", "D", "A", "C", "T"]);
    expect(singleCharOut).toHaveLength(2);
    for (const secret of ["R", "E", "D", "A", "C", "T"]) expect(singleCharOut).not.toContain(secret);
    // The same no-growth invariant applies to every sub-marker-length secret.
    expect(redactSecrets("Ab".repeat(1000), ["Ab"])).toHaveLength(1000);
  });

  it("E24: one-character secrets cannot amplify output past a wire cap", () => {
    const input = "R".repeat(1024 * 1024);
    const out = redactSecrets(input, ["R"]);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(input, "utf8"));
    expect(out).not.toContain("R");
  });

  it("E25: redacting a short separator cannot reassemble another secret", () => {
    const out = redactSecrets("abcdXefgh", ["abcdefgh", "X"]);
    expect(out).not.toContain("abcdefgh");
    expect(out.length).toBeLessThanOrEqual("abcdXefgh".length);
  });

  it("E26: adjacent replacements cannot reassemble a secret across marker boundaries", () => {
    const out = redactSecrets("A".repeat(20), ["AAAAAAAAAA", "DACTED][RED"]);
    expect(out).not.toContain("AAAAAAAAAA");
    expect(out).not.toContain("DACTED][RED");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(20);
  });

  it("E27: a boundary marker cannot reassemble a derived secret form", () => {
    // The raw blockers force the first available marker to `%` unless marker
    // selection also considers derived forms. Replacing X must not complete
    // the percent encoding of the longer secret.
    const input = "abcX20defg";
    const out = redactSecrets(input, ["abc defg", "X", "!", "#", "$"]);
    expect(out).not.toContain("abc%20defg");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(input, "utf8"));
  });

  it("E28: exhausting every printable ASCII boundary fails closed", () => {
    const everyPrintableAscii = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
      String.fromCharCode(0x21 + index),
    ).join("");
    expect(redactSecrets("otherwise safe output", [everyPrintableAscii])).toBe("");
  });

  it("E19: separator-chunked forms are redacted — chunked base64 AND chunked raw (review round-2 P1)", () => {
    const secret = "sk-ant-api03-ExAmPlE_Secret-1234567890abcdef+/";
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const chunked = (b64.match(/.{1,4}/g) ?? []).join(" \n");
    expect(redactSecrets(`leak:\n${chunked}\nend`, [secret])).toBe("leak:\n!\nend");

    const chunkedRaw = (secret.match(/.{1,6}/g) ?? []).join(" ");
    // A trailing SEPARATOR-class char of the secret (here `/`) survives the
    // span — separators carry no decodable content; every needle char is gone.
    expect(redactSecrets(`k = ${chunkedRaw} ;`, [secret])).toBe("k = !/ ;");
  });

  it("E20: mixed-case, colon-separated hex is redacted", () => {
    const secret = "sk-ant-api03-ExAmPlE_Secret-1234567890abcdef+/";
    const hex = Buffer.from(secret, "utf8").toString("hex");
    const mixed = hex
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join("");
    const separated = (mixed.match(/.{1,2}/g) ?? []).join(":");
    expect(redactSecrets(`k=${separated};`, [secret])).toBe("k=!;");
  });

  it("E21: second-order base64 (base64 of the base64) is redacted", () => {
    const secret = "sk-ant-api03-ExAmPlE_Secret-1234567890abcdef+/";
    const nested = Buffer.from(Buffer.from(secret, "utf8").toString("base64"), "utf8").toString("base64");
    expect(redactSecrets(`x ${nested} y`, [secret])).toBe("x ! y");
  });

  it("E22: percent-encoded forms are redacted", () => {
    const secret = 'sk-ant key"with\\special\nchars!';
    const pct = encodeURIComponent(secret);
    expect(pct).not.toBe(secret); // the fixture secret must actually exercise encoding
    const out = redactSecrets(`t=${pct}`, [secret]);
    expect(out).not.toContain(pct);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(`t=${pct}`, "utf8"));
  });
});
