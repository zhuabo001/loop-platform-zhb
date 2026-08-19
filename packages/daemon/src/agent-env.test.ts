/**
 * Agent-env pins (plan E1–E14): the whitelist is an ALLOW-list — absence is
 * the default, so the exclusion pins (E6–E8, E14) are the security-critical
 * half. Redaction sorts by length desc, dedupes, and never replaces "".
 */
import { describe, expect, it } from "vitest";

import { buildAgentEnv, redactSecrets } from "./agent-env.js";

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
});
