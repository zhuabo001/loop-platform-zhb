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
  seedClaimedMachineForToken,
  snapshotLoops,
  staticAttribution,
} from "../testkit/index.js";
import { createArtifactApi, type ArtifactApi } from "./api.js";
import { createMachineAttributionResolver } from "./attribution-machine.js";
import { createMemoryBlobStore } from "./blob-store-memory.js";
import type { ArtifactHomeDeps } from "./sync.js";

const TOKEN = "dk_api_probe_token_1";

/**
 * Poison the Nth top-level `select()` on a Db; every other query still runs
 * against the real PGlite handle. The machineRead flow reads exactly three
 * times — credential, attribution, loop — so `at` names the failing stage
 * (#85's fault injection).
 */
function faultingSelect(db: Db, at: number, cause: unknown): Db {
  let n = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "select") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (...args: unknown[]) => {
        n += 1;
        if (n === at) throw cause;
        return (target.select as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Db;
}

const recoverable = (message: string) => Object.assign(new Error(message), { code: "08006" });

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
    machineId = await seedClaimedMachineForToken(db, TOKEN);
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

  /** A facade over a db whose Nth read is poisoned. The attribution resolver
   *  is the PRODUCTION one (it reads the machines row), so the attribution
   *  stage has a real query to fail. */
  function apiOver(at: number, cause: unknown): ArtifactApi {
    const faulted = faultingSelect(db, at, cause);
    return createArtifactApi({
      db: faulted,
      clock: new FakeClock(),
      ids: { syncId: () => "sync-1", manifestId: () => "amf-1" },
      blobStore: createMemoryBlobStore(),
      attribution: createMachineAttributionResolver({ db: faulted }),
    });
  }

  it("a recoverable storage fault in the SHARED credential read becomes storage_error on all five machine methods (#85)", async () => {
    await fresh();
    const cause = recoverable("injected credential-read failure");
    // One facade per call: the poison targets the operation's FIRST read, so
    // every method must be exercised through its own armed counter.
    let pulled = false;
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      pulled = true;
      yield new Uint8Array(1);
    };
    expect(await apiOver(1, cause).readMachineLoop(TOKEN, "loop-1")).toEqual({ ok: false, failure: "storage_error", cause });
    expect(
      await apiOver(1, cause).prepare(TOKEN, {
        requestId: "r",
        loopId: "loop-1",
        configRevision: 0,
        baseManifestRevision: 0,
        entries: [],
      }),
    ).toEqual({ ok: false, failure: "storage_error", cause });
    expect(await apiOver(1, cause).put(TOKEN, { syncId: "sync-x", hash: "a".repeat(64), bytes: stream() })).toEqual({
      ok: false,
      failure: "storage_error",
      cause,
    });
    expect(await apiOver(1, cause).commit(TOKEN, { syncId: "sync-x" })).toEqual({
      ok: false,
      failure: "storage_error",
      cause,
    });
    expect(
      await apiOver(1, cause).reportSyncError(TOKEN, "loop-1", {
        failure: "timeout",
        configRevision: 0,
        baseManifestRevision: 0,
      }),
    ).toEqual({ ok: false, failure: "storage_error", cause });
    expect(pulled).toBe(false); // refused before the upload stream is ever touched
  });

  it("machineRead classifies a fault at EVERY read stage — credential, attribution, loop (#85)", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, artifactDir: "/data", artifactConfigRevision: 1 });
    for (const at of [1, 2, 3]) {
      const cause = recoverable(`injected read-${at} failure`);
      expect(await apiOver(at, cause).readMachineLoop(TOKEN, "loop-1")).toEqual({
        ok: false,
        failure: "storage_error",
        cause,
      });
    }
    // Exactly three reads make up the flow: a poison aimed past them never
    // fires and the SAME flow succeeds.
    expect(await apiOver(4, recoverable("unreachable")).readMachineLoop(TOKEN, "loop-1")).toMatchObject({ ok: true });
    // The classifier walks the cause chain: a WRAPPED recoverable fault
    // (the driver's shape) is classified with the wrapper as the cause.
    const wrapped = new Error("wrapped driver failure", { cause: recoverable("inner") });
    expect(await apiOver(1, wrapped).readMachineLoop(TOKEN, "loop-1")).toEqual({
      ok: false,
      failure: "storage_error",
      cause: wrapped,
    });
  });

  it("uncoded and constraint-class faults keep the raw-throw boundary (#85)", async () => {
    await fresh();
    const uncoded = new Error("plain driver defect");
    await expect(apiOver(1, uncoded).readMachineLoop(TOKEN, "loop-1")).rejects.toBe(uncoded);
    const constraint = Object.assign(new Error("unique violation"), { code: "23505" });
    await expect(
      apiOver(1, constraint).prepare(TOKEN, {
        requestId: "r",
        loopId: "loop-1",
        configRevision: 0,
        baseManifestRevision: 0,
        entries: [],
      }),
    ).rejects.toBe(constraint);
  });
});
