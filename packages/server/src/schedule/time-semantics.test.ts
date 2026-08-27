/**
 * Phase 3 Batch 1 — D group: Cron, timezone, and DST tests.
 *
 * Test suite verifies:
 *  - D1: Accept legal five-segment cron; normalize whitespace
 *  - D2: Reject macros, four/six/seven segments, illegal values, NUL, overlong
 *  - D3: Accept valid IANA timezones; reject invalid ones
 *  - D4: Same local time in different timezones produces different UTC times
 *  - D5: DST gap (spring forward) — skip non-existent time
 *  - D6: DST overlap (fall back) — only first occurrence, no duplicate
 */

import { describe, expect, test } from "vitest";

import { isOccurrence, latestOccurrence, nextOccurrence, ScheduleValidationError, validateSchedule } from "./time-semantics.js";

describe("D: Cron, timezone, and DST", () => {
  test("D1: accept legal five-segment cron and normalize whitespace", () => {
    // Standard cron expressions
    expect(validateSchedule("0 9 * * *", "UTC")).toEqual({
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(validateSchedule("30 14 * * 1-5", "UTC")).toEqual({
      cron: "30 14 * * 1-5",
      timezone: "UTC",
    });

    expect(validateSchedule("0 0 1 * *", "UTC")).toEqual({
      cron: "0 0 1 * *",
      timezone: "UTC",
    });

    // Whitespace normalization
    expect(validateSchedule("  0   9   *   *   *  ", "UTC")).toEqual({
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(validateSchedule("0\t9\t*\t*\t*", "UTC")).toEqual({
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    // Complex expressions
    expect(validateSchedule("*/15 * * * *", "UTC")).toEqual({
      cron: "*/15 * * * *",
      timezone: "UTC",
    });

    expect(validateSchedule("0 9-17 * * 1-5", "UTC")).toEqual({
      cron: "0 9-17 * * 1-5",
      timezone: "UTC",
    });
  });

  test("D2: reject macros, wrong segment counts, illegal values, NUL, overlong", () => {
    // Macros
    expect(() => validateSchedule("@daily", "UTC")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("@hourly", "UTC")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("@weekly", "UTC")).toThrow(ScheduleValidationError);

    // Wrong segment count
    expect(() => validateSchedule("0 9 * *", "UTC")).toThrow(ScheduleValidationError); // 4 segments
    expect(() => validateSchedule("0 0 9 * * *", "UTC")).toThrow(ScheduleValidationError); // 6 segments (with seconds)
    expect(() => validateSchedule("0 0 9 * * * 2026", "UTC")).toThrow(ScheduleValidationError); // 7 segments (with seconds and year)

    // Empty string
    expect(() => validateSchedule("", "UTC")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("   ", "UTC")).toThrow(ScheduleValidationError);

    // NUL character
    expect(() => validateSchedule("0 9 * * *\0", "UTC")).toThrow(ScheduleValidationError);

    // Overlong (> 255 characters)
    const longCron = "0 9 * * *" + " ".repeat(250);
    expect(() => validateSchedule(longCron, "UTC")).toThrow(ScheduleValidationError);

    // Illegal values (invalid cron syntax)
    expect(() => validateSchedule("60 9 * * *", "UTC")).toThrow(ScheduleValidationError); // minute 60
    expect(() => validateSchedule("0 24 * * *", "UTC")).toThrow(ScheduleValidationError); // hour 24
    expect(() => validateSchedule("0 9 32 * *", "UTC")).toThrow(ScheduleValidationError); // day 32
    expect(() => validateSchedule("0 9 * 13 *", "UTC")).toThrow(ScheduleValidationError); // month 13
    // Standard cron treats both 0 and 7 as Sunday.
    expect(validateSchedule("0 9 * * 7", "UTC")).toEqual({
      cron: "0 9 * * 7",
      timezone: "UTC",
    });
  });

  test("D3: accept valid IANA timezones, reject invalid", () => {
    // Valid timezones
    expect(validateSchedule("0 9 * * *", "UTC").timezone).toBe("UTC");
    expect(validateSchedule("0 9 * * *", "Asia/Shanghai").timezone).toBe("Asia/Shanghai");
    expect(validateSchedule("0 9 * * *", "America/New_York").timezone).toBe("America/New_York");
    expect(validateSchedule("0 9 * * *", "Europe/London").timezone).toBe("Europe/London");
    expect(validateSchedule("0 9 * * *", "Australia/Sydney").timezone).toBe("Australia/Sydney");

    // Whitespace normalization
    expect(validateSchedule("0 9 * * *", "  UTC  ").timezone).toBe("UTC");

    // Invalid timezones
    expect(() => validateSchedule("0 9 * * *", "Invalid/Timezone")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("0 9 * * *", "NotATimezone")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("0 9 * * *", "")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("0 9 * * *", "   ")).toThrow(ScheduleValidationError);
    expect(() => validateSchedule("0 9 * * *", "UTC\0")).toThrow(ScheduleValidationError);

    // Overlong
    const longTz = "A".repeat(260);
    expect(() => validateSchedule("0 9 * * *", longTz)).toThrow(ScheduleValidationError);
  });

  test("D4: same local time in different timezones produces different UTC times", () => {
    // 09:00 local time in different timezones
    const schedule = validateSchedule("0 9 * * *", "UTC");

    // Reference: 2026-08-25 08:00:00 UTC (before 09:00 UTC)
    const reference = new Date("2026-08-25T08:00:00.000Z");

    // UTC: next 09:00 is 2026-08-25 09:00:00 UTC
    const utcSchedule = { ...schedule, timezone: "UTC" };
    const utcNext = nextOccurrence(utcSchedule, reference);
    expect(utcNext).toEqual(new Date("2026-08-25T09:00:00.000Z"));

    // Shanghai (UTC+8): 09:00 local = 01:00 UTC
    // Reference is 2026-08-25 08:00 UTC = 2026-08-25 16:00 Shanghai
    // Next 09:00 Shanghai is 2026-08-26 09:00 Shanghai = 2026-08-26 01:00 UTC
    const shanghaiSchedule = { ...schedule, timezone: "Asia/Shanghai" };
    const shanghaiNext = nextOccurrence(shanghaiSchedule, reference);
    expect(shanghaiNext).toEqual(new Date("2026-08-26T01:00:00.000Z")); // Next day 09:00 Shanghai time

    // New York (UTC-4 in August, EDT): 09:00 local = 13:00 UTC
    const nySchedule = { ...schedule, timezone: "America/New_York" };
    const nyNext = nextOccurrence(nySchedule, reference);
    expect(nyNext).toEqual(new Date("2026-08-25T13:00:00.000Z")); // 09:00 New York time

    // All three are different UTC times
    expect(utcNext?.getTime()).not.toBe(shanghaiNext?.getTime());
    expect(utcNext?.getTime()).not.toBe(nyNext?.getTime());
    expect(shanghaiNext?.getTime()).not.toBe(nyNext?.getTime());
  });

  test("D5: DST gap (spring forward) — skip non-existent time", () => {
    // New York DST 2026: clocks spring forward at 2:00 AM on March 8, 2026
    // Time jumps from 01:59:59 EST to 03:00:00 EDT
    // A cron set for 02:30 should skip March 8 (time doesn't exist) and fire on March 9

    const schedule = validateSchedule("30 2 * * *", "America/New_York");

    // Reference: March 7, 2026, 10:00 PM EST (well before DST transition)
    // March 7, 22:00 EST = March 8, 03:00 UTC (EST is UTC-5)
    const reference = new Date("2026-03-08T03:00:00.000Z");

    const next = nextOccurrence(schedule, reference);

    expect(next).toBeDefined();
    expect(next).not.toBeNull();

    // Should skip March 8 (02:30 doesn't exist due to DST gap) and return March 9, 02:30 EDT
    // March 9, 02:30 EDT = March 9, 06:30 UTC (EDT is UTC-4)
    expect(next).toEqual(new Date("2026-03-09T06:30:00.000Z"));

    // Verify it's March 9
    expect(next?.getUTCDate()).toBe(9);
    expect(next?.getUTCMonth()).toBe(2); // March (0-indexed)
  });

  test("D5: DST gap skips invalid candidates from list and range hour fields", () => {
    const beforeGap = new Date("2026-03-08T03:00:00.000Z");

    const listSchedule = validateSchedule("30 2,4 * * *", "America/New_York");
    expect(nextOccurrence(listSchedule, beforeGap)).toEqual(new Date("2026-03-08T08:30:00.000Z"));

    const afterFirstRangeOccurrence = new Date("2026-03-08T06:31:00.000Z");
    const rangeSchedule = validateSchedule("30 1-2 * * *", "America/New_York");
    expect(nextOccurrence(rangeSchedule, afterFirstRangeOccurrence)).toEqual(new Date("2026-03-09T05:30:00.000Z"));
  });

  test("D6: DST overlap (fall back) — only first occurrence, no duplicate", () => {
    // New York DST 2026: clocks fall back at 2:00 AM on November 1, 2026
    // Time goes from 01:59:59 EDT back to 01:00:00 EST
    // A cron set for 01:30 should only fire once (first occurrence), not twice

    const schedule = validateSchedule("30 1 * * *", "America/New_York");

    // Reference: November 1, 2026, 00:30 EDT (before the overlap)
    const reference = new Date("2026-11-01T04:30:00.000Z"); // 00:30 EDT = 04:30 UTC

    const first = nextOccurrence(schedule, reference);

    // First occurrence: 01:30 EDT = 05:30 UTC
    expect(first).toEqual(new Date("2026-11-01T05:30:00.000Z"));

    // Now continue from after the first occurrence
    const afterFirst = new Date(first!.getTime() + 1);
    const second = nextOccurrence(schedule, afterFirst);

    // Second should be November 2, 01:30 EST = 06:30 UTC (not a duplicate of Nov 1)
    expect(second).toEqual(new Date("2026-11-02T06:30:00.000Z"));

    // Verify we didn't get a duplicate on November 1
    expect(second?.getUTCDate()).toBe(2);
    expect(second?.getUTCMonth()).toBe(10); // November (0-indexed)
  });

  test("D6: reference inside the repeated hour never returns a past or duplicate occurrence", () => {
    const insideSecondRepeatedHour = new Date("2026-11-01T06:15:00.000Z");

    const literal = validateSchedule("30 1 * * *", "America/New_York");
    expect(nextOccurrence(literal, insideSecondRepeatedHour)).toEqual(new Date("2026-11-02T06:30:00.000Z"));

    const wildcard = validateSchedule("* 1 * * *", "America/New_York");
    expect(nextOccurrence(wildcard, insideSecondRepeatedHour)).toEqual(new Date("2026-11-02T06:00:00.000Z"));

    // 02:00 EST is the first valid matching wall-clock time after the repeated
    // hour for this range and must not be skipped while recovering.
    const range = validateSchedule("0 1-2 * * *", "America/New_York");
    expect(nextOccurrence(range, insideSecondRepeatedHour)).toEqual(new Date("2026-11-01T07:00:00.000Z"));
  });
});

describe("latestOccurrence / isOccurrence (Batch 2 occurrence reconstruction)", () => {
  const daily10 = validateSchedule("0 10 * * *", "UTC");
  const minutely = validateSchedule("* * * * *", "UTC");

  test("reconstructs the exact occurrence from an on-time or slightly delayed firing", () => {
    // Firing exactly at the occurrence, 37s late, and 119s late (within lookback)
    expect(latestOccurrence(daily10, new Date("2026-08-27T10:00:00.000Z"))).toEqual(
      new Date("2026-08-27T10:00:00.000Z"),
    );
    expect(latestOccurrence(daily10, new Date("2026-08-27T10:00:37.000Z"))).toEqual(
      new Date("2026-08-27T10:00:00.000Z"),
    );
    expect(latestOccurrence(daily10, new Date("2026-08-27T10:01:59.000Z"))).toEqual(
      new Date("2026-08-27T10:00:00.000Z"),
    );
  });

  test("returns null when no occurrence lies inside the 2-minute lookback", () => {
    // 10:02:30 with a daily cron: the 10:00 occurrence fell out of the window
    expect(latestOccurrence(daily10, new Date("2026-08-27T10:02:30.000Z"))).toBeNull();
    // Before the first occurrence of the day entirely
    expect(latestOccurrence(daily10, new Date("2026-08-27T09:58:00.000Z"))).toBeNull();
  });

  test("dense schedules: returns the LATEST occurrence in the window, not the first", () => {
    // Regression pin: a minutely cron inside a 2-minute lookback has THREE
    // candidate occurrences; the reconstruction must be the newest one.
    expect(latestOccurrence(minutely, new Date("2026-08-27T10:01:30.000Z"))).toEqual(
      new Date("2026-08-27T10:01:00.000Z"),
    );
    expect(latestOccurrence(minutely, new Date("2026-08-27T10:01:00.000Z"))).toEqual(
      new Date("2026-08-27T10:01:00.000Z"),
    );
    expect(latestOccurrence(minutely, new Date("2026-08-27T10:01:59.999Z"))).toEqual(
      new Date("2026-08-27T10:01:00.000Z"),
    );
  });

  test("isOccurrence: exact occurrence true, off-by-one-second and wrong minute false", () => {
    expect(isOccurrence(daily10, new Date("2026-08-27T10:00:00.000Z"))).toBe(true);
    expect(isOccurrence(daily10, new Date("2026-08-27T10:00:01.000Z"))).toBe(false);
    expect(isOccurrence(daily10, new Date("2026-08-27T09:59:00.000Z"))).toBe(false);
    expect(isOccurrence(minutely, new Date("2026-08-27T10:01:00.000Z"))).toBe(true);
    expect(isOccurrence(minutely, new Date("2026-08-27T10:01:30.000Z"))).toBe(false);
  });

  test("isOccurrence honors the schedule timezone", () => {
    const shanghai10 = validateSchedule("0 10 * * *", "Asia/Shanghai");
    // 10:00 Asia/Shanghai = 02:00 UTC
    expect(isOccurrence(shanghai10, new Date("2026-08-27T02:00:00.000Z"))).toBe(true);
    expect(isOccurrence(shanghai10, new Date("2026-08-27T10:00:00.000Z"))).toBe(false);
  });
});
