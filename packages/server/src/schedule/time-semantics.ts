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
 * be delayed by system load, event-loop stalls, or process suspension — the
 * reconstruction must succeed for ANY such delay (a fired callback is a live
 * occurrence that must never be silently dropped).
 *
 * Uses an exponential backward probe followed by a millisecond binary search
 * for the boundary where `nextOccurrence(cursor)` stops being ≤ atInclusive.
 * This has no arbitrary year cap and its cost is logarithmic in elapsed time,
 * independent of the number of intervening occurrences (important for dense
 * schedules separated by long gaps).
 *
 * DST handling mirrors nextOccurrence: gaps are skipped, overlaps use first occurrence.
 * Returns null only when Croner cannot find any earlier occurrence.
 *
 * @param schedule - Validated and normalized schedule configuration
 * @param atInclusive - Reference time (find the latest occurrence at or before this)
 * @returns Latest occurrence as an absolute Date, or null if no past occurrence exists
 */
export function latestOccurrence(schedule: NormalizedSchedule, atInclusive: Date): Date | null {
  const atMs = atInclusive.getTime();
  if (!Number.isFinite(atMs)) return null;

  // Cron expressions operate on four-digit calendar years. This is a domain
  // boundary, not a lookback duration: every representable schedule history
  // from year 0001 remains searchable.
  const earliest = new Date(0);
  earliest.setUTCFullYear(1, 0, 1);
  earliest.setUTCHours(0, 0, 0, 0);
  const earliestMs = earliest.getTime();

  let low = atMs;
  let windowMs = 120_000;
  while (true) {
    const startMs = Math.max(earliestMs, atMs - windowMs);
    const probeMs = Math.max(earliestMs, startMs - 1);
    const candidate = nextOccurrence(schedule, new Date(probeMs));
    if (candidate !== null && candidate.getTime() <= atMs) {
      low = probeMs;
      break;
    }
    if (startMs === earliestMs) return null;
    windowMs = Math.min(windowMs * 2, atMs - earliestMs);
  }

  // P(cursor) := nextOccurrence(cursor) <= atInclusive. P is true before the
  // latest occurrence and false at/after it, so its boundary identifies the
  // answer without enumerating dense intervening ticks.
  let high = atMs;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = nextOccurrence(schedule, new Date(middle));
    if (candidate !== null && candidate.getTime() <= atMs) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const latest = nextOccurrence(schedule, new Date(low));
  return latest !== null && latest.getTime() <= atMs ? latest : null;
}

/**
 * Checks whether a given instant IS a canonical occurrence of the schedule.
 *
 * The check runs through the same nextOccurrence machinery the Scheduler's
 * latestOccurrence uses to build `scheduledFor`, so a scheduler-produced
 * occurrence can never be rejected here. DST behavior is inherited: gap-normalized
 * instants are not occurrences; both instants of an ambiguous wall time match
 * (Croner fires both — the watermark, not this check, dedupes the overlap).
 *
 * @param schedule - Validated and normalized schedule configuration
 * @param at - Candidate instant
 * @returns True when `at` is exactly the next occurrence after `at - 1ms`
 */
export function isOccurrence(schedule: NormalizedSchedule, at: Date): boolean {
  const next = nextOccurrence(schedule, new Date(at.getTime() - 1));
  return next !== null && next.getTime() === at.getTime();
}

// ---- RFC 3339 / canonical-ISO persisted-state validation (Phase 3 Batch 3) ----

/**
 * Parses the exact RFC 3339 subset accepted at the scheduled-trigger edge.
 * Native Date.parse normalizes impossible dates (for example February 30),
 * which would let a non-existent spelling advance the occurrence watermark.
 * Offset forms (`+08:00`) ARE accepted here — canonicalization is the caller's
 * job (see isCanonicalUtcIso).
 */
export function parseRfc3339Ms(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second ||
    wallClock.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }

  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMs = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const timestamp = wallClock.getTime() - offsetMs;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * THE canonical UTC ISO 判定 (Batch 3 plan §2.2): round-trip equality with
 * `Date#toISOString()` — exactly three millisecond digits and a `Z` suffix.
 * `parseRfc3339Ms` alone is NOT a canonical check (it accepts `+08:00` and
 * 1–2-digit fractions); only the round trip pins the single spelling that
 * activation/watermark lexicographic comparisons rely on.
 */
export function isCanonicalUtcIso(value: string): boolean {
  const ms = parseRfc3339Ms(value);
  return ms !== undefined && new Date(ms).toISOString() === value;
}

/**
 * The persisted schedule-state slice the fail-closed rule inspects. Structural
 * on purpose: a Loop row satisfies it without this module depending on the DB
 * schema.
 */
export interface PersistedScheduleState {
  cron: string;
  timezone: string;
  scheduleRevision: number;
  scheduleActivatedAt: string | null;
  lastScheduledAt: string | null;
}

/**
 * THE fail-closed validity rule for an ACTIVE scheduled loop's persisted
 * schedule state (Batch 3 plan §2.1 step 2 + §2.2) — ONE implementation shared
 * by the scheduler's startup scan and the enqueue transaction so the rule
 * cannot drift between the two paths. A row failing this is CORRUPT: cron /
 * timezone unacceptable to the shared time-semantics module, a revision that
 * is not a non-negative safe integer, a missing or non-canonical activation,
 * or a non-null non-canonical watermark. Corrupt strings must never feed the
 * lexicographic occurrence comparisons or advance the watermark.
 */
export function isValidPersistedScheduleState(state: PersistedScheduleState): boolean {
  try {
    validateSchedule(state.cron, state.timezone);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(state.scheduleRevision) || state.scheduleRevision < 0) return false;
  if (state.scheduleActivatedAt === null || !isCanonicalUtcIso(state.scheduleActivatedAt)) return false;
  if (state.lastScheduledAt !== null && !isCanonicalUtcIso(state.lastScheduledAt)) return false;
  return true;
}
