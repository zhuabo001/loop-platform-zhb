/**
 * Poll — machine credential + self-registration + heartbeat/identity (A-13).
 *
 * The poll endpoint is Phase 1's ONLY machine enrollment surface: a first
 * well-shaped `dk_` poll self-registers the machine (derived id + full token
 * hash), later polls verify BOTH the derived id and the full hash (64-bit
 * truncation collision defense, reference audit H-01). `lastSeen` is a
 * monotonic 10s persisted watermark — never a per-poll audit stamp — with the
 * identity snapshot merged into the same single UPDATE when it changes.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { machineIdFromToken, sha256, watchConfigDigest } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { loops, machines, type Machine } from "../db/schema.js";
import { HEARTBEAT_SKEW_SLACK_MS, applyMachinePollContact } from "../store/machines.js";
import {
  FakeClock,
  seedLoop,
  seedMachineForToken,
  seedRun,
  snapshotLeases,
  snapshotRuns,
  testDeps,
} from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "./index.js";

const TOKEN = "dk_test_machine_alpha";
const OTHER_TOKEN = "dk_test_machine_beta";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let coordinator: RunCoordinator;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  coordinator = createRunCoordinator(testDeps(db, clock));
}

async function getRow(id: string): Promise<Machine | undefined> {
  return (await db.select().from(machines).where(eq(machines.id, id)))[0];
}

describe("poll: machine credential", () => {
  it("rejects a malformed device token with zero machine writes", async () => {
    await fresh();
    for (const bad of ["", "rk_testcred_1", "dk_", "dk_ has spaces", "dk_x"]) {
      await expect(coordinator.poll(bad, {})).rejects.toMatchObject({ name: "InvalidMachineCredentialError" });
    }
    expect(await db.select().from(machines)).toEqual([]);
  });

  it("rejects a well-shaped token whose full hash mismatches the enrolled row (collision defense)", async () => {
    await fresh();
    // Simulate a truncated-id collision: a row exists at the derived id but
    // was enrolled under a DIFFERENT token (different full hash).
    await db.insert(machines).values({
      id: machineIdFromToken(TOKEN),
      name: "enrolled",
      tokenHash: sha256(OTHER_TOKEN),
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await expect(coordinator.poll(TOKEN, {})).rejects.toMatchObject({ name: "InvalidMachineCredentialError" });
    // Zero writes: the enrolled row is untouched.
    expect(await getRow(machineIdFromToken(TOKEN))).toMatchObject({ name: "enrolled", lastSeen: null });
  });

  it("accepts the enrolled token (derived id + full hash both verified)", async () => {
    await fresh();
    await seedMachineForToken(db, TOKEN);
    await expect(coordinator.poll(TOKEN, {})).resolves.toEqual({ deliveries: [] });
  });
});

describe("poll: self-registration", () => {
  it("creates the machine on first poll: derived id, full hash, identity snapshot, watermark", async () => {
    await fresh();
    const result = await coordinator.poll(TOKEN, {
      host: "mbp.local",
      platform: "darwin",
      arch: "arm64",
      version: "0.1.0",
    });
    expect(result).toEqual({ deliveries: [] });

    const row = await getRow(machineIdFromToken(TOKEN));
    expect(row).toMatchObject({
      id: machineIdFromToken(TOKEN),
      name: "mbp.local",
      hostname: "mbp.local",
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "0.1.0",
      tokenHash: sha256(TOKEN),
      lastSeen: clock.iso(),
      createdAt: clock.iso(),
    });
  });

  it("falls back to a stable machine-id-derived name when no usable host is reported", async () => {
    await fresh();
    await coordinator.poll(TOKEN, { host: "   " });
    const id = machineIdFromToken(TOKEN);
    const row = await getRow(id);
    expect(row).toMatchObject({ name: `machine-${id.slice(2, 8)}`, hostname: null });
  });

  it("cleans identity fields: NUL-stripped, trimmed, capped, blank treated as not reported", async () => {
    await fresh();
    await coordinator.poll(TOKEN, {
      host: `  dev\0-box  `,
      platform: "darwin".repeat(30), // 210 chars → capped at 64
      arch: "\0\0",
      version: "v1",
    });
    const row = await getRow(machineIdFromToken(TOKEN));
    expect(row).toMatchObject({
      name: "dev-box",
      hostname: "dev-box",
      platform: "darwin".repeat(10) + "darw", // 64 chars
      arch: null,
      daemonVersion: "v1",
    });
    expect(row!.platform).toHaveLength(64);
  });

  it("converges concurrent first polls for the same token to ONE row (idempotent, no 500)", async () => {
    await fresh();
    const [a, b] = await Promise.all([coordinator.poll(TOKEN, {}), coordinator.poll(TOKEN, {})]);
    expect(a).toEqual({ deliveries: [] });
    expect(b).toEqual({ deliveries: [] });
    const rows = await db.select().from(machines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: machineIdFromToken(TOKEN), tokenHash: sha256(TOKEN) });
  });
});

describe("poll: heartbeat watermark + identity snapshot (A-13)", () => {
  async function enrolled(lastSeen: string | null): Promise<string> {
    return seedMachineForToken(db, TOKEN, {
      name: "friendly",
      hostname: "old-host",
      lastSeen,
    });
  }

  it("is read-only for an unchanged poll inside the 10s window", async () => {
    await fresh();
    const t0 = new Date(clock.now().getTime() - 5_000).toISOString(); // 5s ago
    const id = await enrolled(t0);
    await coordinator.poll(TOKEN, { host: "old-host" });
    const row = await getRow(id);
    expect(row).toMatchObject({ lastSeen: t0, hostname: "old-host", name: "friendly" });
  });

  it("refreshes the watermark once the 10s boundary is reached", async () => {
    await fresh();
    const t0 = new Date(clock.now().getTime() - 10_000).toISOString(); // exactly 10s ago
    const id = await enrolled(t0);
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(clock.iso());
  });

  it("corrects a null or unparsable watermark to the poll time", async () => {
    await fresh();
    const idNull = await enrolled(null);
    await coordinator.poll(TOKEN, {});
    expect((await getRow(idNull))!.lastSeen).toBe(clock.iso());
  });

  it("corrects garbage watermarks; a WITHIN-SLACK future stamp reads as fresh (monotonic, never written back)", async () => {
    await fresh();
    const id = await enrolled("not-a-timestamp");
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(clock.iso());

    // A within-slack future stamp (here +60s, inside the 5min window) reads
    // as FRESH: the monotonic guard forbids writing it backwards; it goes
    // stale naturally as real time catches up.
    const future = new Date(clock.now().getTime() + 60_000).toISOString();
    await db.update(machines).set({ lastSeen: future }).where(eq(machines.id, id));
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(future);
  });

  it("repairs an ANOMALOUS far-future watermark (beyond the skew window) to the poll time — the one legal downward write", async () => {
    await fresh();
    const id = await enrolled(new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString()); // +1h ≫ slack
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(clock.iso());
  });

  it("pins the skew-window boundary: exactly at the slack is legal (fresh), one ms beyond is anomalous (repaired)", async () => {
    await fresh();
    const id = await enrolled(clock.iso());

    // At exactly +SLACK: legal domain — stays fresh, untouched.
    const atSlack = new Date(clock.now().getTime() + HEARTBEAT_SKEW_SLACK_MS).toISOString();
    await db.update(machines).set({ lastSeen: atSlack }).where(eq(machines.id, id));
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(atSlack);

    // One ms beyond: anomalous — repaired to the poll time.
    const beyond = new Date(clock.now().getTime() + HEARTBEAT_SKEW_SLACK_MS + 1).toISOString();
    await db.update(machines).set({ lastSeen: beyond }).where(eq(machines.id, id));
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(clock.iso());
  });

  it("inverse-order pollution repairs NEVER regress: the older poll's CAS misses and it re-decides (二次审核 P1)", async () => {
    await fresh();
    const polluted = new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString(); // +1h ≫ slack
    const id = await enrolled(polluted);
    // Both polls read the SAME polluted snapshot before either commits.
    const staleSnapshot = (await getRow(id))!;

    // The NEWER-clocked poll (T2 = T1 + 5s) repairs first → watermark = T2.
    const newerClock = new FakeClock(clock.now().getTime() + 5_000);
    await applyMachinePollContact({ db, clock: newerClock }, staleSnapshot, {});
    expect((await getRow(id))!.lastSeen).toBe(newerClock.iso());

    // The OLDER-clocked poll (T1) commits SECOND against the stale snapshot:
    // its CAS on the observed polluted value misses, it re-reads, and now sees
    // T2 — a WITHIN-SLACK future value → fresh → NO write. No regression.
    await applyMachinePollContact({ db, clock }, staleSnapshot, {});
    expect((await getRow(id))!.lastSeen).toBe(newerClock.iso());
  });

  it("fails explicitly when bounded CAS contention cannot preserve this Poll's identity", async () => {
    await fresh();
    const polluted = new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString();
    const id = await enrolled(polluted);
    const staleSnapshot = (await getRow(id))!;

    // A real PostgreSQL trigger makes the first three UPDATE statements affect
    // zero rows. This deterministically drives the bounded retry exhaustion
    // branch without mocking Drizzle or the store's internal helpers.
    await db.execute(sql`CREATE TEMP TABLE machine_contact_cas_gate (remaining integer NOT NULL)`);
    await db.execute(sql`INSERT INTO machine_contact_cas_gate (remaining) VALUES (3)`);
    await db.execute(sql`
      CREATE FUNCTION skip_first_three_machine_contact_updates() RETURNS trigger AS $$
      DECLARE remaining_attempts integer;
      BEGIN
        SELECT remaining INTO remaining_attempts FROM machine_contact_cas_gate;
        IF remaining_attempts > 0 THEN
          UPDATE machine_contact_cas_gate SET remaining = remaining - 1;
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER skip_machine_contact_updates
      BEFORE UPDATE ON machines
      FOR EACH ROW EXECUTE FUNCTION skip_first_three_machine_contact_updates()
    `);

    await expect(
      applyMachinePollContact({ db, clock }, staleSnapshot, { host: "new-host", version: "0.2.0" }),
    ).rejects.toMatchObject({ name: "MachineContactContentionError" });
    expect(await getRow(id)).toMatchObject({ hostname: "old-host", daemonVersion: null, lastSeen: polluted });
  });

  it("never regresses under skewed clocks: a later stamp survives an earlier-clocked poll", async () => {
    await fresh();
    const id = await seedMachineForToken(db, TOKEN, { lastSeen: null });
    // First poll at T+20s stamps T+20s.
    const ahead = createRunCoordinator(testDeps(db, new FakeClock(clock.now().getTime() + 20_000)));
    await ahead.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(new Date(clock.now().getTime() + 20_000).toISOString());
    // A poll on the behind-clock coordinator must NOT drag the watermark back.
    await coordinator.poll(TOKEN, {});
    expect((await getRow(id))!.lastSeen).toBe(new Date(clock.now().getTime() + 20_000).toISOString());
  });

  it("merges an identity change and the watermark refresh into one update; never overwrites a friendly name", async () => {
    await fresh();
    const id = await enrolled(clock.iso()); // fresh watermark
    await coordinator.poll(TOKEN, { host: "new-host", version: "0.2.0" });
    const row = await getRow(id);
    expect(row).toMatchObject({ hostname: "new-host", daemonVersion: "0.2.0", name: "friendly" });
  });

  it("keeps old identity values for unreported (blank) fields", async () => {
    await fresh();
    const id = await enrolled(clock.iso());
    await coordinator.poll(TOKEN, { host: "  ", platform: "", arch: "\0" });
    expect(await getRow(id)).toMatchObject({ hostname: "old-host", platform: null, arch: null });
  });

  it("fills an EMPTY name from a valid hostname, exactly once", async () => {
    await fresh();
    const id = await seedMachineForToken(db, TOKEN, { name: "", lastSeen: clock.iso() });
    await coordinator.poll(TOKEN, { host: "first-host" });
    expect((await getRow(id))!.name).toBe("first-host");
    // Once named, later hosts never overwrite it.
    await coordinator.poll(TOKEN, { host: "second-host" });
    expect((await getRow(id))!).toMatchObject({ name: "first-host", hostname: "second-host" });
  });
});

describe("AD2(b): poll distributes watch and gates artifact claims (Batch 2 slice 2, ADR-010 决策 22)", () => {
  const CAPABLE = ["terminal-journal-v1", "artifact-sync-v1"];

  it("a machine WITHOUT artifact-sync-v1 keeps the Batch 1 idle shape — watchDigest or not", async () => {
    await fresh();
    await seedMachineForToken(db, TOKEN);
    // The watch configuration is only distributed to machines that declared
    // the capability: an old daemon's response stays byte-identical.
    await expect(coordinator.poll(TOKEN, { watchDigest: "w-1" })).resolves.toEqual({ deliveries: [] });
    await expect(coordinator.poll(TOKEN, {})).resolves.toEqual({ deliveries: [] });
  });

  it("a capable machine on drift receives the FULL watch set + digest; a matching digest carries neither key", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      artifactDir: "/data/out",
      workdir: "/home/dev/project",
      artifactConfigRevision: 3,
    });
    // The configured loop belongs to THIS machine (unlike the old guard's
    // fixture) — the watch set is machine-scoped.
    const item = {
      loopId: "loop-1",
      artifactDir: "/data/out",
      workdir: "/home/dev/project",
      roots: [] as string[],
      configRevision: 3,
    };
    const digest = watchConfigDigest([item]);

    // No digest = the empty-set digest ⇒ drift ⇒ the complete set.
    await expect(coordinator.poll(TOKEN, { capabilities: CAPABLE })).resolves.toEqual({
      deliveries: [],
      watch: [item],
      watchDigest: digest,
    });
    // Matching digest ⇒ no update (both keys absent).
    await expect(coordinator.poll(TOKEN, { capabilities: CAPABLE, watchDigest: digest })).resolves.toEqual({
      deliveries: [],
    });
  });

  it("clearing the last configured loop sends watch: [] on drift — the clear-all payload", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1", machineId, artifactDir: "/data/out", artifactConfigRevision: 1 });
    await coordinator.poll(TOKEN, { capabilities: CAPABLE }); // declares the capability

    await db.update(loops).set({ artifactDir: null, artifactConfigRevision: 2 }).where(eq(loops.id, "loop-1"));
    const result = await coordinator.poll(TOKEN, { capabilities: CAPABLE, watchDigest: "stale-digest" });
    expect(result).toEqual({ deliveries: [], watch: [], watchDigest: watchConfigDigest([]) });
  });

  it("busy polls (availableSlots 0) process watchDigest too — watch is not run dispatch", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1", machineId, artifactDir: "/data/out", artifactConfigRevision: 1 });
    const result = await coordinator.poll(TOKEN, { capabilities: CAPABLE, availableSlots: 0 });
    expect(result.deliveries).toEqual([]);
    expect(result.watch).toEqual([
      { loopId: "loop-1", artifactDir: "/data/out", workdir: null, roots: [], configRevision: 1 },
    ]);
    expect(result.watchDigest).toBeDefined();
  });

  it("an UNCONFIGURED loop stays claimable without the capability", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/home/dev/TASK.md" });
    await seedRun(db, { id: "run-1", machineId });

    const result = await coordinator.poll(TOKEN, { capabilities: ["terminal-journal-v1"] });
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]!.runId).toBe("run-1");
    expect(result.deliveries[0]!.loop).not.toHaveProperty("artifact");
  });

  it("a configured candidate is skipped without the capability — and never blocks the other candidate", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-a", machineId, artifactDir: "/data/out", artifactConfigRevision: 3 });
    await seedLoop(db, { id: "loop-b", machineId, taskFile: "/home/dev/TASK.md" });
    await seedRun(db, { id: "run-configured", machineId, loopId: "loop-a", ts: "2026-07-01T00:00:00.000Z" });
    await seedRun(db, { id: "run-plain", machineId, loopId: "loop-b", ts: "2026-07-01T00:00:01.000Z" });

    const result = await coordinator.poll(TOKEN, { capabilities: ["terminal-journal-v1"] });
    // The configured candidate is skipped; the unconfigured one still delivers.
    expect(result.deliveries.map((d) => d.runId)).toEqual(["run-plain"]);
    expect(await snapshotRuns(db)).toMatchObject([
      { id: "run-configured", phase: "pending" },
      { id: "run-plain", phase: "running" },
    ]);
    expect((await snapshotLeases(db)).map((l) => l.runId)).toEqual(["run-plain"]);
  });

  it("a capable machine claims the configured loop and the Delivery carries the artifact config", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-a", machineId, artifactDir: "/data/out", artifactConfigRevision: 5 });
    await seedRun(db, { id: "run-1", machineId, loopId: "loop-a" });

    const result = await coordinator.poll(TOKEN, { capabilities: CAPABLE });
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]!.loop.artifact).toEqual({ dir: "/data/out", configRevision: 5 });
  });

  it("a config write between the scan and the claim is caught by the claim's authoritative re-check", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1", machineId, taskFile: "/t/TASK.md" });
    await seedRun(db, { id: "run-1", machineId });
    let hooked = false;
    coordinator = createRunCoordinator(
      testDeps(db, clock, {
        hooks: {
          async beforeClaimTx() {
            if (hooked) return;
            hooked = true;
            // The scan-side hint saw an UNCONFIGURED loop; this write lands
            // before the claim resolves it authoritatively.
            await db
              .update(loops)
              .set({ artifactDir: "/data/out", artifactConfigRevision: 1 })
              .where(eq(loops.id, "loop-1"));
          },
        },
      }),
    );

    const result = await coordinator.poll(TOKEN, { capabilities: ["terminal-journal-v1"] });
    expect(result.deliveries).toEqual([]);
    // The claim refused BEFORE opening its transaction: pending, no lease.
    expect(await snapshotRuns(db)).toMatchObject([{ id: "run-1", phase: "pending" }]);
    expect(await snapshotLeases(db)).toEqual([]);
  });
});
