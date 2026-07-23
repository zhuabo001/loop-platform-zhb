import { describe, expect, it } from "vitest";

import {
  costReportSchema,
  REPORT_OUTCOMES,
  reportRequestSchema,
  reportResponseSchema,
  transcriptStepSchema,
} from "./report.js";

const GOLDEN_REPORT = {
  runId: "r_01HXYZ",
  ok: true,
  outcome: "exec",
  message: "Fixed the worst react-doctor issue; PR opened.",
  finalText: "Done — PR #42 opened.",
  cursor: { lastSweep: "2026-07-23" },
  durationMs: 184_000,
  sessionId: "sess_abc123",
  taskFileContent: "# react-doctor\n\n## Spec\n...",
  artifacts: [{ path: "src/app.ts", kind: "edited" }],
  transcript: [
    { kind: "text", text: "Reading the task file…" },
    { kind: "tool", name: "Edit", input: "{\"file_path\":\"src/app.ts\"}" },
    { kind: "result", text: "ok" },
  ],
  cost: {
    usd: 0.42,
    inputTokens: 12_000,
    outputTokens: 3_400,
    cacheReadTokens: 90_000,
    cacheCreationTokens: 5_000,
    numTurns: 17,
  },
  attempts: 2,
} as const;

describe("reportRequestSchema", () => {
  it("round-trips the full golden finalize body", () => {
    expect(reportRequestSchema.parse(GOLDEN_REPORT)).toEqual(GOLDEN_REPORT);
  });

  it("accepts the minimal body {ok} — a bare success/failure signal", () => {
    expect(reportRequestSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(reportRequestSchema.parse({ ok: false, error: "boom" })).toEqual({
      ok: false,
      error: "boom",
    });
  });

  it("REJECTS outcome values only the server may assign (error / skipped)", () => {
    expect(() => reportRequestSchema.parse({ ok: false, outcome: "error" })).toThrow();
    expect(() => reportRequestSchema.parse({ ok: true, outcome: "skipped" })).toThrow();
  });

  it("accepts every claimable outcome", () => {
    for (const outcome of REPORT_OUTCOMES) {
      expect(reportRequestSchema.parse({ ok: true, outcome }).outcome).toBe(outcome);
    }
  });

  it("strips unknown keys inside cost (tolerant reader at every nesting level)", () => {
    const parsed = costReportSchema.parse({ usd: 0.5, futureMetric: 1 });
    expect(parsed).toEqual({ usd: 0.5 });
  });

  it("rejects a transcript step with an unknown kind", () => {
    expect(() => transcriptStepSchema.parse({ kind: "thinking" })).toThrow();
  });

  it("rejects a negative durationMs and a fractional token count", () => {
    expect(() => reportRequestSchema.parse({ ok: true, durationMs: -1 })).toThrow();
    expect(() => costReportSchema.parse({ inputTokens: 1.5 })).toThrow();
  });
});

describe("reportResponseSchema", () => {
  it("round-trips the normal finalize ack", () => {
    expect(reportResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });
  it("round-trips the reconcile ack (ADR-001 T5)", () => {
    expect(reportResponseSchema.parse({ ok: true, reconciled: true })).toEqual({
      ok: true,
      reconciled: true,
    });
  });
});
