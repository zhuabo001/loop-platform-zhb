/**
 * @loopzhb/daemon public surface (plan §4): the Runner seam, the Fake Runner,
 * config parsing, the injectable Machine client and the daemon runtime
 * factory. The CLI (cli.ts) is a SEPARATE composition root and is
 * deliberately NOT re-exported — importing this module must never boot
 * anything.
 *
 * The provider bootstrap and its secret classifier are exported for the
 * server-side acceptance tests, which must scan daemon logs for exactly the
 * credentials the daemon's own bootstrap could have converged (plan
 * `codex-fix-claude-runner-plan` §5.5).
 */
export * from "./version.js";
export * from "./config.js";
export * from "./identity.js";
export * from "./client.js";
export * from "./runner.js";
export * from "./runtime.js";
export { ClaudeProviderEnvError, resolveClaudeProviderEnv } from "./claude-provider-env.js";
export { collectSecretValues } from "./agent-env.js";
