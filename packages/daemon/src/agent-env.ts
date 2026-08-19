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

export function buildAgentEnv(source: NodeJS.ProcessEnv): AgentEnv {
  // RED SKELETON (pair E1–E8): passthrough with no filtering — the exclusion
  // pins (E6–E8) fail against this, the inclusion pins pass trivially.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return { env, secretValues: [] };
}

export function redactSecrets(text: string, secretValues: string[]): string {
  void secretValues;
  return text;
}
