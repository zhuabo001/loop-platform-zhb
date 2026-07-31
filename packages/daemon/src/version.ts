/**
 * Daemon package version anchor — the value sent as `version` in the poll
 * identity. A COMMITTED constant (no runtime package.json import, no
 * build-time generation); version.test.ts asserts it equals package.json's
 * `version`, so the two cannot drift.
 */
export const DAEMON_VERSION = "0.1.0";
