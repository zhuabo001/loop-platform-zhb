/**
 * Consumer-side heartbeat watermark semantics (the 2026-07-30 A-13 ruling):
 * presence/sweep MUST classify through these pure helpers — an anomalous
 * far-future watermark is pollution, never proof of life, and the SAME skew
 * window the write side repairs by. (No consumer exists yet in Phase 1; the
 * helpers land the semantics structurally so Day 8–10 inherits them.)
 */
import { afterEach, describe, expect, it } from "vitest";

import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import { seedMachineForToken, TEST_TEAM_ID } from "../testkit/index.js";
import {
  classifyHeartbeatWatermark,
  heartbeatAgeMs,
  HEARTBEAT_SKEW_SLACK_MS,
  isHeartbeatWatermarkAnomalous,
  verifyEligibleMachineCredential,
  verifyMachineCredential,
} from "./machines.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("isHeartbeatWatermarkAnomalous", () => {
  it("is false at exactly the slack and true one ms beyond", () => {
    expect(isHeartbeatWatermarkAnomalous(NOW + HEARTBEAT_SKEW_SLACK_MS, NOW)).toBe(false);
    expect(isHeartbeatWatermarkAnomalous(NOW + HEARTBEAT_SKEW_SLACK_MS + 1, NOW)).toBe(true);
  });
});

describe("classifyHeartbeatWatermark", () => {
  it("classifies the four domains", () => {
    expect(classifyHeartbeatWatermark(null, NOW)).toBe("absent");
    expect(classifyHeartbeatWatermark("not-a-timestamp", NOW)).toBe("invalid");
    expect(classifyHeartbeatWatermark(at(HEARTBEAT_SKEW_SLACK_MS + 1), NOW)).toBe("anomalous-future");
    expect(classifyHeartbeatWatermark(at(-30_000), NOW)).toBe("valid"); // past
    expect(classifyHeartbeatWatermark(at(60_000), NOW)).toBe("valid"); // within-slack future
    expect(classifyHeartbeatWatermark(at(HEARTBEAT_SKEW_SLACK_MS), NOW)).toBe("valid"); // boundary
  });
});

describe("heartbeatAgeMs — liveness evidence for presence/sweep", () => {
  it("returns the real age for a past watermark", () => {
    expect(heartbeatAgeMs(at(-30_000), NOW)).toBe(30_000);
  });

  it("clamps a within-slack future watermark to 0 (just seen)", () => {
    expect(heartbeatAgeMs(at(60_000), NOW)).toBe(0);
  });

  it("returns null for absent/invalid/anomalous — NO liveness evidence", () => {
    expect(heartbeatAgeMs(null, NOW)).toBeNull();
    expect(heartbeatAgeMs("garbage", NOW)).toBeNull();
    // The poisoned-then-silent machine: pollution is not "online forever".
    expect(heartbeatAgeMs(at(24 * 60 * 60 * 1000), NOW)).toBeNull();
  });
});

// AH4 (Batch 2 slice 2): the existing-machine-only auth read path the artifact
// routes use. Poll keeps its own register-on-first-contact flow; this seam
// NEVER registers — an unknown token must leave the machines table untouched.
describe("verifyMachineCredential — existing machines only, never registering", () => {
  const handles: DbHandle[] = [];
  const TOKEN = "dk_credential_probe_1";
  const OTHER = "dk_credential_probe_2";

  afterEach(async () => {
    for (const handle of handles.splice(0)) await closeDb(handle);
  });

  async function fresh(): Promise<Db> {
    const handle = await openMigratedDb();
    handles.push(handle);
    return handle.db;
  }

  const rows = (db: Db) => db.select().from(machines);

  it("returns the seeded row for its token — read-only", async () => {
    const db = await fresh();
    const id = await seedMachineForToken(db, TOKEN);
    const before = await rows(db);
    const machine = await verifyMachineCredential(db, TOKEN);
    expect(machine?.id).toBe(id);
    expect(machine?.id).toBe(machineIdFromToken(TOKEN));
    expect(await rows(db)).toEqual(before);
  });

  it("an unknown (but well-shaped) token is undefined and registers NOTHING", async () => {
    const db = await fresh();
    const before = await rows(db);
    expect(before).toEqual([]);
    expect(await verifyMachineCredential(db, OTHER)).toBeUndefined();
    expect(await rows(db)).toEqual(before); // zero writes — poll is the only enroll surface
  });

  it("a row at the derived id under a DIFFERENT hash is refused (full-hash check)", async () => {
    const db = await fresh();
    // The truncated-id collision shape: the row exists, the credential does not.
    await db.insert(machines).values({
      id: machineIdFromToken(TOKEN),
      name: "",
      tokenHash: "not-the-real-hash",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await verifyMachineCredential(db, TOKEN)).toBeUndefined();
  });

  it("ill-shaped tokens never reach the DB", async () => {
    const db = await fresh();
    await seedMachineForToken(db, TOKEN);
    for (const token of ["", "dk", "dk_x", "bearer x", `dk_${"a".repeat(121)}`]) {
      expect(await verifyMachineCredential(db, token), token).toBeUndefined();
    }
  });
});

// ---- verifyEligibleMachineCredential (PG3–PG5b) ----
//
// Five-step gate: shape → derived-id → full-hash → teamId (claimed) →
// revokedAt (active). All failure reasons collapse to undefined — no signal
// leakage. Tests at the pure store layer; the HTTP 401 mapping is end-to-end.

describe("verifyEligibleMachineCredential — machine gate (PG3–PG5b)", () => {
  const TOKEN = "dk_test_elig_alpha";
  const TEAM_ID = TEST_TEAM_ID;

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

  it("PG3: unknown token (no row) → undefined, zero writes", async () => {
    await fresh();
    const before = await db.select().from(machines);
    expect(await verifyEligibleMachineCredential(db, TOKEN)).toBeUndefined();
    expect(await db.select().from(machines)).toEqual(before);
  });

  it("PG4: full-hash mismatch → undefined (collision defence)", async () => {
    await fresh();
    await db.insert(machines).values({
      id: machineIdFromToken(TOKEN),
      name: "",
      tokenHash: "not-the-real-hash",
      teamId: TEAM_ID,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await verifyEligibleMachineCredential(db, TOKEN)).toBeUndefined();
  });

  it("PG5: valid hash but teamId IS NULL (unclaimed) → undefined", async () => {
    await fresh();
    await seedMachineForToken(db, TOKEN); // no teamId override → null
    expect(await verifyEligibleMachineCredential(db, TOKEN)).toBeUndefined();
  });

  it("PG5b: valid hash, teamId set, but revokedAt IS NOT NULL → undefined", async () => {
    await fresh();
    await seedMachineForToken(db, TOKEN, { teamId: TEAM_ID, revokedAt: "2026-07-01T00:00:00.000Z" });
    expect(await verifyEligibleMachineCredential(db, TOKEN)).toBeUndefined();
  });

  it("PG6: valid hash + teamId + revokedAt null → returns the row", async () => {
    await fresh();
    await seedMachineForToken(db, TOKEN, { teamId: TEAM_ID });
    const result = await verifyEligibleMachineCredential(db, TOKEN);
    expect(result).not.toBeUndefined();
    expect(result!.teamId).toBe(TEAM_ID);
    expect(result!.revokedAt).toBeNull();
  });

  it("PG2: ill-shaped tokens never reach the DB", async () => {
    await fresh();
    await seedMachineForToken(db, TOKEN, { teamId: TEAM_ID });
    for (const bad of ["", "dk", "dk_x", "bearer x", `dk_${"a".repeat(121)}`]) {
      expect(await verifyEligibleMachineCredential(db, bad), bad).toBeUndefined();
    }
  });
});
