/**
 * The daemon's Machine identity: the four STATIC fields, fixed at startup.
 * The runtime merges them into every poll body together with the dynamic
 * `availableSlots`/`progress` it synthesizes per poll (Phase 2 batch 1) —
 * this module deliberately stays static. NO `wait` (fixed short-polling).
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
