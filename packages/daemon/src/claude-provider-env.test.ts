/**
 * Provider bootstrap pins (P group, plan `codex-fix-claude-runner-plan`
 * §4.1/§5.1): the startup convergence of user-level Claude provider config
 * into controlled env vars. Security-critical halves: the REFUSAL pins
 * (non-allowed fields, system keys, schema violations) and the value-free
 * failure text — a leaked token in an error would defeat the whole point of
 * converging credentials into the redaction pipeline.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeProviderEnvError, resolveClaudeProviderEnv } from "./claude-provider-env.js";

let base: string | null = null;

afterEach(() => {
  if (base !== null) rmSync(base, { recursive: true, force: true });
  base = null;
});

/** A real temp config dir carrying the given settings object (or raw text). */
function makeConfigDir(settings?: unknown, raw?: string): string {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-provider-env-"));
  const configDir = path.join(base, "claude-config");
  mkdirSync(configDir, { recursive: true });
  if (raw !== undefined) writeFileSync(path.join(configDir, "settings.json"), raw);
  else if (settings !== undefined) writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings));
  return configDir;
}

describe("resolveClaudeProviderEnv — path resolution (P1–P4)", () => {
  it("P1: CLAUDE_CONFIG_DIR/settings.json wins over $HOME/.claude/settings.json", () => {
    base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-provider-env-"));
    const overrideDir = path.join(base, "override");
    const homeDir = path.join(base, "home");
    mkdirSync(overrideDir, { recursive: true });
    mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(overrideDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://from-override.example" } }),
    );
    writeFileSync(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://from-home.example" } }),
    );

    const resolved = resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: overrideDir, HOME: homeDir });
    expect(resolved.ANTHROPIC_BASE_URL).toBe("https://from-override.example");

    // Without the override, $HOME/.claude is the fallback.
    const fromHome = resolveClaudeProviderEnv({ HOME: homeDir });
    expect(fromHome.ANTHROPIC_BASE_URL).toBe("https://from-home.example");
  });

  it("P2: an empty CLAUDE_CONFIG_DIR falls back to $HOME/.claude", () => {
    base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-provider-env-"));
    const homeDir = path.join(base, "home");
    mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://from-home.example" } }),
    );
    const resolved = resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: "", HOME: homeDir });
    expect(resolved.ANTHROPIC_BASE_URL).toBe("https://from-home.example");
  });

  it("P3: neither CLAUDE_CONFIG_DIR nor HOME — the launch env stands alone, no error", () => {
    const source = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "", HOME: "" };
    expect(resolveClaudeProviderEnv(source)).toEqual(source);
    expect(resolveClaudeProviderEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it("P4: ONLY <configDir>/settings.json is read — exactly one read, never local/project settings", () => {
    const reads: string[] = [];
    const configDir = makeConfigDir({ env: { ANTHROPIC_API_KEY: "sk-from-settings" } });
    // A local settings file sitting right next to it carries a decoy token:
    // it must never even be opened.
    writeFileSync(
      path.join(configDir, "settings.local.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-from-local-DECOY" } }),
    );
    const resolved = resolveClaudeProviderEnv(
      { CLAUDE_CONFIG_DIR: configDir },
      {
        readSettingsFile: (settingsPath) => {
          reads.push(settingsPath);
          return JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-from-settings" } });
        },
      },
    );
    expect(reads).toEqual([path.join(configDir, "settings.json")]);
    expect(resolved.ANTHROPIC_API_KEY).toBe("sk-from-settings");
    expect(Object.values(resolved)).not.toContain("sk-from-local-DECOY");
  });
});

describe("resolveClaudeProviderEnv — field extraction and precedence (P5–P10)", () => {
  it("P5: every allowed field family is filled from settings when the launch env lacks it", () => {
    const configDir = makeConfigDir({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-settings-key",
        ANTHROPIC_AUTH_TOKEN: "settings-auth-token",
        ANTHROPIC_BASE_URL: "https://provider.example/api",
        ANTHROPIC_MODEL: "claude-fable-5",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-settings",
        HTTP_PROXY: "http://proxy:8080",
        https_proxy: "https://proxy:8443",
        NO_PROXY: "localhost",
        all_proxy: "socks5://proxy:1080",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        SSL_CERT_DIR: "/etc/ssl/certs",
        NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
      },
    });
    const resolved = resolveClaudeProviderEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir });
    expect(resolved).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: "sk-ant-settings-key",
      ANTHROPIC_AUTH_TOKEN: "settings-auth-token",
      ANTHROPIC_BASE_URL: "https://provider.example/api",
      ANTHROPIC_MODEL: "claude-fable-5",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-settings",
      HTTP_PROXY: "http://proxy:8080",
      https_proxy: "https://proxy:8443",
      NO_PROXY: "localhost",
      all_proxy: "socks5://proxy:1080",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
    });
  });

  it("P6: a non-empty explicit launch-env value ALWAYS wins over the settings value", () => {
    const configDir = makeConfigDir({
      env: {
        ANTHROPIC_API_KEY: "sk-settings-value",
        ANTHROPIC_BASE_URL: "https://settings.example",
        HTTPS_PROXY: "https://settings-proxy:8443",
      },
    });
    const resolved = resolveClaudeProviderEnv({
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: "sk-explicit-value",
      HTTPS_PROXY: "https://explicit-proxy:8443",
    });
    expect(resolved.ANTHROPIC_API_KEY).toBe("sk-explicit-value");
    expect(resolved.HTTPS_PROXY).toBe("https://explicit-proxy:8443");
    // …while the field the launch env leaves missing is still filled.
    expect(resolved.ANTHROPIC_BASE_URL).toBe("https://settings.example");
  });

  it("P7: an EMPTY explicit value counts as missing — settings fill it", () => {
    const configDir = makeConfigDir({ env: { ANTHROPIC_API_KEY: "sk-settings-value" } });
    const resolved = resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "" });
    expect(resolved.ANTHROPIC_API_KEY).toBe("sk-settings-value");
  });

  it("P8: non-allowed fields never enter the result (credentials, LOOPZHB_*, arbitrary keys)", () => {
    const configDir = makeConfigDir({
      env: {
        GITHUB_TOKEN: "ghp_settings",
        AWS_ACCESS_KEY_ID: "AKIA-SETTINGS",
        AWS_SECRET_ACCESS_KEY: "aws-settings-secret",
        GOOGLE_API_KEY: "google-settings",
        OPENAI_API_KEY: "sk-openai-settings",
        LOOPZHB_SERVER_URL: "http://evil.example",
        LOOPZHB_MACHINE_CREDENTIAL: "dk_settings",
        MY_CUSTOM: "x",
        ANTHROPIC_API_KEY: "sk-allowed",
      },
    });
    const resolved = resolveClaudeProviderEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir });
    expect(resolved).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "sk-allowed" });
    for (const refused of [
      "ghp_settings",
      "AKIA-SETTINGS",
      "aws-settings-secret",
      "google-settings",
      "sk-openai-settings",
      "http://evil.example",
      "dk_settings",
    ]) {
      expect(Object.values(resolved)).not.toContain(refused);
    }
  });

  it("P9: system keys can never come from settings — PATH/HOME/locale/CLAUDE_CONFIG_DIR stay launch-only", () => {
    const configDir = makeConfigDir({
      env: {
        PATH: "/evil/bin",
        HOME: "/evil/home",
        LANG: "evil_LOCALE",
        LC_ALL: "evil",
        TMPDIR: "/evil/tmp",
        CLAUDE_CONFIG_DIR: "/evil/config",
      },
    });
    const resolved = resolveClaudeProviderEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir });
    expect(resolved).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir });
  });

  it("P10: the source is never mutated and an empty settings value fills nothing", () => {
    const configDir = makeConfigDir({ env: { ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "https://ok.example" } });
    const source: NodeJS.ProcessEnv = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir };
    const resolved = resolveClaudeProviderEnv(source);
    expect(source).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir });
    expect(resolved).not.toBe(source);
    expect("ANTHROPIC_API_KEY" in resolved).toBe(false);
    expect(resolved.ANTHROPIC_BASE_URL).toBe("https://ok.example");
  });
});

describe("resolveClaudeProviderEnv — missing vs malformed (P11–P16)", () => {
  it("P11: a missing settings file is NOT an error — env-only deployments keep working", () => {
    const configDir = makeConfigDir(); // directory exists, no settings.json
    const source = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "sk-explicit" };
    expect(resolveClaudeProviderEnv(source)).toEqual(source);
  });

  it("P12: a missing config dir altogether resolves to the launch env unchanged", () => {
    const source = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: path.join(tmpdir(), "loopzhb-no-such-config-dir") };
    expect(resolveClaudeProviderEnv(source)).toEqual(source);
  });

  it("P13: invalid JSON fails closed with a stable, value-free error", () => {
    const configDir = makeConfigDir(undefined, '{ "env": { "ANTHROPIC_API_KEY": "sk-raw-fragment-9f8e7d"');
    try {
      resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeProviderEnvError);
      const message = (err as Error).message;
      expect(message).toContain("not valid JSON");
      expect(message).not.toContain("sk-raw-fragment-9f8e7d");
      expect(message).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  it("P14: a non-object settings document fails closed", () => {
    for (const raw of ['"just a string"', '["array"]', "42", "null"]) {
      const configDir = makeConfigDir(undefined, raw);
      expect(() => resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir })).toThrow(ClaudeProviderEnvError);
      expect(() => resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir })).toThrow("must be a JSON object");
      rmSync(base!, { recursive: true, force: true });
      base = null;
    }
  });

  it("P15: a non-object `env` fails closed; a MISSING `env` block fills nothing", () => {
    for (const raw of ['{"env": "nope"}', '{"env": [1,2]}', '{"env": null}', '{"env": 7}']) {
      const configDir = makeConfigDir(undefined, raw);
      expect(() => resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir })).toThrow(
        /"env" must be an object/,
      );
      rmSync(base!, { recursive: true, force: true });
      base = null;
    }
    const configDir = makeConfigDir({ model: "claude-fable-5" }); // no env block at all
    const source = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: configDir };
    expect(resolveClaudeProviderEnv(source)).toEqual(source);
  });

  it("P16: an ALLOWED field with a non-string value fails closed — naming the key, never the value", () => {
    const configDir = makeConfigDir({
      env: { ANTHROPIC_API_KEY: ["sk-array-value-9f8e7d6c"], GITHUB_TOKEN: 12345 },
    });
    try {
      resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeProviderEnvError);
      const message = (err as Error).message;
      expect(message).toContain("ANTHROPIC_API_KEY");
      expect(message).not.toContain("sk-array-value-9f8e7d6c");
      // The non-allowed GITHUB_TOKEN never reaches the schema check at all.
      expect(message).not.toContain("12345");
    }
  });
});

describe("resolveClaudeProviderEnv — unreadable file (P17–P18)", () => {
  it("P17: a reader failure is a fail-closed startup error carrying no adapter detail", () => {
    expect(() =>
      resolveClaudeProviderEnv(
        { CLAUDE_CONFIG_DIR: "/anywhere" },
        {
          readSettingsFile: () => {
            throw new Error("EACCES detail that could embed anything: sk-leak-9f8e7d6c5b");
          },
        },
      ),
    ).toThrow(ClaudeProviderEnvError);
    try {
      resolveClaudeProviderEnv(
        { CLAUDE_CONFIG_DIR: "/anywhere" },
        {
          readSettingsFile: () => {
            throw new Error("EACCES detail that could embed anything: sk-leak-9f8e7d6c5b");
          },
        },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("sk-leak-9f8e7d6c5b");
      expect((err as Error).message).not.toContain("EACCES detail");
    }
  });

  it("P18: the production reader maps ENOENT to absent and other fs failures to fail-closed", () => {
    // ENOENT (real filesystem): absent, not an error.
    const missing = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: path.join(tmpdir(), "loopzhb-enoent-config") };
    expect(resolveClaudeProviderEnv(missing)).toEqual(missing);

    // A real unreadable settings file (mode 000): fail-closed. A root-run
    // suite can still read it — detect that and skip rather than falsify.
    const configDir = makeConfigDir({ env: { ANTHROPIC_API_KEY: "sk-protected" } });
    const settingsPath = path.join(configDir, "settings.json");
    chmodSync(settingsPath, 0o000);
    try {
      const resolved = resolveClaudeProviderEnv({ CLAUDE_CONFIG_DIR: configDir });
      // Reaching here means the process could read a mode-000 file (root):
      // the unreadable path is unprovable in this environment.
      expect(resolved.ANTHROPIC_API_KEY).toBe("sk-protected");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeProviderEnvError);
      expect((err as Error).message).toContain("unreadable");
      expect((err as Error).message).not.toContain("sk-protected");
    } finally {
      chmodSync(settingsPath, 0o600); // make the temp dir removable
    }
  });
});
