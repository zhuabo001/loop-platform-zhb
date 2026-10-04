/**
 * AT8 — the Machine attribution resolver (Batch 2 slice 1, ADR-010 决策 7/15).
 *
 *  stable mapping:    a seeded machine maps to ITS OWN machineId namespace,
 *                     identical across calls and resolver instances.
 *  key legality:      the derived namespace passes NAMESPACE_ID_RE (it feeds
 *                     the BlobStore key directly).
 *  refusal:           an unknown machine AND a row whose id cannot form a
 *                     legal storage key both refuse with attribution_missing
 *                     (403) — never a raw key, never an exception.
 *  zero writes:       resolve() reads only.
 */
import { asc } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import { seedMachine } from "../testkit/index.js";
import { createMachineAttributionResolver } from "./attribution-machine.js";
import { NAMESPACE_ID_RE } from "./blob-store.js";

const MACHINE_ID = "m-0123456789abcdef";

describe("AT8: createMachineAttributionResolver (real PGlite)", () => {
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

  it("maps a seeded machine to its own machineId namespace — stable across calls and instances", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const resolver = createMachineAttributionResolver({ db });

    const first = await resolver.resolve({ machineId: MACHINE_ID });
    const second = await resolver.resolve({ machineId: MACHINE_ID });
    const third = await createMachineAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });

    expect(first).toEqual({ ok: true, namespaceId: MACHINE_ID, machineId: MACHINE_ID });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("the derived namespace passes NAMESPACE_ID_RE (it becomes a BlobStore key)", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const result = await createMachineAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(NAMESPACE_ID_RE.test(result.namespaceId)).toBe(true);
  });

  it("an unknown machine refuses with attribution_missing (no default namespace)", async () => {
    await fresh();
    const result = await createMachineAttributionResolver({ db }).resolve({ machineId: MACHINE_ID });
    expect(result).toEqual({ ok: false, failure: "attribution_missing" });
  });

  it("a row whose id cannot form a legal storage key refuses the SAME way", async () => {
    await fresh();
    // Uppercase + underscore violate NAMESPACE_ID_RE; without the guard this
    // id would only fail later as a BlobStore `invalid_key` invariant.
    const illegalId = "M_ILLEGAL";
    await seedMachine(db, illegalId);
    const result = await createMachineAttributionResolver({ db }).resolve({ machineId: illegalId });
    expect(result).toEqual({ ok: false, failure: "attribution_missing" });
  });

  it("resolve writes NOTHING (the machines table is item-equal before/after)", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const before = await db.select().from(machines).orderBy(asc(machines.id));
    const resolver = createMachineAttributionResolver({ db });
    await resolver.resolve({ machineId: MACHINE_ID });
    await resolver.resolve({ machineId: "m-ffffffffffffffff" });
    const after = await db.select().from(machines).orderBy(asc(machines.id));
    expect(after).toEqual(before);
  });
});
