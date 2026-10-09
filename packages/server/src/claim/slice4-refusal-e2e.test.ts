/**
 * LM3–LM10 (the refusal matrix): every way the offline claim can say no, and
 * the proof that saying no costs nothing.
 *
 * Two invariants run through the whole file:
 *  - ZERO BUSINESS WRITES. Every refusal is compared against the 11-table
 *    oracle on a POPULATED world (issue #123's lesson: an empty world proves
 *    nothing);
 *  - ALL-OR-NOTHING. One bad machine refuses the whole selection — "claim what
 *    you can" is exactly the partially-claimed state the batch forbids.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalBlobStore } from "../artifact/blob-store-local.js";
import type { BlobStore } from "../artifact/blob-store.js";
import { artifactBlobs, artifactManifests, loops, machines, runs } from "../db/schema.js";
import { closeDb, openMigratedDb, type DbHandle } from "../db/index.js";
import { bootstrapServer, type BootedServer } from "../start.js";
import {
  makeArtifactBlob,
  makeTestAuthConfig,
  plantRawBlobFile,
  seedLoop,
  seedMachineForToken,
  seedRun,
  seedTeam,
  seedUser,
  unlinkArtifactBlobFile,
} from "../testkit/index.js";
import {
  CLAIM_TOKEN_A,
  CLAIM_TOKEN_B,
  CLAIM_USER_ID,
  claimBlobRoot,
  claimWorldSnapshot,
  failingStore,
  makeClaimDataDir,
  runClaimForTest,
  seedClaimBase,
  seedClaimHistory,
} from "../testkit/claim-fixtures.js";

const dirs: string[] = [];
const handles: DbHandle[] = [];
const servers: BootedServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await closeDb(server.handle).catch(() => {});
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function openDb(dataDir: string): Promise<DbHandle> {
  const handle = await openMigratedDb({ dataDir });
  handles.push(handle);
  return handle;
}

function storeOf(dataDir: string): BlobStore {
  return createLocalBlobStore({ rootDir: claimBlobRoot(dataDir) });
}

async function newDir(): Promise<string> {
  const dir = await makeClaimDataDir();
  dirs.push(dir);
  return dir;
}

/** A closed, populated world with one unclaimed machine and its real history. */
async function seedClosedWorld(tokens: readonly string[] = [CLAIM_TOKEN_A]) {
  const dataDir = await newDir();
  const handle = await openDb(dataDir);
  const base = await seedClaimBase(handle.db, tokens);
  const store = storeOf(dataDir);
  const histories = [];
  for (const [index, machineId] of base.machineIds.entries()) {
    // DISTINCT content per machine: the refusal tests need blobs they can
    // attribute to one machine (the shared-hash case is a happy-path test).
    histories.push(
      await seedClaimHistory(
        handle.db,
        store,
        machineId,
        index === 0 ? undefined : `loop-1-${index}`,
        index === 0 ? undefined : ["delta", "epsilon", "zeta"],
      ),
    );
  }
  return { dataDir, base, db: handle.db, store, histories };
}

describe("slice 4 refusals: target and machine (LM3/LM4)", () => {
  it("LM3: an unknown GitHub user id refuses and writes nothing", async () => {
    const dataDir = await newDir();
    const handle = await openDb(dataDir);
    const base = await seedClaimBase(handle.db, [CLAIM_TOKEN_A]);
    await seedClaimHistory(handle.db, storeOf(dataDir), base.machineIds[0]!);
    const before = await claimWorldSnapshot(handle.db);
    await closeDb(handles.pop()!);

    // A DIFFERENT GitHub id from the one that logged in: this command never
    // creates an account.
    const result = await runClaimForTest(dataDir, base.machineIds, [], {}, "999999");

    expect(result.code).toBe(1);
    expect(result.err).toContain("target_user_missing");
    expect(existsSync(path.join(claimBlobRoot(dataDir), base.teamId))).toBe(false);
    expect(await claimWorldSnapshot((await openDb(dataDir)).db)).toEqual(before);
  });

  it("LM3: a user without a personal team refuses, and a team without its membership refuses", async () => {
    for (const mode of ["no-team", "no-membership"] as const) {
      const dataDir = await newDir();
      const handle = await openDb(dataDir);
      await seedUser(handle.db, { id: CLAIM_USER_ID });
      const machineId = await seedMachineForToken(handle.db, CLAIM_TOKEN_A);
      await seedLoop(handle.db, { id: "loop-1", machineId });
      if (mode === "no-membership") await seedTeam(handle.db, { ownerUserId: CLAIM_USER_ID });
      const before = await claimWorldSnapshot(handle.db);
      await closeDb(handles.pop()!);

      const result = await runClaimForTest(dataDir, [machineId]);

      expect(result.code).toBe(1);
      expect(result.err).toContain(mode === "no-team" ? "target_team_missing" : "target_membership_missing");
      expect(await claimWorldSnapshot((await openDb(dataDir)).db)).toEqual(before);
    }
  });

  it("LM4: an unknown machine id and a revoked machine both refuse", async () => {
    const world = await seedClosedWorld();
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const unknown = await runClaimForTest(world.dataDir, ["m-does-not-exist"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("machine_missing");

    // Revoke the real machine and retry.
    const handle = await openDb(world.dataDir);
    await handle.db
      .update(machines)
      .set({ revokedAt: "2026-10-10T00:00:00.000Z" })
      .where(eq(machines.id, world.base.machineIds[0]!));
    await closeDb(handles.pop()!);

    const revoked = await runClaimForTest(world.dataDir, world.base.machineIds);
    expect(revoked.code).toBe(1);
    expect(revoked.err).toContain("machine_revoked");

    const after = await openDb(world.dataDir);
    const state = await claimWorldSnapshot(after.db);
    expect(state.machines).toHaveLength(1); // only the revocation edit
    expect(state.machines[0]!.teamId).toBeNull();
    expect(before.artifactManifests).toEqual(state.artifactManifests);
  });
});

describe("slice 4 refusals: selection and lock (LM5/LM6)", () => {
  it("LM5: one machine owned by another team refuses the WHOLE selection", async () => {
    const world = await seedClosedWorld([CLAIM_TOKEN_A, CLAIM_TOKEN_B]);
    const [machineA, machineB] = world.base.machineIds as [string, string];
    // A different team already owns machine B.
    await seedUser(world.db, { id: "999999" });
    const otherTeamId = await seedTeam(world.db, { ownerUserId: "999999" });
    await world.db.update(machines).set({ teamId: otherTeamId }).where(eq(machines.id, machineB));
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, [machineA, machineB]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("machine_owned_by_other_team");
    const after = await openDb(world.dataDir);
    expect((await after.db.select().from(machines).where(eq(machines.id, machineA)))[0]!.teamId).toBeNull();
    expect(await claimWorldSnapshot(after.db)).toEqual(before);
  });

  it("LM5: a repeated --machine-id is an invalid invocation", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, [machineId, machineId]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("repeated");
  });

  it("LM6: a RUNNING server refuses the claim before the database is opened; stopping it unblocks", async () => {
    const world = await seedClosedWorld();
    await closeDb(handles.pop()!);

    const server = await bootstrapServer({ auth: makeTestAuthConfig(), host: "127.0.0.1", port: 3000, dataDir: world.dataDir });
    servers.push(server);

    const refused = await runClaimForTest(world.dataDir, world.base.machineIds);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("data directory is locked");
    expect(refused.err).toContain(path.join(world.dataDir, "data-dir.lock"));
    expect(refused.err).toContain(`rm ${path.join(world.dataDir, "data-dir.lock")}`);
    // A missing trailing newline mangles the shell prompt that follows; the
    // real-process smoke run is what caught it.
    expect(refused.err.endsWith("\n")).toBe(true);
    expect((await server.handle.db.select().from(machines))[0]!.teamId).toBeNull();

    // Stop the server: the very same command now succeeds.
    await closeDb(servers.pop()!.handle);
    const allowed = await runClaimForTest(world.dataDir, world.base.machineIds);
    expect(allowed.err).toBe("");
    expect(allowed.code).toBe(0);
  });
});

describe("slice 4 refusals: active runs (LM7)", () => {
  it("LM7: a running Run refuses; a pending Run only warns", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    await seedRun(world.db, { id: "run-pending", loopId: "loop-1", machineId, phase: "pending" });
    await seedRun(world.db, { id: "run-running", loopId: "loop-1", machineId, phase: "running", role: "exec" });
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const refused = await runClaimForTest(world.dataDir, [machineId]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("machine_run_active");
    expect(refused.err).toContain("run-running");

    const after = await openDb(world.dataDir);
    expect(await claimWorldSnapshot(after.db)).toEqual(before);

    // The running Run reaches a terminal phase: the claim goes through, and the
    // leftover PENDING Run is reported as a warning rather than blocking.
    await after.db.update(runs).set({ phase: "done" }).where(eq(runs.id, "run-running"));
    await closeDb(handles.pop()!);

    const allowed = await runClaimForTest(world.dataDir, [machineId]);
    expect(allowed.err).toBe("");
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain("1 pending Run(s) will become claimable");
  });
});

describe("slice 4 refusals: blobs (LM8)", () => {
  it("LM8: a missing source blob file refuses without touching anything", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    await unlinkArtifactBlobFile(world.dataDir, machineId, world.histories[0]!.blobs[0]!.hash);
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, [machineId]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("source_blob_missing");
    expect(existsSync(path.join(claimBlobRoot(world.dataDir), world.base.teamId))).toBe(false);
    expect(await claimWorldSnapshot((await openDb(world.dataDir)).db)).toEqual(before);
  });

  it("LM8: a corrupt source blob refuses (size and SHA-256 both checked)", async () => {
    const world = await seedClosedWorld();
    const machineId = world.base.machineIds[0]!;
    const victim = world.histories[0]!.blobs[0]!;
    // Same length, different bytes: only the DIGEST can catch this one.
    await plantRawBlobFile(world.dataDir, machineId, victim.hash, new TextEncoder().encode("AAAAA"));
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, [machineId]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("source_blob_corrupt");
    expect(await claimWorldSnapshot((await openDb(world.dataDir)).db)).toEqual(before);
  });

  it("LM8: a corrupt blob already in the TEAM namespace refuses and is NOT overwritten", async () => {
    const world = await seedClosedWorld();
    const victim = world.histories[0]!.blobs[0]!;
    const garbage = new TextEncoder().encode("ZZZZZ");
    // A leftover from an earlier run that went bad on disk.
    await plantRawBlobFile(world.dataDir, world.base.teamId, victim.hash, garbage);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds);

    expect(result.code).toBe(1);
    expect(result.err).toContain("target_blob_corrupt");
    // The damaged file is still there, byte for byte: never silently "repaired".
    expect(new Uint8Array(await readFile(path.join(claimBlobRoot(world.dataDir), world.base.teamId, victim.hash)))).toEqual(garbage);
  });

  it("LM8: a copy failure part-way through leaves EVERY machine unclaimed", async () => {
    const world = await seedClosedWorld([CLAIM_TOKEN_A, CLAIM_TOKEN_B]);
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    // The selection holds six distinct blobs; fail on the LAST one, after five
    // have already been published into the team namespace. That is the shape
    // the contract is really about: bytes on disk, no metadata moved.
    const injected = failingStore(storeOf(world.dataDir), ({ call }) =>
      call === 6 ? { ok: false, failure: "storage_error" } : null,
    );
    const result = await runClaimForTest(world.dataDir, world.base.machineIds, [], { blobStore: injected.store });

    expect(result.code).toBe(1);
    expect(result.err).toContain("storage_error");
    expect(injected.writes).toHaveLength(5); // published before the failure

    const after = await openDb(world.dataDir);
    // No machine claimed, no manifest/session/blob ROW moved...
    expect(await claimWorldSnapshot(after.db)).toEqual(before);
    // ...while the published blobs stay as the tolerated leftover a retry
    // reuses and re-verifies (决策 21).
    expect(existsSync(path.join(claimBlobRoot(world.dataDir), world.base.teamId, injected.writes[0]!))).toBe(true);
  });
});

describe("slice 4 refusals: transaction and chain (LM9/LM10)", () => {
  it("LM9: a transaction failure rolls every table back and keeps the copied blobs", async () => {
    const world = await seedClosedWorld();
    const before = await claimWorldSnapshot(world.db);
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds, [], {
      hooks: {
        insideClaimTx: () => {
          throw new Error("injected rollback");
        },
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("claim_transaction_failed");
    const after = await openDb(world.dataDir);
    expect(await claimWorldSnapshot(after.db)).toEqual(before);
    for (const blob of world.histories[0]!.blobs) {
      expect(existsSync(path.join(claimBlobRoot(world.dataDir), world.base.teamId, blob.hash))).toBe(true);
    }
  });

  it("LM9: a machine claimed between planning and the transaction aborts the whole run", async () => {
    const world = await seedClosedWorld([CLAIM_TOKEN_A, CLAIM_TOKEN_B]);
    const [machineA, machineB] = world.base.machineIds as [string, string];
    await seedUser(world.db, { id: "999999" });
    const otherTeamId = await seedTeam(world.db, { ownerUserId: "999999" });
    await closeDb(handles.pop()!);

    // The world moves under the planner: machine A is claimed by another team
    // after planning succeeded. The guarded UPDATEs must notice and roll back.
    let movedSnapshot: Awaited<ReturnType<typeof claimWorldSnapshot>> | undefined;
    const result = await runClaimForTest(world.dataDir, [machineA, machineB], [], {
      hooks: {
        beforeClaimTx: async (db) => {
          await db.update(machines).set({ teamId: otherTeamId }).where(eq(machines.id, machineA));
          movedSnapshot = await claimWorldSnapshot(db);
        },
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("claim_guard_lost");

    const after = await openDb(world.dataDir);
    expect(await claimWorldSnapshot(after.db)).toEqual(movedSnapshot);
    // Machine B was never claimed either — the run is all-or-nothing.
    expect((await after.db.select().from(machines).where(eq(machines.id, machineB)))[0]!.teamId).toBeNull();
  });

  it("LM10: a retry after a rolled-back run converges and reuses the copied blobs", async () => {
    const world = await seedClosedWorld();
    await closeDb(handles.pop()!);

    const failed = await runClaimForTest(world.dataDir, world.base.machineIds, [], {
      hooks: {
        insideClaimTx: () => {
          throw new Error("injected rollback");
        },
      },
    });
    expect(failed.code).toBe(1);

    const counted = failingStore(storeOf(world.dataDir), () => null);
    const retry = await runClaimForTest(world.dataDir, world.base.machineIds, [], { blobStore: counted.store });

    expect(retry.err).toBe("");
    expect(retry.code).toBe(0);
    // Nothing was republished: the leftover blobs were verified and reused.
    expect(counted.writes).toHaveLength(0);
    expect(retry.out).toContain("copied   : 0 blob(s)");

    const after = await openDb(world.dataDir);
    expect((await after.db.select().from(machines))[0]!.teamId).toBe(world.base.teamId);
    expect((await after.db.select().from(artifactBlobs)).filter((r) => r.namespaceId === world.base.teamId)).toHaveLength(3);
  });

  it("LM10: a manifest pointing at the wrong namespace refuses (never re-migrates)", async () => {
    const world = await seedClosedWorld();
    await world.db
      .update(artifactManifests)
      .set({ namespaceId: "m-somewhere-else" })
      .where(eq(artifactManifests.id, world.histories[0]!.manifestId));
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds);

    expect(result.code).toBe(1);
    expect(result.err).toContain("chain_inconsistent");
    expect(result.err).toContain("manifest_namespace_mismatch");
  });

  it("LM10: a manifest entry with no blob row refuses", async () => {
    const world = await seedClosedWorld();
    const history = world.histories[0]!;
    const ghost = makeArtifactBlob("never-uploaded");
    // The entry exists only in the manifest — its blob was never recorded.
    await world.db
      .update(artifactManifests)
      .set({
        entries: [...history.entries, { path: "ghost.txt", hash: ghost.hash, size: ghost.size }],
        fileCount: history.entries.length + 1,
        totalBytes: history.entries.reduce((sum, entry) => sum + entry.size, 0) + ghost.size,
      })
      .where(eq(artifactManifests.id, history.manifestId));
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds);

    expect(result.code).toBe(1);
    expect(result.err).toContain("blob_row_missing");
  });

  it("LM10: a loop whose snapshot cursor dangles refuses", async () => {
    const world = await seedClosedWorld();
    await world.db.update(loops).set({ artifactManifestId: "amf-does-not-exist" }).where(eq(loops.id, "loop-1"));
    await closeDb(handles.pop()!);

    const result = await runClaimForTest(world.dataDir, world.base.machineIds);

    expect(result.code).toBe(1);
    expect(result.err).toContain("loop_snapshot_dangling");
  });
});
