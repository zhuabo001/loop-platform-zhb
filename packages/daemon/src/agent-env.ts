/**
 * The agent environment whitelist (Phase 2 batch 2, plan §2.4): the child
 * process sees EXACTLY the allow-listed variables — never LOOPZHB_* (machine
 * credential, run tokens, server URL), cloud/CI keys, or anything else the
 * operator's shell happens to carry. secretValues feeds redactSecrets so
 * error text entering reports/logs never embeds a credential.
 */

export interface AgentEnv {
  env: Record<string, string>;
  secretValues: string[];
}

/** Exact-name allowances (system + TLS + Claude non-prefixed). */
const EXACT_ALLOW: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
]);

/** Proxy variables in BOTH cases (curl and friends honor either). */
const PROXY_NAMES: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
]);

/** Prefix allowances: locale and the Anthropic/Claude surface. */
const PREFIX_ALLOW: readonly string[] = ["LC_", "ANTHROPIC_"];

/** ALLOW-list semantics: absence is the default. LOOPZHB_*, GITHUB_TOKEN,
 *  AWS_*, GOOGLE_*, OPENAI_API_KEY, run tokens and everything else the shell
 *  carries simply never match. */
function isAllowed(key: string): boolean {
  return EXACT_ALLOW.has(key) || PROXY_NAMES.has(key) || PREFIX_ALLOW.some((prefix) => key.startsWith(prefix));
}

/** Which FORWARDED values are credentials: non-empty ANTHROPIC_* and the
 *  OAuth token are obvious; proxy URLs can embed userinfo. PATH/HOME/LANG
 *  are never secrets. */
function isSecret(key: string, value: string): boolean {
  if (value === "") return false;
  return key.startsWith("ANTHROPIC_") || key === "CLAUDE_CODE_OAUTH_TOKEN" || PROXY_NAMES.has(key);
}

/** Longest-first, deduped, empties dropped — replacing a short secret before
 *  an overlapping longer one would leave the tail of the longer behind. */
function normalizeSecrets(values: string[]): string[] {
  return [...new Set(values)].filter((value) => value !== "").sort((a, b) => b.length - a.length);
}

export function buildAgentEnv(source: NodeJS.ProcessEnv): AgentEnv {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !isAllowed(key)) continue;
    env[key] = value;
    if (isSecret(key, value)) secrets.push(value);
  }
  return { env, secretValues: normalizeSecrets(secrets) };
}

/** Replace every occurrence of every secret with [REDACTED]. Normalizes
 *  (longest-first, deduped, empties dropped) at the door so external callers
 *  get the same guarantees as buildAgentEnv's own output. */
export function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const secret of normalizeSecrets(secretValues)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
