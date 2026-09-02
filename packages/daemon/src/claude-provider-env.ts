/**
 * The startup provider bootstrap (plan `codex-fix-claude-runner-plan` §4;
 * Issue #38 root cause): the production runner spawns Claude with
 * `--safe-mode --setting-sources ""`, so Claude itself never loads ANY
 * settings source — including the user-level `settings.json` whose `env`
 * block carries the operator's provider endpoint, auth token and model
 * mapping. Without this bootstrap that isolated invocation path has no
 * usable provider configuration at all (`Not logged in`).
 *
 * This module converges the auth configuration into CONTROLLED environment
 * variables BEFORE any spawn: it reads ONLY `<configDir>/settings.json`
 * (configDir = the launch env's CLAUDE_CONFIG_DIR, else HOME/.claude),
 * extracts ONLY the allow-listed provider/TLS/proxy fields (the single
 * isProviderEnvKey classification in agent-env.ts), and lets every non-empty
 * explicit launch-env value win over the settings value. The merged env then
 * flows through the EXISTING buildAgentEnv allow-list + collectSecretValues
 * + redactSecrets pipeline, so settings-derived credentials inherit every
 * existing report/log/Journal redaction rule without a second secret path.
 *
 * Hard boundaries (plan §2/§4.1):
 *  - NEVER reads project/local settings, hooks, plugins, memory, permissions
 *    or any other user behavior configuration — exactly ONE file, exactly
 *    ONE top-level `env` object, exactly the isProviderEnvKey field set;
 *  - PATH, HOME, locale and CLAUDE_CONFIG_DIR can never come from settings;
 *    LOOPZHB_*, cloud/CI credentials and every unknown field are refused;
 *  - a MISSING settings file is not an error (env-only deployments keep
 *    working); an unreadable file, non-object JSON, a non-object `env`, or a
 *    non-string allowed field is FAIL-CLOSED at startup;
 *  - errors are stable and value-free: no file content, no field value, no
 *    token — a field NAME and the settings path are the most they carry;
 *  - returns a NEW env object; the source is never mutated and nothing is
 *    logged here.
 *
 * It does NOT make Claude read user settings at runtime, and it never puts a
 * credential into argv or `--settings` JSON — env only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { isProviderEnvKey } from "./agent-env.js";

/** Startup-fatal provider bootstrap failure. The message is stable and
 *  carries NO file content, field value or credential. */
export class ClaudeProviderEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeProviderEnvError";
  }
}

/** The file-reading seam. Returns the settings file's utf8 content, or null
 *  when the file does not exist; any other failure throws. Tests inject a
 *  pure adapter; production binds the Node filesystem. */
export type SettingsFileReader = (settingsPath: string) => string | null;

export interface ClaudeProviderEnvDeps {
  readSettingsFile?: SettingsFileReader;
}

/** Production reader: ENOENT (including an unlink race between any existence
 *  check and the read) means "no user config"; everything else is an
 *  unreadable-file startup failure. The underlying error message is NOT
 *  propagated — adapters may embed arbitrary text. */
const nodeReadSettingsFile: SettingsFileReader = (settingsPath) => {
  try {
    return readFileSync(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ClaudeProviderEnvError(`claude provider settings are unreadable: ${settingsPath}`);
  }
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the env the daemon may hand to Claude: `source` plus the
 *  allow-listed provider/TLS/proxy fields of the user-level settings `env`,
 *  with every non-empty `source` value taking precedence (settings only fill
 *  what the launch env leaves missing or empty). */
export function resolveClaudeProviderEnv(
  source: NodeJS.ProcessEnv,
  deps: ClaudeProviderEnvDeps = {},
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };

  const configDirOverride = source.CLAUDE_CONFIG_DIR;
  const configDir =
    configDirOverride !== undefined && configDirOverride !== ""
      ? configDirOverride
      : source.HOME !== undefined && source.HOME !== ""
        ? path.join(source.HOME, ".claude")
        : undefined;
  // No config dir is determinable (neither CLAUDE_CONFIG_DIR nor HOME): the
  // launch env stands alone — exactly the missing-settings semantics.
  if (configDir === undefined) return resolved;

  const settingsPath = path.join(configDir, "settings.json");
  const readSettingsFile = deps.readSettingsFile ?? nodeReadSettingsFile;
  let raw: string | null;
  try {
    raw = readSettingsFile(settingsPath);
  } catch (err) {
    if (err instanceof ClaudeProviderEnvError) throw err;
    throw new ClaudeProviderEnvError(`claude provider settings are unreadable: ${settingsPath}`);
  }
  if (raw === null) return resolved;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeProviderEnvError(`claude provider settings are not valid JSON: ${settingsPath}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ClaudeProviderEnvError(`claude provider settings must be a JSON object: ${settingsPath}`);
  }
  const settingsEnv = parsed["env"];
  if (settingsEnv === undefined) return resolved; // no env block: nothing to fill
  if (!isPlainObject(settingsEnv)) {
    throw new ClaudeProviderEnvError(`claude provider settings "env" must be an object: ${settingsPath}`);
  }

  for (const [key, value] of Object.entries(settingsEnv)) {
    // Refused by classification: system keys, LOOPZHB_*, cloud/CI
    // credentials and every unknown field never enter the result, whatever
    // their type (plan §4.1 rules 5–6).
    if (!isProviderEnvKey(key)) continue;
    // An ALLOWED field of the wrong type is a schema violation: fail closed
    // (a silently dropped endpoint/token would surface as an opaque auth
    // failure far from the cause). The key name is not sensitive.
    if (typeof value !== "string") {
      throw new ClaudeProviderEnvError(`claude provider settings field ${key} must be a string: ${settingsPath}`);
    }
    if (value === "") continue; // an empty settings value fills nothing
    const explicit = resolved[key];
    if (explicit === undefined || explicit === "") resolved[key] = value;
  }
  return resolved;
}
