/**
 * D9: the extracted schedule pure core is EQUIVALENT to the production
 * `updateSchedule` adapter (ADR-009 决策 5 — the extraction must not change
 * any Phase 3 result). Every transition in the matrix runs through BOTH the
 * core and the real DB adapter, and the persisted row must match the core's
 * writes exactly. Plus the core's own boundary rules (noop / exhaustion).
 */
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { FakeClock, seedLoop } from "../testkit/index.js";
import { updateSchedule } from "./state-machine.js";
import {
  isScheduleNoOp,
  planScheduleTransition,
  REVISION_INT32_MAX,
  type ScheduleCoreState,
  type ScheduleTransitionPatch,
} from "./transition.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

const NOW = new Date("2026-08-31T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

/** Initial states: manual-only / active scheduled / paused scheduled, each in
 *  fresh and revised form. */
const STATES: Array<[string, ScheduleCoreState]> = [
  ["manual-only", { cron: null, timezone: "UTC", enabled: true, scheduleRevision: 0 }],
  ["active", { cron: "0 3 * * *", timezone: "UTC", enabled: true, scheduleRevision: 1 }],
  ["paused", { cron: "0 3 * * *", timezone: "UTC", enabled: false, scheduleRevision: 2 }],
  ["manual-paused", { cron: null, timezone: "Asia/Shanghai", enabled: false, scheduleRevision: 3 }],
];

const PATCHES: Array<[string, ScheduleTransitionPatch]> = [
  ["empty", {}],
  ["set-cron", { cron: "*/15 * * * *" }],
  ["same-cron", { cron: "0 3 * * *" }],
  ["clear-cron", { cron: null }],
  ["set-timezone", { timezone: "America/New_York" }],
  ["same-timezone", { timezone: "UTC" }],
  ["enable", { enabled: true }],
  ["disable", { enabled: false }],
  ["cron+tz", { cron: "30 4 * * 1", timezone: "America/New_York" }],
  ["full", { cron: null, timezone: "UTC", enabled: true }],
];

describe("D9: core ↔ adapter equivalence over the transition matrix", () => {
  for (const [stateName, state] of STATES) {
    for (const [patchName, patch] of PATCHES) {
      it(`${stateName} × ${patchName}`, async () => {
        const core = planScheduleTransition(state, patch, NOW_ISO);

        const h = await openMigratedDb();
        handles.push(h);
        const db: Db = h.db;
        await seedLoop(db, {
          id: "loop-x",
          cron: state.cron,
          timezone: state.timezone,
          enabled: state.enabled,
          scheduleRevision: state.scheduleRevision,
          scheduleActivatedAt: state.cron !== null && state.enabled ? "2026-08-01T00:00:00.000Z" : null,
          lastScheduledAt: state.cron !== null ? "2026-08-30T03:00:00.000Z" : null,
          updatedAt: "2026-08-01T00:00:00.000Z",
        });

        const result = await updateSchedule({ db, clock: new FakeClock(NOW) }, "loop-x", patch);

        if (core.kind === "noop") {
          expect(result).toMatchObject({ found: true, changed: false });
          const [row] = await db.select().from(loops).where(eq(loops.id, "loop-x"));
          // Zero writes: revision, activation, watermark, updatedAt untouched.
          expect([row.scheduleRevision, row.scheduleActivatedAt, row.lastScheduledAt, row.updatedAt]).toEqual([
            state.scheduleRevision,
            state.cron !== null && state.enabled ? "2026-08-01T00:00:00.000Z" : null,
            state.cron !== null ? "2026-08-30T03:00:00.000Z" : null,
            "2026-08-01T00:00:00.000Z",
          ]);
          return;
        }

        if (core.kind !== "changed") throw new Error("unexpected exhaustion below the ceiling");
        expect(result).toMatchObject({ found: true, changed: true });
        if (result.found && result.changed) {
          // The persisted row equals the core-computed writes, field by field.
          const row = result.loop;
          expect(row.scheduleRevision).toBe(core.writes.scheduleRevision);
          expect(row.scheduleActivatedAt).toBe(core.writes.scheduleActivatedAt);
          expect(row.lastScheduledAt).toBe(core.writes.lastScheduledAt);
          expect(row.updatedAt).toBe(core.writes.updatedAt);
          expect(row.cron).toBe(core.writes.cron !== undefined ? core.writes.cron : state.cron);
          expect(row.timezone).toBe(core.writes.timezone !== undefined ? core.writes.timezone : state.timezone);
          expect(row.enabled).toBe(core.writes.enabled !== undefined ? core.writes.enabled : state.enabled);
        }
      });
    }
  }
});

describe("schedule pure core boundary rules", () => {
  it("noop detection: empty patch and all-equal patch", () => {
    const state = STATES[1]![1];
    expect(isScheduleNoOp(state, {})).toBe(true);
    expect(isScheduleNoOp(state, { cron: "0 3 * * *", timezone: "UTC", enabled: true })).toBe(true);
    expect(isScheduleNoOp(state, { enabled: false })).toBe(false);
  });

  it("revision exhaustion → schedule_revision_exhausted with zero writes", () => {
    const atCeiling: ScheduleCoreState = { cron: null, timezone: "UTC", enabled: true, scheduleRevision: REVISION_INT32_MAX };
    expect(planScheduleTransition(atCeiling, { enabled: false }, NOW_ISO)).toEqual({
      kind: "schedule_revision_exhausted",
    });
    // …but a noop at the ceiling stays a noop
    expect(planScheduleTransition(atCeiling, {}, NOW_ISO)).toEqual({ kind: "noop" });
    // and one below the ceiling reaches exactly the ceiling
    const below = { ...atCeiling, scheduleRevision: REVISION_INT32_MAX - 1 };
    const plan = planScheduleTransition(below, { enabled: false }, NOW_ISO);
    if (plan.kind !== "changed") throw new Error("unreachable");
    expect(plan.writes.scheduleRevision).toBe(REVISION_INT32_MAX);
  });

  it("activation follows the FINAL enabled×cron combination; watermark always clears", () => {
    const cases: Array<[ScheduleCoreState, ScheduleTransitionPatch, string | null]> = [
      [{ cron: null, timezone: "UTC", enabled: true, scheduleRevision: 0 }, { cron: "0 9 * * *" }, NOW_ISO],
      [{ cron: "0 9 * * *", timezone: "UTC", enabled: true, scheduleRevision: 1 }, { enabled: false }, null],
      [{ cron: "0 9 * * *", timezone: "UTC", enabled: false, scheduleRevision: 2 }, { enabled: true }, NOW_ISO],
      [{ cron: "0 9 * * *", timezone: "UTC", enabled: true, scheduleRevision: 3 }, { cron: null }, null],
    ];
    for (const [state, patch, activation] of cases) {
      const plan = planScheduleTransition(state, patch, NOW_ISO);
      if (plan.kind !== "changed") throw new Error("unreachable");
      expect(plan.writes.scheduleActivatedAt).toBe(activation);
      expect(plan.writes.lastScheduledAt).toBeNull();
    }
  });
});
