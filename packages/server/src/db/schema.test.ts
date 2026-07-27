import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODING_AGENTS,
  LEASE_STATES,
  RUN_OUTCOMES,
  RUN_PHASES,
  RUN_ROLES,
  RUN_STATUSES,
} from "@loopzhb/protocol";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./index.js";
import { loops, machines, runLeases, runs, type NewRun } from "./schema.js";

const handles: DbHandle[] = [];
let db: Db;

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

/** Fresh migrated in-memory db per test; also seeds one machine + one loop so
 *  run/lease fixtures can reference them (no FKs, but keep fixtures honest). */
async function seeded(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  await db.insert(machines).values({
    id: "m-test",
    name: "",
    tokenHash: "deadbeef",
    createdAt: "2026-07-27T00:00:00.000Z",
  });
  await db.insert(loops).values({
    id: "loop-1",
    machineId: "m-test",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
}

const RUN_FIXTURE = {
  id: "run-1",
  loopId: "loop-1",
  machineId: "m-test",
  phase: "pending",
  role: "exec",
  ts: "2026-07-27T00:00:00.000Z",
} as const;

describe("enum pins — the DB can never drift from the protocol single source", () => {
  // The drizzle enum config is fed by SPREADING the protocol's const arrays, so
  // identity holds by construction; these pins make a future "helpful" inline
  // re-declaration fail loudly instead of silently forking the value list.
  it("runs.phase/role/outcome/status mirror the protocol lists exactly", () => {
    expect(runs.phase.enumValues).toEqual([...RUN_PHASES]);
    expect(runs.role.enumValues).toEqual([...RUN_ROLES]);
    expect(runs.outcome.enumValues).toEqual([...RUN_OUTCOMES]);
    expect(runs.status.enumValues).toEqual([...RUN_STATUSES]);
  });

  it("loops.agent and run_leases.role/state mirror the protocol lists exactly", () => {
    expect(loops.agent.enumValues).toEqual([...CODING_AGENTS]);
    expect(runLeases.role.enumValues).toEqual([...RUN_ROLES]);
    expect(runLeases.state.enumValues).toEqual([...LEASE_STATES]);
  });
});

describe("round-trips", () => {
  it("machines: full row incl. jsonb roots", async () => {
    await seeded();
    const row = {
      id: "m-full",
      name: " workstation ",
      hostname: "mbp",
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "0.1.0",
      tokenHash: "cafe",
      roots: ["/Users/x/work", "/Users/x/play"],
      lastSeen: "2026-07-27T01:00:00.000Z",
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    await db.insert(machines).values(row);
    const back = await db.select().from(machines);
    expect(back.find((m) => m.id === "m-full")).toEqual(row);
  });

  it("loops: defaults apply (allowControl/agent/enabled), jsonb state round-trips", async () => {
    await seeded();
    const [back] = await db
      .insert(loops)
      .values({
        id: "loop-2",
        machineId: "m-test",
        state: { cursor: 3, seen: ["a", "b"] },
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      })
      .returning();
    expect(back!.allowControl).toBe(true);
    expect(back!.agent).toBe("claude-code");
    expect(back!.enabled).toBe(true);
    expect(back!.state).toEqual({ cursor: 3, seen: ["a", "b"] });
    expect(back!.taskFileContent).toBeNull();
  });

  it("runs: full finalize payload round-trips through the jsonb columns", async () => {
    await seeded();
    const row: NewRun = {
      ...RUN_FIXTURE,
      phase: "done",
      outcome: "exec",
      status: "new",
      message: "fixed the flaky test",
      durationMs: 61234,
      state: { score: 87, note: "up" },
      sessionId: "sess-abc",
      costUsd: 0.42,
      usage: { inputTokens: 1200, outputTokens: 300, attempts: 2 },
      artifacts: [{ path: "src/x.ts", kind: "edited" as const }],
      transcript: [{ kind: "text" as const, text: "done" }],
      progress: null,
    };
    await db.insert(runs).values(row);
    const [back] = await db.select().from(runs);
    expect(back).toEqual(expect.objectContaining(row));
    expect(back!.costUsd).toBeCloseTo(0.42);
  });

  it("run_leases: defaults are the safe caps; expiresAt null encodes active/Infinity", async () => {
    await seeded();
    const [back] = await db
      .insert(runLeases)
      .values({
        tokenHash: "hash-of-rk",
        runId: "run-1",
        loopId: "loop-1",
        machineId: "m-test",
        role: "exec",
        createdAt: "2026-07-27T00:00:00.000Z",
      })
      .returning();
    expect(back!.state).toBe("active");
    expect(back!.expiresAt).toBeNull(); // active ⇒ no expiry (the sweep, not the lease, guards a vanished machine)
    expect(back!.allowControl).toBe(false);
    expect(back!.canSetUi).toBe(false);
    expect(back!.canSetSchema).toBe(false);
    expect(back!.canSetWorkflow).toBe(false);
    expect(back!.canFinish).toBe(false);
  });

  it("run_leases: a terminalized lease carries a bounded ISO expiry", async () => {
    await seeded();
    await db.insert(runLeases).values({
      tokenHash: "hash-of-rk",
      runId: "run-1",
      loopId: "loop-1",
      machineId: "m-test",
      role: "exec",
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const grace = "2026-07-28T00:00:00.000Z";
    await db
      .update(runLeases)
      .set({ state: "terminal-grace", expiresAt: grace })
      .where(eq(runLeases.tokenHash, "hash-of-rk"));
    const [back] = await db.select().from(runLeases);
    expect(back!.state).toBe("terminal-grace");
    expect(back!.expiresAt).toBe(grace);
  });
});

describe("constraints that ARE the heart semantics", () => {
  it("runs.ts is NOT NULL and re-stampable (last-transition time, not createdAt)", async () => {
    await seeded();
    await db.insert(runs).values(RUN_FIXTURE);
    const claimed = "2026-07-27T00:00:05.000Z";
    // The atomic-claim shape: conditional UPDATE … WHERE phase='pending'.
    const won = await db
      .update(runs)
      .set({ phase: "running", ts: claimed })
      .where(and(eq(runs.id, "run-1"), eq(runs.phase, "pending")))
      .returning();
    expect(won).toHaveLength(1);
    expect(won[0]!.ts).toBe(claimed);
    // A second concurrent claim loses — the row is no longer pending.
    const lost = await db
      .update(runs)
      .set({ phase: "running" })
      .where(and(eq(runs.id, "run-1"), eq(runs.phase, "pending")))
      .returning();
    expect(lost).toHaveLength(0);
  });

  it("declares NO foreign keys (cascades are a store-layer concern — ADR-003)", async () => {
    await seeded();
    const h = handles[0]!;
    const { rows } = await h.client.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where connamespace = 'public'::regnamespace and contype = 'f'",
    );
    expect(rows[0]!.n).toBe(0);
  });
});
