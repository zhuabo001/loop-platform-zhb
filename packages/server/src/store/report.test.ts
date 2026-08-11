/**
 * The report CAS-loss retry policy (Day 8–10 review fix — the sweep/report
 * race protocol). Single-connection PGlite serializes the read↔CAS window
 * away, so the REAL transaction can never lose its guard here; these tests
 * pin the bounded re-resolve driver with synthetic functions:
 *
 *  - first-attempt success passes through untouched;
 *  - ONE lost CAS re-runs the branch table exactly once (the retry sees the
 *    winner's committed state: sweep → reconcile, cancel/twin report → the
 *    coded 401, which must PROPAGATE — the report was consumed);
 *  - a second loss fails closed with ReportRaceLostError — a NON-401 500, so
 *    the daemon keeps the unconsumed report pending instead of dropping it
 *    on a terminal coded 401;
 *  - non-CAS errors never trigger a retry.
 *
 * The multi-connection interleaving itself is a Phase 6 proof (real
 * Postgres); what is pinned HERE is that the retry is bounded and never
 * converts an unconsumed report into a terminal 401.
 */
import { describe, expect, it, vi } from "vitest";

import { ReportRaceLostError, RunCapabilityInvalidError } from "../coordinator/errors.js";
import { ReportCasLostError, withReportCasRetry, type ReportTxResult } from "./report.js";

const OK: ReportTxResult = { ok: true };
const RECONCILED: ReportTxResult = { ok: true, reconciled: true };

describe("withReportCasRetry — the bounded re-resolve driver", () => {
  it("passes a first-attempt success through without retrying", async () => {
    const fn = vi.fn(async () => OK);
    await expect(withReportCasRetry(fn)).resolves.toBe(OK);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries EXACTLY once after a lost CAS — the sweep-won branch reconciles the original body", async () => {
    const fn = vi
      .fn<() => Promise<ReportTxResult>>()
      .mockRejectedValueOnce(new ReportCasLostError("run-1"))
      .mockResolvedValueOnce(RECONCILED);
    await expect(withReportCasRetry(fn)).resolves.toBe(RECONCILED);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a coded-401 denial on the retry PROPAGATES — the cancel/twin-report winner consumed the credential", async () => {
    const denied = new RunCapabilityInvalidError("consumed_or_revoked");
    const fn = vi
      .fn<() => Promise<ReportTxResult>>()
      .mockRejectedValueOnce(new ReportCasLostError("run-1"))
      .mockRejectedValueOnce(denied);
    await expect(withReportCasRetry(fn)).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a SECOND lost CAS fails closed with ReportRaceLostError (NON-401) and stops — never a third attempt", async () => {
    const fn = vi.fn<() => Promise<ReportTxResult>>().mockRejectedValue(new ReportCasLostError("run-1"));
    await expect(withReportCasRetry(fn)).rejects.toMatchObject({
      name: "ReportRaceLostError",
      runId: "run-1",
    });
    expect(fn).toHaveBeenCalledTimes(2); // initial + ONE retry — bounded
  });

  it("non-CAS errors propagate untouched and never trigger a retry", async () => {
    const denied = new RunCapabilityInvalidError("stale_phase");
    const fn = vi.fn<() => Promise<ReportTxResult>>().mockRejectedValue(denied);
    await expect(withReportCasRetry(fn)).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ReportRaceLostError is NOT a RunCapabilityInvalidError — the HTTP 500 it maps to keeps the daemon's pending report", () => {
    expect(new ReportRaceLostError("run-1")).not.toBeInstanceOf(RunCapabilityInvalidError);
  });
});
