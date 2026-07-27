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

  it("delivers the ADR-001 partial claim index (pending-only, on machine)", async () => {
    const h = await migrated();
    const { rows } = await h.client.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'runs_pending_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("USING btree (machine_id)");
    expect(rows[0]!.indexdef).toContain("WHERE (phase = 'pending'::text)");
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
