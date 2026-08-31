/**
 * Review A-2 regression: the terminal-policy legal domain must never exceed
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

import { validateTaskFileSyncResult, validateTerminalState } from "@loopzhb/protocol";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "./index.js";
import { loops } from "./schema.js";
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
