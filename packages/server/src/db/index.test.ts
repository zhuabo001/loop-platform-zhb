import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, createDb, openMigratedDb, runMigrations, type DbHandle } from "./index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

async function migrated(dataDir?: string): Promise<DbHandle> {
  const h = await openMigratedDb(dataDir ? { dataDir } : {});
  handles.push(h);
  return h;
}

describe("runMigrations", () => {
  it("applies the committed SQL to a fresh in-memory pglite", async () => {
    const h = await migrated();
    const { rows } = await h.client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(rows.map((r) => r.tablename)).toEqual(["loops", "machines", "run_leases", "runs"]);
  });

  it("is idempotent — a second run is a no-op (the migrator tracks applied ids)", async () => {
    const h = await migrated();
    await expect(runMigrations(h)).resolves.toBeUndefined();
  });

  it("delivers the full index set, each with its pinned definition", async () => {
    const h = await migrated();
    const { rows } = await h.client.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname not like '%_pkey' order by indexname",
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    // Names AND column lists are pinned: a hand-edit of the committed SQL's
    // index definition must not slip through (db:check only guards
    // schema.ts↔snapshot, not snapshot↔committed-SQL).
    const expected: Record<string, string> = {
      loops_machine_idx: "USING btree (machine_id)",
      run_leases_loop_idx: "USING btree (loop_id)",
      run_leases_run_idx: "USING btree (run_id)",
      runs_loop_idx: "USING btree (loop_id)",
      runs_loop_ts_idx: "USING btree (loop_id, ts)",
      runs_pending_idx: "USING btree (machine_id)",
      runs_phase_idx: "USING btree (phase)",
    };
    expect([...byName.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, def] of Object.entries(expected)) {
      expect(byName.get(name), name).toContain(def);
    }
    // The hot claim path additionally carries its partial predicate: machine_id
    // leads (`WHERE machineId=? AND phase='pending'`) and pending-only rows keep
    // the index tiny.
    expect(byName.get("runs_pending_idx")).toContain("WHERE (phase = 'pending'::text)");
  });

  it("persists across close/reopen in the file-backed tier", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loopzhb-db-"));
    try {
      const first = await migrated(dir);
      await first.client.query("insert into machines (id, name, token_hash, created_at) values ('m-test', '', 'hash', '2026-07-27T00:00:00.000Z')");
      await closeDb(first);
      handles.splice(handles.indexOf(first), 1);

      const second = await migrated(dir);
      const { rows } = await second.client.query<{ id: string }>("select id from machines");
      expect(rows).toEqual([{ id: "m-test" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("createDb without migrate leaves the tables absent (migrate is explicit)", async () => {
    const h = await createDb();
    handles.push(h);
    await expect(h.client.query("select 1 from runs")).rejects.toThrow();
  });
});
