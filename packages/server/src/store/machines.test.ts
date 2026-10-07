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
import { seedMachineForToken } from "../testkit/index.js";
import {
  classifyHeartbeatWatermark,
  heartbeatAgeMs,
  HEARTBEAT_SKEW_SLACK_MS,
  isHeartbeatWatermarkAnomalous,
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
