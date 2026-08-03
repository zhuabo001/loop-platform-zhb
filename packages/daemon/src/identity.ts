/**
 * The daemon's Machine identity, fixed at startup and sent (unchanged) on
 * every poll. Only these four identity fields are ever sent — NO `wait`
 * (Day 5 is fixed short-polling) and no `progress` (that heartbeat arrives
 * with the real AgentRunner in Phase 2).
 */
import os from "node:os";

import type { PollRequest } from "@loopzhb/protocol";

import { DAEMON_VERSION } from "./version.js";

export function machineIdentity(): PollRequest {
  return {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    version: DAEMON_VERSION,
  };
}
