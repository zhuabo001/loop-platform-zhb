/**
 * AT9 — the Team attribution resolver (Phase 5 Batch 3 slice 3, ADR-011).
 *
 *  namespace from team:  a seeded machine with a teamId maps to that teamId
 *                        as the namespace — stable across calls and instances.
 *  key legality:         the team id passes NAMESPACE_ID_RE (it feeds the
 *                        BlobStore key directly).
 *  refusal — missing:    an unknown machine refuses with attribution_missing.
 *  refusal — unclaimed:  a machine with teamId IS NULL refuses the same way.
 *  refusal — bad id:     a teamId that fails NAMESPACE_ID_RE refuses the same way.
 *  zero writes:          resolve() reads only.
 */
import { asc } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import { seedMachine, TEST_TEAM_ID } from "../testkit/index.js";
import { createTeamAttributionResolver } from "./attribution-team.js";
import { NAMESPACE_ID_RE } from "./blob-store.js";

const MACHINE_ID = "m-0123456789abcdef";
// A valid team id that satisfies NAMESPACE_ID_RE (same `t-<hex16>` shape)
const TEAM_ID = TEST_TEAM_ID;

describe("AT9: createTeamAttributionResolver (real PGlite)", () => {
  let handle: DbHandle;
  let db: Db;

  afterEach(async () => {
    if (handle !== undefined) await closeDb(handle);
    handle = undefined as unknown as DbHandle;
  });

  async function fresh(): Promise<void> {
    handle = await openMigratedDb();
    db = handle.db;
  }

  it("maps a claimed machine to its team's namespace — stable across calls and instances", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID, { teamId: TEAM_ID });
    const resolver = createTeamAttributionResolver({ db });

    const first = await resolver.resolve({ machineId: MACHINE_ID });
    const second = await resolver.resolve({ machineId: MACHINE_ID });
    const third = await createTeamAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });

    expect(first).toEqual({ ok: true, namespaceId: TEAM_ID, machineId: MACHINE_ID });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("the team namespace passes NAMESPACE_ID_RE (it becomes a BlobStore key)", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID, { teamId: TEAM_ID });
    const result = await createTeamAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(NAMESPACE_ID_RE.test(result.namespaceId)).toBe(true);
  });

  it("an unknown machine refuses with attribution_missing", async () => {
    await fresh();
    const result = await createTeamAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result).toEqual({ ok: false, failure: "attribution_missing" });
  });

  it("a machine with teamId IS NULL (unclaimed) refuses with attribution_missing", async () => {
    await fresh();
    // seedMachine creates a row with no teamId (null) by default
    await seedMachine(db, MACHINE_ID);
    const result = await createTeamAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result).toEqual({ ok: false, failure: "attribution_missing" });
  });

  it("a teamId that fails NAMESPACE_ID_RE refuses with attribution_missing", async () => {
    await fresh();
    // Uppercase + underscore violate NAMESPACE_ID_RE
    const illegalTeamId = "T_ILLEGAL";
    await seedMachine(db, MACHINE_ID, { teamId: illegalTeamId });
    const result = await createTeamAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result).toEqual({ ok: false, failure: "attribution_missing" });
  });

  it("machineId is returned as-is (not the teamId) in the result", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID, { teamId: TEAM_ID });
    const result = await createTeamAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.machineId).toBe(MACHINE_ID);
      expect(result.namespaceId).toBe(TEAM_ID);
      expect(result.namespaceId).not.toBe(result.machineId);
    }
  });

  it("resolve writes NOTHING (the machines table is item-equal before/after)", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID, { teamId: TEAM_ID });
    const before = await db.select().from(machines).orderBy(asc(machines.id));
    const resolver = createTeamAttributionResolver({ db });
    await resolver.resolve({ machineId: MACHINE_ID });
    await resolver.resolve({ machineId: "m-ffffffffffffffff" }); // unknown machine
    const after = await db.select().from(machines).orderBy(asc(machines.id));
    expect(after).toEqual(before);
  });
});
