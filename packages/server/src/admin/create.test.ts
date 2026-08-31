/**
 * Loop creation (goal §2/§6.2–6.3): the admin module validates caps (server
 * policy) BEFORE the machine lookup BEFORE the single INSERT — every failure
 * branch is zero-write. Success pins the Phase-1 fixed defaults, injected
 * clock/id, and the exact wire nullability (validated through the protocol
 * response schema, not hand-asserted).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createLoopResponseSchema } from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { FakeClock, seedMachine, snapshotLoops, snapshotRuns } from "../testkit/index.js";
import { LoopValidationError } from "./errors.js";
import { createLoopAdmin, LOOP_NAME_CAP, LOOP_PATH_CAP, type LoopAdmin } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let admin: LoopAdmin;

async function seeded(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  let n = 0;
  admin = createLoopAdmin({ db, clock, newLoopId: () => `loop-${++n}` });
  await seedMachine(db, "m-0123456789abcdef");
}

describe("createLoop", () => {
  it("creates a loop with Phase-1 fixed defaults, injected id and clock stamps — and NO run", async () => {
    await seeded();
    const result = await admin.createLoop({
      machineId: "m-0123456789abcdef",
      name: "react-doctor",
      workdir: "/home/dev/project",
      taskFile: "/home/dev/project/loops/react-doctor/README.md",
    });

    expect(result.created).toBe(true);
    if (!result.created) return;
    // The success body must validate against the WIRE schema (goal §6.1) —
    // explicit nulls, no omitted keys.
    expect(() => createLoopResponseSchema.parse({ loop: result.loop })).not.toThrow();
    expect(result.loop).toEqual({
      id: "loop-1",
      machineId: "m-0123456789abcdef",
      name: "react-doctor",
      workdir: "/home/dev/project",
      taskFile: "/home/dev/project/loops/react-doctor/README.md",
      agent: "claude-code",
      allowControl: true,
      enabled: true,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
      lastRun: null,
      cron: null,
      timezone: "UTC",
      nextFireAt: null,
      // Phase 4 fields stay absent while dormant.
    });

    const rows = await snapshotLoops(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "loop-1",
      machineId: "m-0123456789abcdef",
      agent: "claude-code",
      allowControl: true,
      enabled: true,
      workflow: null,
      model: null,
      state: null,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    // Creation NEVER enqueues (goal: 创建与触发分离).
    expect(await snapshotRuns(db)).toEqual([]);
  });

  it("defaults omitted optional fields to null", async () => {
    await seeded();
    const result = await admin.createLoop({ machineId: "m-0123456789abcdef" });
    expect(result.created).toBe(true);
    if (!result.created) return;
    expect(result.loop).toMatchObject({ name: null, workdir: null, taskFile: null, lastRun: null });
  });

  it("returns machine_not_found with zero writes for an unregistered (well-shaped) machine", async () => {
    await seeded();
    const result = await admin.createLoop({ machineId: "m-ffffffffffffffff" });
    expect(result).toEqual({ created: false, reason: "machine_not_found" });
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("accepts fields exactly AT the caps and rejects one char beyond, zero writes on rejection", async () => {
    await seeded();
    const atName = await admin.createLoop({
      machineId: "m-0123456789abcdef",
      name: "n".repeat(LOOP_NAME_CAP),
      workdir: "/".repeat(LOOP_PATH_CAP),
      taskFile: "t".repeat(LOOP_PATH_CAP),
    });
    expect(atName.created).toBe(true);

    for (const field of ["name", "workdir", "taskFile"] as const) {
      const cap = field === "name" ? LOOP_NAME_CAP : LOOP_PATH_CAP;
      await expect(
        admin.createLoop({ machineId: "m-0123456789abcdef", [field]: "x".repeat(cap + 1) }),
      ).rejects.toBeInstanceOf(LoopValidationError);
    }
    // Only the at-cap loop exists.
    expect(await snapshotLoops(db)).toHaveLength(1);
  });

  it("checks caps BEFORE the machine lookup — an invalid body is a 400 even for an unknown machine", async () => {
    await seeded();
    await expect(
      admin.createLoop({ machineId: "m-ffffffffffffffff", name: "n".repeat(LOOP_NAME_CAP + 1) }),
    ).rejects.toBeInstanceOf(LoopValidationError);
    expect(await snapshotLoops(db)).toEqual([]);
  });
});
