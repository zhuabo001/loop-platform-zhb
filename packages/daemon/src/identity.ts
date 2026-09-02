/**
 * The daemon's Machine identity: the four STATIC fields, fixed at startup.
 * The runtime merges them into every poll body together with the dynamic
 * `availableSlots`/`progress` it synthesizes per poll (Phase 2 batch 1) —
 * this module deliberately stays static. NO `wait` (fixed short-polling).
 *
 * Phase 4 Batch 2 (ADR-009 决策 7): every poll declares the daemon's CURRENT
 * complete capability set — `terminal-journal-v1` says this daemon runs the
 * Journal/Task-File/terminal-command contract, and the server claims new runs
 * only for machines that declare it.
 */
import os from "node:os";

import { TERMINAL_JOURNAL_V1_CAPABILITY, type PollRequest } from "@loopzhb/protocol";

import { DAEMON_VERSION } from "./version.js";

export function machineIdentity(): PollRequest {
  return {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    version: DAEMON_VERSION,
    capabilities: [TERMINAL_JOURNAL_V1_CAPABILITY],
  };
}
