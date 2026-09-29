/**
 * AD4 dormancy, daemon half (Phase 5 Batch 1 slice 3, ADR-010 决策 16): the
 * daemon declares ONLY `terminal-journal-v1` — no `artifact-sync-v1` — and
 * the identity merged into every poll carries no artifact field (the
 * identity-level evidence for "daemon sends no sync request"). Batch 2
 * wiring must update these pins deliberately.
 */
import { describe, expect, it } from "vitest";

import { ARTIFACT_SYNC_V1_CAPABILITY, TERMINAL_JOURNAL_V1_CAPABILITY } from "@loopzhb/protocol";

import { machineIdentity } from "./identity.js";

describe("machineIdentity (AD4)", () => {
  it("declares exactly the terminal-journal-v1 capability — no artifact-sync-v1", () => {
    expect(machineIdentity().capabilities).toEqual([TERMINAL_JOURNAL_V1_CAPABILITY]);
    expect(machineIdentity().capabilities).not.toContain(ARTIFACT_SYNC_V1_CAPABILITY);
  });

  it("carries no artifact field — exactly the five static identity keys", () => {
    expect(Object.keys(machineIdentity()).sort()).toEqual(["arch", "capabilities", "host", "platform", "version"]);
  });
});
