/**
 * AH4/AH6 (unit half) — the artifact HTTP facade: existing-machine-only
 * authentication (never registering), the credential-free management path,
 * the machine-scoped read, and cross-machine refusal with zero writes.
 */
import { afterEach, describe, expect, it } from "vitest";

import { InvalidMachineCredentialError } from "../coordinator/errors.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import {
  FakeClock,
  seedLoop,
  seedMachineForToken,
  snapshotLoops,
  staticAttribution,
} from "../testkit/index.js";
import { createArtifactApi, type ArtifactApi } from "./api.js";
import { createMemoryBlobStore } from "./blob-store-memory.js";
import type { ArtifactHomeDeps } from "./sync.js";

const TOKEN = "dk_api_probe_token_1";

describe("artifact API facade", () => {
  const handles: DbHandle[] = [];
  let db: Db;
  let api: ArtifactApi;
  let machineId: string;

  afterEach(async () => {
    for (const handle of handles.splice(0)) await closeDb(handle);
  });

  async function fresh(options: { attributionMissing?: boolean } = {}): Promise<void> {
    const handle = await openMigratedDb();
    handles.push(handle);
    db = handle.db;
    machineId = await seedMachineForToken(db, TOKEN);
    const deps: ArtifactHomeDeps = {
      db,
      clock: new FakeClock(),
      ids: { syncId: () => "sync-1", manifestId: () => "amf-1" },
      blobStore: createMemoryBlobStore(),
      attribution: staticAttribution(options.attributionMissing ? {} : { [machineId]: "ns-1" }),
    };
    api = createArtifactApi(deps);
  }

  const emptyStream = async function* (): AsyncGenerator<Uint8Array> {};

  it("every machine method refuses an unknown token with the unified 401 and NEVER registers", async () => {
    await fresh();
    const before = await db.select().from(machines);
    const unknown = "dk_never_seen_token";
    const calls = [
      () => api.prepare(unknown, { requestId: "r", loopId: "l", configRevision: 0, baseManifestRevision: 0, entries: [] }),
      () => api.put(unknown, { syncId: "sync-x", hash: "a".repeat(64), bytes: emptyStream() }),
      () => api.commit(unknown, { syncId: "sync-x" }),
      () => api.readMachineLoop(unknown, "loop-1"),
      () =>
        api.reportSyncError(unknown, "loop-1", { failure: "timeout", configRevision: 0, baseManifestRevision: 0 }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(InvalidMachineCredentialError);
    }
    expect(await db.select().from(machines)).toEqual(before); // zero writes
  });

  it("updateConfig carries NO credential and reaches the config writer", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, workdir: "/home/dev/project" });
    const result = await api.updateConfig("loop-1", { artifactDir: "dist" }); // relative + workdir ⇒ legal
    expect(result).toMatchObject({ ok: true, outcome: "changed" });
    if (result.ok) expect(result.loop.artifactDir).toBe("dist");
    expect(await api.updateConfig("loop-ghost", { artifactDir: "/data" })).toEqual({
      ok: false,
      failure: "loop_not_found",
    });
  });

  it("readMachineLoop returns the four frozen fields for a configured loop", async () => {
    await fresh();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      artifactDir: "/data",
      artifactConfigRevision: 3,
      artifactManifestRevision: 7,
    });
    expect(await api.readMachineLoop(TOKEN, "loop-1")).toEqual({
      ok: true,
      response: { loopId: "loop-1", artifactDir: "/data", configRevision: 3, manifestRevision: 7 },
    });
  });

  it("readMachineLoop refuses unconfigured, unknown and cross-machine loops", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-plain", machineId });
    await seedLoop(db, { id: "loop-other", machineId: "m-other", artifactDir: "/x" });
    expect(await api.readMachineLoop(TOKEN, "loop-plain")).toEqual({ ok: false, failure: "artifact_dir_unconfigured" });
    expect(await api.readMachineLoop(TOKEN, "loop-ghost")).toEqual({ ok: false, failure: "loop_not_found" });
    expect(await api.readMachineLoop(TOKEN, "loop-other")).toEqual({ ok: false, failure: "loop_not_found" });
  });

  it("readMachineLoop reports missing attribution (403) before touching the loop", async () => {
    await fresh({ attributionMissing: true });
    await seedLoop(db, { id: "loop-1", machineId, artifactDir: "/data" });
    expect(await api.readMachineLoop(TOKEN, "loop-1")).toEqual({ ok: false, failure: "attribution_missing" });
  });

  it("cross-machine sync requests fail with ZERO writes and put/commit never pull the stream for them", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-other", machineId: "m-other", artifactDir: "/x" });
    const before = await snapshotLoops(db);

    expect(
      await api.prepare(TOKEN, { requestId: "r", loopId: "loop-other", configRevision: 0, baseManifestRevision: 0, entries: [] }),
    ).toEqual({ ok: false, failure: "loop_not_found" });
    expect(await api.commit(TOKEN, { syncId: "sync-x" })).toEqual({ ok: false, failure: "session_not_found" });

    let pulled = false;
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      pulled = true;
      yield new Uint8Array(1);
    };
    expect(await api.put(TOKEN, { syncId: "sync-x", hash: "a".repeat(64), bytes: stream() })).toEqual({
      ok: false,
      failure: "session_not_found",
    });
    expect(pulled).toBe(false); // the refused upload never touches the body
    expect(await snapshotLoops(db)).toEqual(before);
  });
});
