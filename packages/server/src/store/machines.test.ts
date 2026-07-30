/**
 * Consumer-side heartbeat watermark semantics (the 2026-07-30 A-13 ruling):
 * presence/sweep MUST classify through these pure helpers — an anomalous
 * far-future watermark is pollution, never proof of life, and the SAME skew
 * window the write side repairs by. (No consumer exists yet in Phase 1; the
 * helpers land the semantics structurally so Day 8–10 inherits them.)
 */
import { describe, expect, it } from "vitest";

import {
  classifyHeartbeatWatermark,
  heartbeatAgeMs,
  HEARTBEAT_SKEW_SLACK_MS,
  isHeartbeatWatermarkAnomalous,
} from "./machines.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("isHeartbeatWatermarkAnomalous", () => {
  it("is false at exactly the slack and true one ms beyond", () => {
    expect(isHeartbeatWatermarkAnomalous(NOW + HEARTBEAT_SKEW_SLACK_MS, NOW)).toBe(false);
    expect(isHeartbeatWatermarkAnomalous(NOW + HEARTBEAT_SKEW_SLACK_MS + 1, NOW)).toBe(true);
  });
});

describe("classifyHeartbeatWatermark", () => {
  it("classifies the four domains", () => {
    expect(classifyHeartbeatWatermark(null, NOW)).toBe("absent");
    expect(classifyHeartbeatWatermark("not-a-timestamp", NOW)).toBe("invalid");
    expect(classifyHeartbeatWatermark(at(HEARTBEAT_SKEW_SLACK_MS + 1), NOW)).toBe("anomalous-future");
    expect(classifyHeartbeatWatermark(at(-30_000), NOW)).toBe("valid"); // past
    expect(classifyHeartbeatWatermark(at(60_000), NOW)).toBe("valid"); // within-slack future
    expect(classifyHeartbeatWatermark(at(HEARTBEAT_SKEW_SLACK_MS), NOW)).toBe("valid"); // boundary
  });
});

describe("heartbeatAgeMs — liveness evidence for presence/sweep", () => {
  it("returns the real age for a past watermark", () => {
    expect(heartbeatAgeMs(at(-30_000), NOW)).toBe(30_000);
  });

  it("clamps a within-slack future watermark to 0 (just seen)", () => {
    expect(heartbeatAgeMs(at(60_000), NOW)).toBe(0);
  });

  it("returns null for absent/invalid/anomalous — NO liveness evidence", () => {
    expect(heartbeatAgeMs(null, NOW)).toBeNull();
    expect(heartbeatAgeMs("garbage", NOW)).toBeNull();
    // The poisoned-then-silent machine: pollution is not "online forever".
    expect(heartbeatAgeMs(at(24 * 60 * 60 * 1000), NOW)).toBeNull();
  });
});
