/**
 * The shared bounded guard-retry (review SPEC-3, ADR-009 修订 2026-09-01):
 * every OCC-guarded write that observes ZERO rows (a competitor committed
 * between the snapshot the plan consumed and the write) rolls its
 * transaction back; the caller re-runs the WHOLE resolve+plan+write once on
 * fresh state; a second loss fails closed as a race-lost error (a retryable
 * 500 — never a partial commit).
 *
 * Generic over the guard-error type so each store keeps its own stable
 * error names (report.ts's ReportCasLostError predates this module and
 * keeps its own driver; lifecycle ops and the schedule state machine share
 * this one).
 */
export async function withGuardRetry<T>(
  fn: () => Promise<T>,
  isGuardLost: (err: unknown) => boolean,
  toRaceLost: (err: unknown) => Error,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isGuardLost(err)) throw err;
    try {
      return await fn();
    } catch (retryErr) {
      if (isGuardLost(retryErr)) throw toRaceLost(retryErr);
      throw retryErr;
    }
  }
}
