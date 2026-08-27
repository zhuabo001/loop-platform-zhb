/**
 * Production Croner factory pinning test.
 *
 * The factory's fixed options are a CONTRACT (Batch 2 plan §2): five-part
 * parsing locked, timers unref'd, protect/catch forwarded. A regression here
 * (e.g. dropping `mode: "5-part"`) would silently change parsing semantics in
 * production only — the FakeCronFactory used everywhere else never sees these
 * options, so this test mocks the `croner` module itself.
 */

import { describe, expect, test, vi } from "vitest";

interface CronCtorCall {
  pattern: string;
  options: Record<string, unknown>;
  callback: () => void;
}

const ctorCalls: CronCtorCall[] = [];
const stopSpy = vi.fn();

vi.mock("croner", () => ({
  Cron: class {
    constructor(pattern: string, options: Record<string, unknown>, callback: () => void) {
      ctorCalls.push({ pattern, options, callback });
    }
    stop = stopSpy;
  },
}));

import { productionCronFactory } from "./croner-factory.js";

describe("productionCronFactory", () => {
  test("pins mode, unref, timezone, protect and catch on every job", () => {
    const protect = () => {};
    const catchFn = () => {};
    const callback = () => {};

    const job = productionCronFactory.create(
      "0 10 * * *",
      { timezone: "Asia/Shanghai", protect, catch: catchFn },
      callback,
    );

    expect(ctorCalls).toHaveLength(1);
    const call = ctorCalls[0]!;
    expect(call.pattern).toBe("0 10 * * *");
    expect(call.options).toEqual({
      timezone: "Asia/Shanghai",
      protect,
      catch: catchFn,
      mode: "5-part",
      unref: true,
    });
    expect(call.callback).toBe(callback);

    // stop() delegates to the Croner instance
    job.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
