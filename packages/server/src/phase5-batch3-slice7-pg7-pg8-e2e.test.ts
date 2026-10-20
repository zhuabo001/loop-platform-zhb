/**
 * Phase 5 Batch 3 slice 7 — PG7/PG8 through the PRODUCTION composition root.
 *
 *  PG7  A NEW file database boots, restarts twice, and never re-registers a
 *       machine: an unknown token, an enrolled-but-unclaimed token and a
 *       claimed-but-revoked token all get 401 with ZERO writes to the seven
 *       business tables or the four identity tables. A claimed control machine
 *       still polls successfully.
 *
 *  PG8  A Batch 2 (0000–0005) database boots through production migration 0006,
 *       restarts twice, and still refuses its pre-Batch-3 machine token (every
 *       legacy machine lands unclaimed). Only the offline claim changes that:
 *       after claim + reboot the SAME token polls, and an unknown token still
 *       gets 401 with zero writes.
 *
 * Both tests use REAL HTTP and a FILE-BACKED PGlite. The oracle is populated
 * before every comparison — an empty snapshot cannot prove zero writes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { machineIdFromToken } from "@loopzhb/protocol/node";

import type { Db } from "./db/index.js";
import { machines } from "./db/schema.js";
import { buildBatch2World } from "./testkit/batch2-world.js";
import { runClaimForTest } from "./testkit/claim-fixtures.js";
import {
  FakeClock,
  FakeCronFactory,
  seedClaimedMachine,
  seedLoop,
  seedMachineForToken,
  seedManagementSession,
  seedRun,
  snapshotBusinessState,
  snapshotIdentityState,
} from "./testkit/index.js";
import { bootListeningServer, type ListeningServer } from "./testkit/server-lifetime.js";

const T0 = new Date("2026-10-20T00:00:00.000Z");

const CONTROL_TOKEN = "dk_pg7_control_machine";
const UNCLAIMED_TOKEN = "dk_pg7_unclaimed_machine";
const REVOKED_TOKEN = "dk_pg7_revoked_machine";
const UNKNOWN_TOKEN = "dk_pg7_unknown_machine";
const LEGACY_TOKEN = "dk_pg8_legacy_machine";

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

async function boot(dataDir: string, clock: FakeClock): Promise<ListeningServer> {
  const server = await bootListeningServer({ dataDir, clock, cronFactory: new FakeCronFactory() });
  servers.add(server);
  return server;
}

async function shutdown(server: ListeningServer): Promise<void> {
  servers.delete(server);
  await server.shutdown();
}

async function worldSnapshot(db: Db) {
  return { ...(await snapshotBusinessState(db)), ...(await snapshotIdentityState(db)) };
}

function poll(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/machine/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
}

async function expectPollRejected(baseUrl: string, token: string): Promise<void> {
  const res = await poll(baseUrl, token);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "invalid machine credential" });
}

async function machineIds(db: Db): Promise<string[]> {
  return (await db.select({ id: machines.id }).from(machines)).map((row) => row.id).sort();
}

describe("slice 7 PG7/PG8: production boot cannot restore self-registration", () => {
  it("PG7: a new database refuses unknown, unclaimed and revoked credentials with zero writes across two restarts", async () => {
    const dataDir = await freshDir("pg7");
    const clock = new FakeClock(T0);
    let server = await boot(dataDir, clock);

    const identity = await seedManagementSession(server.booted.handle.db, {
      clock,
      githubUserId: "424242",
      username: "analyst",
    });
    await seedClaimedMachine(server.booted.handle.db, CONTROL_TOKEN, identity.teamId);
    await seedMachineForToken(server.booted.handle.db, UNCLAIMED_TOKEN);
    await seedMachineForToken(server.booted.handle.db, REVOKED_TOKEN, {
      teamId: identity.teamId,
      revokedAt: clock.iso(),
    });
    await seedLoop(server.booted.handle.db, {
      id: "pg7-loop",
      machineId: machineIdFromToken(CONTROL_TOKEN),
    });
    await seedRun(server.booted.handle.db, {
      id: "pg7-pending",
      loopId: "pg7-loop",
      machineId: machineIdFromToken(CONTROL_TOKEN),
      phase: "pending",
    });

    const unknownId = machineIdFromToken(UNKNOWN_TOKEN);

    for (let cycle = 0; cycle < 3; cycle++) {
      // Captured at the start of THIS cycle: the positive control below writes
      // the control machine's heartbeat, so the baseline is re-taken after it.
      const before = await worldSnapshot(server.booted.handle.db);
      expect(before.machines.length).toBeGreaterThanOrEqual(3);
      expect(before.users.length).toBe(1);

      for (const token of [UNKNOWN_TOKEN, UNCLAIMED_TOKEN, REVOKED_TOKEN]) {
        await expectPollRejected(server.baseUrl, token);
        expect(await worldSnapshot(server.booted.handle.db), `cycle ${cycle} token ${token}`).toEqual(before);
        expect(await machineIds(server.booted.handle.db)).not.toContain(unknownId);
      }

      // The claimed control machine is the positive control: the same route
      // DOES work for an eligible credential (and may claim the pending run).
      const control = await poll(server.baseUrl, CONTROL_TOKEN);
      expect(control.status).toBe(200);

      if (cycle < 2) {
        await shutdown(server);
        server = await boot(dataDir, clock);
      }
    }

    // No rejected credential ever produced a row, and the control machine was
    // never duplicated across three boots.
    expect(await machineIds(server.booted.handle.db)).not.toContain(unknownId);
    expect((await machineIds(server.booted.handle.db)).filter((id) => id === machineIdFromToken(CONTROL_TOKEN))).toHaveLength(1);
  }, 90_000);

  it("PG8: a Batch 2 database stays closed until the offline claim; restarts never re-register", async () => {
    const dataDir = await freshDir("pg8");
    const workdir = await freshDir("pg8-work");
    const clock = new FakeClock(T0);
    const world = await buildBatch2World(dataDir, {
      machineToken: LEGACY_TOKEN,
      workdir,
      runMode: "pending",
      // Keep the post-claim reboot free of scheduler catch-up: this test is
      // about credential admission, not scheduling.
      cron: null,
      includePlainLoop: false,
      artifacts: [
        { path: "dist/app.js", text: "legacy app" },
        { path: "docs/readme.md", text: "legacy docs" },
      ],
    });

    let server = await boot(dataDir, clock);
    const legacyRow = await server.booted.handle.db.select().from(machines);
    expect(legacyRow.find((row) => row.id === world.machineId)).toMatchObject({ teamId: null, revokedAt: null });

    // Three boots: the old token never registers; the oracle is populated
    // (one legacy machine, one Loop, two Runs) so equality is meaningful.
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = await worldSnapshot(server.booted.handle.db);
      expect(before.machines.length).toBe(1);
      expect(before.loops.length).toBeGreaterThanOrEqual(1);

      await expectPollRejected(server.baseUrl, LEGACY_TOKEN);
      await expectPollRejected(server.baseUrl, UNKNOWN_TOKEN);
      expect(await worldSnapshot(server.booted.handle.db), `cycle ${cycle}`).toEqual(before);
      expect(await machineIds(server.booted.handle.db)).toEqual([world.machineId]);

      if (cycle < 2) {
        await shutdown(server);
        server = await boot(dataDir, clock);
      }
    }

    // A real login would create this identity; the fixture states it directly.
    await seedManagementSession(server.booted.handle.db, {
      clock,
      githubUserId: "424242",
      username: "analyst",
    });
    await shutdown(server);

    const claim = await runClaimForTest(dataDir, [world.machineId], ["--dry-run"]);
    expect(claim.code).toBe(0);
    expect(claim.out).toContain(world.machineId);
    const claimed = await runClaimForTest(dataDir, [world.machineId]);
    expect(claimed.code).toBe(0);

    server = await boot(dataDir, clock);
    const after = await server.booted.handle.db.select().from(machines);
    const claimedRow = after.find((row) => row.id === world.machineId)!;
    expect(claimedRow.teamId).not.toBeNull();
    expect(claimedRow.tokenHash).toBe(legacyRow.find((row) => row.id === world.machineId)!.tokenHash);

    expect((await poll(server.baseUrl, LEGACY_TOKEN)).status).toBe(200);
    // The successful legacy poll may write heartbeat/claim state; take the
    // unknown rejection's baseline AFTER it.
    const beforeUnknown = await worldSnapshot(server.booted.handle.db);
    await expectPollRejected(server.baseUrl, UNKNOWN_TOKEN);
    expect(await worldSnapshot(server.booted.handle.db)).toEqual(beforeUnknown);
    expect(await machineIds(server.booted.handle.db)).toEqual([world.machineId]);
  }, 90_000);
});
