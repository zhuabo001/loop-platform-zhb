/**
 * The terminal-policy legal domain must never exceed
 * the database's WRITABLE domain. This file pins the agreement in BOTH
 * directions against a real PGlite instance:
 *
 *  - every string PG jsonb/text cannot store verbatim (NUL, unpaired UTF-16
 *    surrogates) is rejected by the policy, and
 *  - every policy-ACCEPTED state/content round-trips through the real
 *    jsonb/text columns bit-for-bit — a Batch 2 write-plan built from policy
 *    output can never fail at the write step.
 */
import { afterEach, describe, expect, it } from "vitest";

import { reportRequestSchema, validateTaskFileSyncResult, validateTerminalState } from "@loopzhb/protocol";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./index.js";
import { loops, type Run } from "./schema.js";
import {
  planReportWrites,
  type LeaseAuthSnapshot,
  type LoopReportSnapshot,
} from "../loop-lifecycle/index.js";
import { seedLoop } from "../testkit/index.js";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

async function fresh(): Promise<{ db: Db; handle: DbHandle }> {
  const handle = await openMigratedDb();
  handles.push(handle);
  await seedLoop(handle.db, { id: "loop-1" });
  return { db: handle.db, handle };
}

describe("the PG side: jsonb/text reject exactly what the policy rejects", () => {
  it("jsonb rejects NUL escapes and unpaired surrogates in string values and keys", async () => {
    const { handle } = await fresh();
    const rejectedJsonTexts = [
      '{"x":"a\\u0000b"}', // NUL escape inside a value
      '{"x":"\\ud800"}', // lone high surrogate
      '{"x":"\\udc00"}', // lone low surrogate
      '{"k\\u0000":1}', // NUL escape inside a KEY
    ];
    for (const jsonText of rejectedJsonTexts) {
      await expect(
        handle.client.query("SELECT $1::jsonb", [jsonText]),
        jsonText,
      ).rejects.toThrow();
    }
  });

  it("text rejects NUL", async () => {
    const { handle } = await fresh();
    await expect(handle.client.query("SELECT $1::text", ["a\0b"])).rejects.toThrow();
  });

  it("…and the policy rejects the same values BEFORE the database ever sees them", () => {
    for (const state of [{ x: "a\0b" }, { x: "\uD800" }, { x: "\uDC00" }, { "k\0": 1 }]) {
      expect(validateTerminalState(state)).toEqual({ ok: false, failure: "not_json" });
    }
    expect(validateTaskFileSyncResult({ taskFileContent: "a\0b" })).toEqual({
      ok: false,
      failure: "content_not_representable",
    });
    expect(validateTaskFileSyncResult({ taskFileContent: "lone \uD800" })).toEqual({
      ok: false,
      failure: "content_not_representable",
    });
  });
});

describe("the writable direction: every policy-accepted value round-trips bit-for-bit", () => {
  const acceptedStates: unknown[] = [
    {},
    { plain: "ascii" },
    { multibyte: "é🚀", nested: { list: [1, "two", null, true, 1.5] } },
    { "é🚀 key": ["pair 🚀 ok"] },
    { controls: "line one\nline two\ttab \"quoted\"" },
    { deep: { a: { b: { c: [{ d: "é" }] } } } },
  ];

  it("policy-accepted states survive loops.state (jsonb) unchanged", async () => {
    const { db } = await fresh();
    for (const input of acceptedStates) {
      const result = validateTerminalState(input);
      if (!result.ok) throw new Error(`policy unexpectedly rejected ${JSON.stringify(input)}`);
      await db.update(loops).set({ state: result.state }).where(eq(loops.id, "loop-1"));
      const [row] = await db.select({ state: loops.state }).from(loops).where(eq(loops.id, "loop-1"));
      expect(row!.state).toEqual(result.state);
    }
  });

  it("policy-accepted task-file content survives the text column unchanged", async () => {
    const { db } = await fresh();
    const contents = ["", "# TASK\n", "é🚀 multibyte\n\t- item", "x".repeat(262_144)];
    for (const content of contents) {
      expect(validateTaskFileSyncResult({ taskFileContent: content }).ok).toBe(true);
      await db.update(loops).set({ taskFileContent: content }).where(eq(loops.id, "loop-1"));
      const [row] = await db
        .select({ taskFileContent: loops.taskFileContent })
        .from(loops)
        .where(eq(loops.id, "loop-1"));
      expect(row!.taskFileContent).toBe(content);
    }
  });
});

/**
 * A top-level `__proto__` own property is LEGAL state
 * content. Every stage of the v1 path must carry it verbatim — success that
 * silently drops a key is data corruption, not validation. This pins the
 * whole chain end to end: raw JSON text → wire schema → terminal policy →
 * report write-plan → real jsonb write/read.
 */
describe("special-key fidelity across the whole chain", () => {
  const LOOP_SNAPSHOT: LoopReportSnapshot = {
    goal: "g",
    goalRevision: 0,
    completedAt: null,
    completionReason: null,
    enabled: true,
    cron: null,
    timezone: "UTC",
    scheduleRevision: 0,
    state: null,
    taskFileContent: null,
    taskFileSyncedAt: null,
    taskFileSyncAttemptedAt: null,
    taskFileSyncError: null,
  };
  const LEASE: LeaseAuthSnapshot = { role: "exec", canFinish: false, goalRevision: 0, terminalProtocolVersion: 1 };
  const RUN: Run = {
    id: "run-1",
    loopId: "loop-1",
    machineId: "m-test",
    phase: "running",
    role: "exec",
    ts: "2026-08-30T23:59:00.000Z",
    outcome: null,
    status: null,
    message: null,
    durationMs: null,
    error: null,
    state: null,
    sessionId: null,
    costUsd: null,
    usage: null,
    artifacts: null,
    transcript: null,
    progress: { step: 1, label: "working", at: "2026-08-30T23:59:30.000Z" },
  };
  const BOTH_KEYS = ["__proto__", "keep"];

  it("raw JSON → wire → policy → planner → jsonb keeps a top-level __proto__ key verbatim", async () => {
    const { db } = await fresh();
    const bodyText =
      '{"ok":true,"terminal":{"kind":"report","status":"nothing-new",' +
      '"state":{"__proto__":{"marker":1},"keep":2}},"taskFileContent":"x"}';

    // 1. Wire: parses successfully AND the parsed state keeps both keys.
    const parsed = reportRequestSchema.safeParse(JSON.parse(bodyText));
    if (!parsed.success) throw new Error("wire must accept a legal __proto__ state");
    if (parsed.data.terminal?.kind !== "report") throw new Error("unreachable");
    const wireState = parsed.data.terminal.state as Record<string, unknown>;
    expect(Object.keys(wireState).sort()).toEqual(BOTH_KEYS);

    // 2. Policy: accepts AND the canonical clone keeps both keys.
    const policy = validateTerminalState(wireState);
    if (!policy.ok) throw new Error("policy must accept a legal __proto__ state");
    expect(Object.keys(policy.state).sort()).toEqual(BOTH_KEYS);

    // 3. Planner: the v1_success write-plan carries both keys.
    const plan = planReportWrites({
      loop: LOOP_SNAPSHOT,
      lease: LEASE,
      run: RUN,
      body: parsed.data,
      nowIso: "2026-08-31T00:00:00.000Z",
    });
    if (plan.kind !== "v1_success" || plan.loopWrites === null) {
      throw new Error(`planner must accept a legal __proto__ state, got ${plan.kind}`);
    }
    const plannedState = plan.loopWrites.state as Record<string, unknown>;
    expect(Object.keys(plannedState).sort()).toEqual(BOTH_KEYS);

    // 4. Database: the planned state round-trips through real jsonb verbatim.
    await db.update(loops).set({ state: plannedState }).where(eq(loops.id, "loop-1"));
    const [row] = await db.select({ state: loops.state }).from(loops).where(eq(loops.id, "loop-1"));
    const stored = row!.state as Record<string, unknown>;
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.keys(stored).sort()).toEqual(BOTH_KEYS);
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true);
    expect(stored["__proto__"]).toEqual({ marker: 1 });
    expect(stored["keep"]).toBe(2);
  });
});
