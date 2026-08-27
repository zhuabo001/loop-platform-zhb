/**
 * Schedule time-semantics module — cron validation and next-occurrence calculation.
 *
 * This module provides deterministic time computation for Loop scheduling:
 *  - Standard five-segment cron expression validation
 *  - IANA timezone validation
 *  - Next occurrence calculation with explicit DST behavior
 *
 * Responsibilities:
 *  - Compute time only, no timers
 *  - No HTTP, database, or RunCoordinator access
 *  - Pure functions, deterministic output
 *
 * See ADR-007 for the complete time-semantics contract.
 */

import { Cron } from "croner";

/**
 * Normalized schedule configuration — validated cron expression and timezone.
 */
export interface NormalizedSchedule {
  /** Standard five-segment cron expression (minute hour day month weekday),
   *  normalized whitespace, no macros/seconds/year fields. */
  cron: string;
  /** Valid IANA timezone (e.g., 'UTC', 'Asia/Shanghai', 'America/New_York'). */
  timezone: string;
}

/**
 * Schedule validation error — thrown when cron or timezone is invalid.
 */
export class ScheduleValidationError extends Error {
  constructor(
    public field: "cron" | "timezone",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

/**
 * Maximum allowed length for cron expressions and timezones.
 */
const MAX_FIELD_LENGTH = 255;

/**
 * Croner recovery is only needed while traversing a timezone discontinuity.
 * Advancing at minute precision is sufficient for a five-part cron; this guard
 * prevents an upstream regression from turning the pure calculation into an
 * infinite loop.
 */
const MAX_DISCONTINUITY_RECOVERY_STEPS = 6_000;

/**
 * Validates and normalizes a cron expression and timezone.
 *
 * Validation rules:
 *  - cron: must be exactly five segments after normalization
 *  - cron: rejects macros (@daily, @hourly, etc.), seconds, year fields
 *  - cron: rejects empty string, NUL character, or > 255 characters
 *  - timezone: must be recognizable by the runtime (IANA timezone)
 *  - timezone: rejects empty string, NUL character, or > 255 characters
 *  - Whitespace is trimmed and normalized to single spaces between segments
 *
 * @param cron - Raw cron expression
 * @param timezone - Raw timezone string
 * @returns Normalized schedule configuration
 * @throws ScheduleValidationError if validation fails
 */
export function validateSchedule(cron: string, timezone: string): NormalizedSchedule {
  // Validate and normalize cron
  if (typeof cron !== "string") {
    throw new ScheduleValidationError("cron", "cron must be a string");
  }

  if (cron.includes("\0")) {
    throw new ScheduleValidationError("cron", "cron must not contain NUL character");
  }

  if (cron.length > MAX_FIELD_LENGTH) {
    throw new ScheduleValidationError("cron", `cron must not exceed ${MAX_FIELD_LENGTH} characters`);
  }

  // Trim and normalize whitespace
  const normalizedCron = cron.trim().replace(/\s+/g, " ");

  if (normalizedCron === "") {
    throw new ScheduleValidationError("cron", "cron must not be empty");
  }

  // Check for macros (start with @)
  if (normalizedCron.startsWith("@")) {
    throw new ScheduleValidationError("cron", "cron macros are not supported (use standard five-segment format)");
  }

  // Count segments
  const segments = normalizedCron.split(" ");
  if (segments.length !== 5) {
    throw new ScheduleValidationError(
      "cron",
      `cron must have exactly 5 segments (minute hour day month weekday), got ${segments.length}`,
    );
  }

  // Additional validation for specific values
  const [minute, hour, day, month] = segments;

  // Basic range checks for literal values (not ranges or wildcards)
  const checkRange = (value: string, min: number, max: number, fieldName: string) => {
    // Skip if it's a wildcard, range, list, or step
    if (value === "*" || value.includes("-") || value.includes(",") || value.includes("/")) {
      return;
    }
    const num = Number.parseInt(value, 10);
    if (!Number.isNaN(num) && (num < min || num > max)) {
      throw new ScheduleValidationError("cron", `${fieldName} value ${num} is out of range [${min}-${max}]`);
    }
  };

  checkRange(minute, 0, 59, "minute");
  checkRange(hour, 0, 23, "hour");
  checkRange(day, 1, 31, "day");
  checkRange(month, 1, 12, "month");

  // Validate cron expression by attempting to parse it
  try {
    // Use Croner to validate the expression (will throw if invalid)
    // We use UTC here just for validation; actual timezone is applied in nextOccurrence
    new Cron(normalizedCron, { timezone: "UTC", mode: "5-part" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ScheduleValidationError("cron", `invalid cron expression: ${message}`);
  }

  // Validate and normalize timezone
  if (typeof timezone !== "string") {
    throw new ScheduleValidationError("timezone", "timezone must be a string");
  }

  if (timezone.includes("\0")) {
    throw new ScheduleValidationError("timezone", "timezone must not contain NUL character");
  }

  if (timezone.length > MAX_FIELD_LENGTH) {
    throw new ScheduleValidationError("timezone", `timezone must not exceed ${MAX_FIELD_LENGTH} characters`);
  }

  const normalizedTimezone = timezone.trim();

  if (normalizedTimezone === "") {
    throw new ScheduleValidationError("timezone", "timezone must not be empty");
  }

  // Validate timezone by attempting to create a Cron instance with it
  try {
    // Croner will throw if the timezone is not recognized by the runtime
    new Cron("0 0 * * *", { timezone: normalizedTimezone, mode: "5-part" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ScheduleValidationError("timezone", `invalid or unrecognized timezone: ${message}`);
  }

  // Additional validation: use Intl.DateTimeFormat to double-check timezone validity
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedTimezone });
  } catch (err) {
    throw new ScheduleValidationError("timezone", `invalid or unrecognized timezone: ${normalizedTimezone}`);
  }

  return {
    cron: normalizedCron,
    timezone: normalizedTimezone,
  };
}

/**
 * Calculates the next occurrence of a schedule after a given reference time.
 *
 * DST behavior:
 *  - DST gap (spring forward, non-existent time): skips to the next valid occurrence
 *  - DST overlap (fall back, repeated time): uses only the first occurrence
 *
 * @param schedule - Validated and normalized schedule configuration
 * @param afterExclusive - Reference time (next occurrence must be strictly after this)
 * @returns Next occurrence as an absolute Date, or null if no future occurrence
 */
export function nextOccurrence(schedule: NormalizedSchedule, afterExclusive: Date): Date | null {
  // Create Cron instance with the schedule's timezone
  const cron = new Cron(schedule.cron, {
    timezone: schedule.timezone,
    mode: "5-part",
  });

  let cursor = afterExclusive;

  for (let step = 0; step < MAX_DISCONTINUITY_RECOVERY_STEPS; step += 1) {
    const candidate = cron.nextRun(cursor);
    if (candidate === null) return null;

    if (candidate.getTime() <= cursor.getTime()) {
      // During a DST overlap Croner may resolve a wall-clock match to its first
      // occurrence even when the cursor is already inside the second occurrence.
      // Move toward the end of the ambiguous minute without stepping over a
      // valid occurrence at the first minute after the overlap.
      cursor = advanceWithinFivePartMinute(cursor);
      continue;
    }

    // During a DST gap Croner can normalize a non-existent wall-clock time to
    // a later instant. Matching the candidate back in the target timezone
    // rejects it for literals, lists, ranges and steps alike.
    if (!cron.match(candidate)) {
      cursor = candidate;
      continue;
    }

    return candidate;
  }

  throw new Error("Croner could not advance beyond a timezone discontinuity");
}

function advanceWithinFivePartMinute(cursor: Date): Date {
  const minuteEnd = Math.floor(cursor.getTime() / 60_000) * 60_000 + 59_999;
  return new Date(minuteEnd > cursor.getTime() ? minuteEnd : cursor.getTime() + 1);
}

/**
 * Calculates the latest (most recent) occurrence at or before a given time.
 *
 * This function is used by the Scheduler to reconstruct the canonical occurrence
 * timestamp when a Croner callback fires. The callback's actual firing time may
 * be slightly after the scheduled minute due to system load or execution delay.
 *
 * Algorithm:
 *  1. Use Croner's nextRun to find the occurrence that would fire after (atInclusive - 1 minute)
 *  2. If that occurrence is at or before atInclusive, it's the latest occurrence
 *  3. Otherwise, no valid occurrence exists at or before atInclusive
 *
 * DST handling mirrors nextOccurrence: gaps are skipped, overlaps use first occurrence.
 *
 * @param schedule - Validated and normalized schedule configuration
 * @param atInclusive - Reference time (find the latest occurrence at or before this)
 * @returns Latest occurrence as an absolute Date, or null if no past occurrence exists
 */
export function latestOccurrence(schedule: NormalizedSchedule, atInclusive: Date): Date | null {
  // Look back one minute to find the occurrence that would fire at or before atInclusive
  const lookbackStart = new Date(atInclusive.getTime() - 60_000);

  const candidate = nextOccurrence(schedule, lookbackStart);

  if (candidate === null) return null;

  // Check if the candidate is at or before our reference time
  if (candidate.getTime() <= atInclusive.getTime()) {
    return candidate;
  }

  // Candidate is after atInclusive, no valid occurrence exists
  return null;
}

