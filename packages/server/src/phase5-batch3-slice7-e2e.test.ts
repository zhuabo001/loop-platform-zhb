/**
 * Phase 5 Batch 3 slice 7 — BI1–BI6 through the PRODUCTION composition root.
 *
 * One ordered narrative, because it IS one upgrade:
 *
 *   A  Batch 2 (0000–0005) file DB → production boot applies 0006
 *   B  first GitHub login (scripted adapter) creates the personal team
 *   C  the old Machine and all its history are INVISIBLE and unexecutable
 *   D  claim is refused while the Server holds the dataDir lock
 *   E  a corrupt claim target refuses the whole migration with zero DB writes
 *   F  the repaired retry claims the machine and rewrites the namespace
 *   G  restart: the old Session, the old token, the old snapshot bytes and the
 *      committed session receipt all survive
 *   H  the production daemon stack executes the pre-upgrade pending Run and
 *      binds a NEW snapshot; the old snapshot stays frozen
 *   I  production authentication cannot be bypassed
 *
 * HTTP is a REAL 127.0.0.1 listener; PGlite is file-backed; blobs are the local
 * store; GitHub is a scripted fetch (never real); the Runner is the Fake
 * Runner (never real Claude). BI3's "failure recovery" is the lock refusal plus
 * the corrupt-target rollback/retry — NOT an injected SQL-migration failure.
 */
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
// The daemon's public index deliberately keeps the artifact modules off its
// surface (AD4); these tests deep-import the BUILT dist, the same "verify what
// ships" convention as the slice-8 E2E.
import { createArtifactTransport } from "../../daemon/dist/artifact-client.js";
import { createFinalArtifactSync } from "../../daemon/dist/artifact-final-sync.js";
import { createArtifactHashCache } from "../../daemon/dist/artifact-hash-cache.js";
import { createArtifactSyncClient } from "../../daemon/dist/artifact-sync.js";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { OAUTH_TX_COOKIE, SESSION_COOKIE } from "./auth/cookies.js";
import { closeDb, type Db } from "./db/index.js";
import { artifactBlobs, artifactManifests, artifactSyncSessions, machines, runLeases, runs } from "./db/schema.js";
import {
  openBatch2Db,
  seedBatch2Data,
  selectBatch2Columns,
  type Batch2World,
} from "./testkit/batch2-world.js";
import { runClaimForTest } from "./testkit/claim-fixtures.js";
import {
  FakeClock,
  FakeCronFactory,
  seedPersonalIdentity,
  seedSession,
  setCookieValue,
  snapshotBusinessState,
  snapshotIdentityState,
} from "./testkit/index.js";
import { bootListeningServer, type ListeningServer } from "./testkit/server-lifetime.js";

const T0 = new Date("2026-10-20T00:00:00.000Z");
const DAY_MS = 24 * 3600 * 1000;

const LEGACY_TOKEN = "dk_bi_legacy_machine";
const UNKNOWN_TOKEN = "dk_bi_unknown_machine";
const OLD_APP = "console.log('batch2 app')\n";
const OLD_DOC = "batch 2 readme\n";

const servers = new Set<ListeningServer>();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers) await server.shutdown().catch(() => {});
  servers.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-${prefix}-${process.pid}-`));
  tempDirs.push(dir);
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function cookie(credential: string): string {
  return `${SESSION_COOKIE}=${credential}`;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface GithubIdentity {
  id: number;
  login: string;
}

function makeGithubFetch(identity: GithubIdentity): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return json({ access_token: "gho_bi_scripted", token_type: "bearer" });
    }
    return json(identity);
  }) as typeof fetch;
}

async function login(baseUrl: string): Promise<string> {
  const start = await fetch(`${baseUrl}/auth/github`, { redirect: "manual" });
  expect(start.status).toBe(303);
  const txId = setCookieValue(start, OAUTH_TX_COOKIE);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  expect(txId).toBeTruthy();
  expect(state).toBeTruthy();

  const callback = await fetch(`${baseUrl}/auth/github/callback?code=bi&state=${state}`, {
    headers: { cookie: `${OAUTH_TX_COOKIE}=${txId}` },
    redirect: "manual",
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe("/");
  const credential = setCookieValue(callback, SESSION_COOKIE);
  expect(credential).toBeTruthy();
  return credential!;
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, deadlineMs = 15_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`deadline exceeded waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function worldSnapshot(db: Db) {
  return { ...(await snapshotBusinessState(db)), ...(await snapshotIdentityState(db)) };
}

function poll(baseUrl: string, token: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/machine/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function download(baseUrl: string, credential: string, loopId: string, snapshotId: string, filePath: string): Promise<Response> {
  return fetch(
    `${baseUrl}/api/loops/${loopId}/artifacts/download?snapshotId=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(filePath)}`,
    { headers: { cookie: cookie(credential) } },
  );
}

describe("slice 7 BI1–BI6: a Batch 2 data directory upgrades, is claimed offline, and keeps its history", () => {
  it("BI1–BI6 through the production composition root", async () => {
    const dataDir = await freshDir("bi");
    // Canonical (macOS /var is a symlink): the daemon's final sync classifies
    // a root mismatch as `outside_jail`, so the fixture must state the real path.
    const workdir = await realpath(await freshDir("bi-work"));
    await mkdir(path.join(workdir, "dist"), { recursive: true });
    await writeFile(path.join(workdir, "dist", "app.js"), "post-upgrade app\n");

    // ---- A: build the OLD world, snapshot every old column, then upgrade ----
    const old = await openBatch2Db(dataDir);
    let world!: Batch2World;
    let before!: Record<string, unknown[]>;
    let journalBefore!: number;
    try {
      world = await seedBatch2Data(old, {
        machineToken: LEGACY_TOKEN,
        workdir,
        machineRoots: [workdir],
        taskFile: null,
        runMode: "pending",
        // The claim makes the Loop scheduler-eligible; a live schedule would
        // catch up and supersede the pending Run that stage H needs.
        cron: null,
        includePlainLoop: false,
        artifacts: [
          { path: "dist/app.js", text: OLD_APP },
          { path: "docs/readme.md", text: OLD_DOC },
        ],
      });
      before = {
        machines: await selectBatch2Columns(old, "machines"),
        loops: await selectBatch2Columns(old, "loops"),
        runs: await selectBatch2Columns(old, "runs"),
        run_leases: await selectBatch2Columns(old, "run_leases"),
        artifact_sync_sessions: await selectBatch2Columns(old, "artifact_sync_sessions"),
        artifact_manifests: await selectBatch2Columns(old, "artifact_manifests"),
        artifact_blobs: await selectBatch2Columns(old, "artifact_blobs"),
      };
      const journal = await old.client.query<{ count: string }>('SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"');
      journalBefore = Number(journal.rows[0]!.count);
    } finally {
      await closeDb(old);
    }
    expect(journalBefore).toBe(6);
    expect(world!.machineId).toBe(machineIdFromToken(LEGACY_TOKEN));

    const clock = new FakeClock(T0);
    const githubFetch = makeGithubFetch({ id: 424242, login: "analyst" });
    let server = await bootListeningServer({ dataDir, clock, cronFactory: new FakeCronFactory(), githubFetch });
    servers.add(server);
    let db = server.booted.handle.db;

    const journalAfter = await server.booted.handle.client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(Number(journalAfter.rows[0]!.count)).toBe(7);
    for (const [table, expected] of Object.entries(before)) {
      expect(
        await selectBatch2Columns(server.booted.handle, table as Parameters<typeof selectBatch2Columns>[1]),
        table,
      ).toEqual(expected);
    }
    const legacyMachine = (await db.select().from(machines).where(eq(machines.id, world.machineId)))[0]!;
    expect([legacyMachine.teamId, legacyMachine.revokedAt]).toEqual([null, null]);
    expect(await db.select().from(runLeases)).toEqual([]);

    // Full PRE-claim rows for the history-fidelity check at stage F. The claim
    // may rewrite ONLY namespace_id; taking the oracle here (before the Server
    // stops) means a claim-time rewrite of committedAt or the receipt cannot
    // hide behind a post-claim baseline (review: Specs P3).
    const manifestBeforeClaim = (
      await db.select().from(artifactManifests).where(eq(artifactManifests.id, world.manifestId))
    )[0]!;
    const committedBeforeClaim = (
      await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, "sync-committed"))
    )[0]!;

    // ---- B: first login creates the personal team; it claims nothing ----
    const credential = await login(server.baseUrl);
    const sessionRes = await fetch(`${server.baseUrl}/api/session`, { headers: { cookie: cookie(credential) } });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { user: { id: string; username: string }; team: { id: string; name: string } };
    expect(session.user.username).toBe("analyst");
    expect(session.team.id).toMatch(/^t-/);
    expect((await db.select().from(machines).where(eq(machines.id, world!.machineId)))[0]!.teamId).toBeNull();

    // ---- C: old data is invisible, unexecutable and the probes write nothing ----
    const afterLogin = await worldSnapshot(db);
    expect(
      ((await (await fetch(`${server.baseUrl}/api/machines`, { headers: { cookie: cookie(credential) } })).json()) as {
        machines: unknown[];
      }).machines,
    ).toEqual([]);
    expect(
      ((await (await fetch(`${server.baseUrl}/api/loops`, { headers: { cookie: cookie(credential) } })).json()) as {
        loops: unknown[];
      }).loops,
    ).toEqual([]);

    const canonical404 = await (await fetch(`${server.baseUrl}/nope`)).text();
    const oldRuns = await fetch(`${server.baseUrl}/api/loops/${world!.loopId}/runs`, {
      headers: { cookie: cookie(credential) },
    });
    expect(oldRuns.status).toBe(404);
    expect(await oldRuns.text()).toBe(canonical404);
    const oldDownload = await download(server.baseUrl, credential, world!.loopId, world!.manifestId, "dist/app.js");
    expect(oldDownload.status).toBe(404);
    expect(await oldDownload.text()).toBe(canonical404);

    const dashboard = await fetch(`${server.baseUrl}/`, { headers: { cookie: cookie(credential) } });
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain("当前团队暂无 Loop");
    expect(html).toContain("claim:legacy");
    expect(html).not.toContain("nightly");

    const oldPoll = await poll(server.baseUrl, LEGACY_TOKEN);
    expect(oldPoll.status).toBe(401);
    expect(await oldPoll.json()).toEqual({ error: "invalid machine credential" });
    expect(await worldSnapshot(db)).toEqual(afterLogin);
    expect(await exists(path.join(dataDir, "blobs", session.team.id))).toBe(false);

    // ---- D: the running Server's lock refuses the offline claim ----
    const locked = await runClaimForTest(dataDir, [world!.machineId]);
    expect(locked.code).toBe(3);
    expect(locked.err).toContain(`held by pid ${process.pid}`);
    expect((await db.select().from(machines).where(eq(machines.id, world!.machineId)))[0]!.teamId).toBeNull();

    // ---- E: a corrupt claim target refuses the WHOLE migration ----
    servers.delete(server);
    await server.shutdown();

    const blobDir = path.join(dataDir, "blobs", session.team.id);
    const first = world!.artifacts[0]!;
    await mkdir(blobDir, { recursive: true });
    const corruptPath = path.join(blobDir, first.hash);
    const corruptBytes = Buffer.alloc(first.size, 0x58);
    await writeFile(corruptPath, corruptBytes);

    // Re-open the DB through the production handle to state the oracle.
    const probe = await bootListeningServer({ dataDir, clock, cronFactory: new FakeCronFactory(), githubFetch });
    servers.add(probe);
    db = probe.booted.handle.db;
    const afterFailure = await worldSnapshot(db);
    servers.delete(probe);
    await probe.shutdown();

    const corruptClaim = await runClaimForTest(dataDir, [world!.machineId]);
    expect(corruptClaim.code).toBe(1);
    expect(corruptClaim.err).toContain("target_blob_corrupt");
    const reopened = await bootListeningServer({ dataDir, clock, cronFactory: new FakeCronFactory(), githubFetch });
    servers.add(reopened);
    db = reopened.booted.handle.db;
    expect(await worldSnapshot(db)).toEqual(afterFailure);
    expect((await db.select().from(machines).where(eq(machines.id, world!.machineId)))[0]!.teamId).toBeNull();
    expect((await readFile(corruptPath)).equals(corruptBytes)).toBe(true);
    for (const artifact of world!.artifacts) {
      expect(await exists(path.join(dataDir, "blobs", world!.machineId, artifact.hash))).toBe(true);
    }
    servers.delete(reopened);
    await reopened.shutdown();

    // ---- F: remove the corrupt target; the retry claims and rewrites ----
    await rm(blobDir, { recursive: true, force: true });
    const claimed = await runClaimForTest(dataDir, [world!.machineId]);
    expect(claimed.code).toBe(0);
    expect(claimed.out).toContain("committed: 1 machine(s)");
    expect(claimed.out).toContain(session.team.id);

    const afterClaim = await bootListeningServer({ dataDir, clock, cronFactory: new FakeCronFactory(), githubFetch });
    servers.add(afterClaim);
    server = afterClaim;
    db = server.booted.handle.db;

    const claimedMachine = (await db.select().from(machines).where(eq(machines.id, world!.machineId)))[0]!;
    expect(claimedMachine.teamId).toBe(session.team.id);
    expect(claimedMachine.id).toBe(world!.machineId);
    expect(claimedMachine.tokenHash).toBe(legacyMachine.tokenHash);

    const manifest = (await db.select().from(artifactManifests).where(eq(artifactManifests.id, world!.manifestId)))[0]!;
    expect(manifest.namespaceId).toBe(session.team.id);
    expect(manifest.entries).toEqual(world!.artifacts.map((a) => ({ path: a.path, hash: a.hash, size: a.size })));
    expect(manifest.manifestRevision).toBe(1);
    // EVERY other manifest field — including committedAt — is unchanged by the
    // claim. A namespace-only UPDATE may not touch history timestamps.
    expect({ ...manifest, namespaceId: manifestBeforeClaim.namespaceId }).toEqual(manifestBeforeClaim);
    const committed = (await db.select().from(artifactSyncSessions).where(eq(artifactSyncSessions.id, "sync-committed")))[0]!;
    expect(committed.namespaceId).toBe(session.team.id);
    expect(committed.receipt).toEqual({ artifactSnapshotId: world!.manifestId, manifestRevision: 1 });
    // The committed session survives the claim except for its namespace too.
    expect({ ...committed, namespaceId: committedBeforeClaim.namespaceId }).toEqual(committedBeforeClaim);
    for (const artifact of world!.artifacts) {
      expect(await exists(path.join(dataDir, "blobs", world!.machineId, artifact.hash))).toBe(true);
      expect(await exists(path.join(dataDir, "blobs", session.team.id, artifact.hash))).toBe(true);
    }

    // ---- G: restart — Session, token, snapshot bytes and receipt survive ----
    const manifestBefore = JSON.stringify(manifest);
    servers.delete(server);
    await server.shutdown();
    server = await bootListeningServer({ dataDir, clock, cronFactory: new FakeCronFactory(), githubFetch });
    servers.add(server);
    db = server.booted.handle.db;

    expect((await fetch(`${server.baseUrl}/api/session`, { headers: { cookie: cookie(credential) } })).status).toBe(200);
    const loopsNow = (await (await fetch(`${server.baseUrl}/api/loops`, { headers: { cookie: cookie(credential) } })).json()) as {
      loops: { id: string }[];
    };
    expect(loopsNow.loops.map((loop) => loop.id)).toContain(world!.loopId);

    // availableSlots:0 proves the credential is eligible WITHOUT claiming the
    // pending Run that stage H needs.
    expect((await poll(server.baseUrl, LEGACY_TOKEN, { availableSlots: 0 })).status).toBe(200);
    expect((await db.select().from(machines).where(eq(machines.id, world!.machineId))).length).toBe(1);

    const downloadRes = await download(server.baseUrl, credential, world!.loopId, world!.manifestId, "dist/app.js");
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-disposition")).toContain("attachment");
    expect(downloadRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloadRes.headers.get("cache-control")).toBe("no-store");
    expect(downloadRes.headers.get("content-length")).toBe(String(Buffer.byteLength(OLD_APP)));
    expect(await downloadRes.text()).toBe(OLD_APP);

    const beforeReplay = await worldSnapshot(db);
    const replay = await fetch(`${server.baseUrl}/api/machine/sync/sync-committed/commit`, {
      method: "POST",
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ artifactSnapshotId: world!.manifestId, manifestRevision: 1 });
    expect(await worldSnapshot(db)).toEqual(beforeReplay);

    // A SECOND user's personal team cannot see the claimed Loop.
    const other = await seedPersonalIdentity(db, { githubUserId: "222", username: "bob" });
    const otherSession = await seedSession(db, {
      userId: other.userId,
      createdAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 7 * DAY_MS).toISOString(),
    });
    const crossTeam = await fetch(`${server.baseUrl}/api/loops/${world!.loopId}/artifacts`, {
      headers: { cookie: cookie(otherSession.credential) },
    });
    expect(crossTeam.status).toBe(404);
    expect(await crossTeam.text()).toBe(canonical404);
    expect(
      ((await (await fetch(`${server.baseUrl}/api/loops`, { headers: { cookie: cookie(otherSession.credential) } })).json()) as {
        loops: unknown[];
      }).loops,
    ).toEqual([]);

    // ---- H: the production daemon stack executes the pending Run and syncs ----
    const transport = createArtifactTransport({ baseUrl: server.baseUrl, machineCredential: LEGACY_TOKEN });
    const sync = createArtifactSyncClient({ transport, cache: createArtifactHashCache() });
    const finalSync = createFinalArtifactSync({ sync, daemonRoots: [workdir] });
    const fake = createFakeRunner();
    let runnerCalls = 0;
    const runner: AgentRunner = {
      run: (delivery, context) => {
        runnerCalls += 1;
        return fake.run(delivery, context);
      },
    };
    const runtime = createDaemonRuntime({
      client: createMachineClient({ baseUrl: server.baseUrl, machineCredential: LEGACY_TOKEN }),
      runner,
      identity: {
        host: "bi-host",
        platform: "test",
        arch: "test",
        version: "0.1.0",
        capabilities: ["terminal-journal-v1", "artifact-sync-v1"],
      },
      pollMs: 3000,
      machineCredential: LEGACY_TOKEN,
      finalSync,
    });

    await runtime.pollOnce();
    await runtime.executionSettled();
    await until(
      async () => (await db.select().from(runs).where(eq(runs.id, world!.pendingRunId!)))[0]?.phase === "done",
      "the pre-upgrade pending Run to finish",
    );

    const finished = (await db.select().from(runs).where(eq(runs.id, world!.pendingRunId!)))[0]!;
    expect(finished.outcome).toBe("exec");
    expect(finished.artifactSyncError).toBeNull();
    const newSnapshot = finished.artifactSnapshotId;
    expect(newSnapshot).toBeTruthy();
    expect(newSnapshot).not.toBe(world!.manifestId);
    expect(runnerCalls).toBe(1);

    // The old snapshot is frozen and still serves its original bytes.
    const frozen = (await db.select().from(artifactManifests).where(eq(artifactManifests.id, world!.manifestId)))[0]!;
    expect(JSON.stringify(frozen)).toBe(manifestBefore);
    expect(await (await download(server.baseUrl, credential, world!.loopId, world!.manifestId, "dist/app.js")).text()).toBe(OLD_APP);

    // New blobs landed under the TEAM namespace; the Machine row was not duplicated.
    const newBlobs = await db.select().from(artifactBlobs).where(eq(artifactBlobs.namespaceId, session.team.id));
    expect(newBlobs.length).toBeGreaterThanOrEqual(3);
    expect(newBlobs.some((row) => !world!.artifacts.some((a) => a.hash === row.hash))).toBe(true);
    expect((await db.select().from(machines)).length).toBe(1);

    // A second poll has no pending work: no duplicate execution.
    await runtime.pollOnce();
    await runtime.executionSettled();
    expect(runnerCalls).toBe(1);

    // ---- I: production authentication cannot be bypassed ----
    const beforeAuth = await worldSnapshot(db);
    const anonMachines = await fetch(`${server.baseUrl}/api/machines`);
    expect(anonMachines.status).toBe(401);
    expect(await anonMachines.json()).toEqual({ error: "not authenticated" });

    const anonRun = await fetch(`${server.baseUrl}/api/loops/${world!.loopId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonRun.status).toBe(401);
    expect(await anonRun.json()).toEqual({ error: "not authenticated" });

    const sessionOnMachine = await fetch(`${server.baseUrl}/api/machine/poll`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie(credential) },
      body: "{}",
    });
    expect(sessionOnMachine.status).toBe(401);
    expect(await sessionOnMachine.json()).toEqual({ error: "invalid machine credential" });

    const unknownPoll = await poll(server.baseUrl, UNKNOWN_TOKEN);
    expect(unknownPoll.status).toBe(401);
    expect(await unknownPoll.json()).toEqual({ error: "invalid machine credential" });

    const bearerOnManagement = await fetch(`${server.baseUrl}/api/machines`, {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    expect(bearerOnManagement.status).toBe(401);
    expect(await bearerOnManagement.json()).toEqual({ error: "not authenticated" });

    const anonDashboard = await fetch(`${server.baseUrl}/`, { redirect: "manual" });
    expect(anonDashboard.status).toBe(303);
    expect(anonDashboard.headers.get("location")).toBe("/login");
    expect(anonDashboard.headers.get("set-cookie")).toBeNull();

    const anonDashboardPost = await fetch(`${server.baseUrl}/dashboard/loops/${world!.loopId}/run`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrf=deadbeef",
    });
    expect(anonDashboardPost.status).toBe(401);
    expect(await anonDashboardPost.json()).toEqual({ error: "not authenticated" });

    expect(await worldSnapshot(db)).toEqual(beforeAuth);
  }, 180_000);
});
