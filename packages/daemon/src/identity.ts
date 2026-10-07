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
 *
 * Phase 5 Batch 2 slice 5 (ADR-010 决策 16/25): the daemon also declares
 * `artifact-sync-v1` — this is the deliberate production enablement of
 * continuous artifact sync. The server only sends a watch set to a capable
 * machine and only claims artifact-configured loops for one, so the capability
 * and the WatchManager ship together; AD4's daemon-half pins were rewritten
 * accordingly (identity.test.ts).
 */
import os from "node:os";

import {
  ARTIFACT_SYNC_V1_CAPABILITY,
  TERMINAL_JOURNAL_V1_CAPABILITY,
  type PollRequest,
} from "@loopzhb/protocol";

import { DAEMON_VERSION } from "./version.js";

export function machineIdentity(): PollRequest {
  return {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    version: DAEMON_VERSION,
    capabilities: [TERMINAL_JOURNAL_V1_CAPABILITY, ARTIFACT_SYNC_V1_CAPABILITY],
  };
}
