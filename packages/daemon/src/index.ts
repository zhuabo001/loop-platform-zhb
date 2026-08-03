/**
 * @loopzhb/daemon public surface (plan §4): the Runner seam, the Fake Runner,
 * config parsing, the injectable Machine client and the daemon runtime
 * factory. The CLI (cli.ts) is a SEPARATE composition root and is
 * deliberately NOT re-exported — importing this module must never boot
 * anything.
 */
export * from "./version.js";
export * from "./config.js";
export * from "./identity.js";
export * from "./client.js";
export * from "./runner.js";
export * from "./runtime.js";
