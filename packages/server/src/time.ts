/** The clock seam. EVERY lifecycle timestamp write (run transitions, lease
 *  expiry, machine heartbeat) must read time through an injected Clock — never
 *  `new Date()`/`Date.now()` directly — so tests drive time with a FakeClock
 *  and production uses `systemClock`. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
