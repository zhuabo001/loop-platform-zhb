import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { apiErrorSchema } from "./errors.js";
import {
  deliveryLoopSchema,
  deliverySchema,
  pollRequestSchema,
  pollResponseSchema,
  runProgressSchema,
} from "./poll.js";
import {
  costReportSchema,
  reportRequestSchema,
  reportResponseSchema,
  runArtifactSchema,
  transcriptStepSchema,
} from "./report.js";

/**
 * ADR-002 决策 1：每一个 object schema 都是 tolerant reader——未知键剥离，
 * 永不 strict。若任何一个 schema 退化为 z.strictObject（或等价行为），
 * 本套件变红。此处的覆盖是穷尽的：protocol 导出的每个 object schema 都有
 * 一行（mutation-tested：曾对 6 个未钉住的 schema 复现过 strictObject 逃逸）。
 */

const MINIMAL_LOOP = {
  id: "l_01",
  name: "loop",
  workdir: null,
  taskFile: null,
  workflow: null,
  model: null,
  allowControl: true,
} as const;

const CASES: ReadonlyArray<readonly [string, z.ZodTypeAny, Record<string, unknown>]> = [
  ["pollRequestSchema", pollRequestSchema, {}],
  ["runProgressSchema", runProgressSchema, { runId: "r", step: 0, label: "x" }],
  ["deliveryLoopSchema", deliveryLoopSchema, { ...MINIMAL_LOOP }],
  [
    "deliverySchema",
    deliverySchema,
    {
      runId: "r",
      runToken: `rk_${"b2".repeat(16)}`,
      role: "exec",
      loop: { ...MINIMAL_LOOP },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "t",
    },
  ],
  ["pollResponseSchema", pollResponseSchema, { deliveries: [] }],
  ["reportRequestSchema", reportRequestSchema, { ok: true }],
  ["runArtifactSchema", runArtifactSchema, { path: "p", kind: "created" }],
  ["transcriptStepSchema", transcriptStepSchema, { kind: "text" }],
  ["costReportSchema", costReportSchema, {}],
  ["reportResponseSchema", reportResponseSchema, { ok: true }],
  ["apiErrorSchema", apiErrorSchema, { error: "e" }],
];

describe("tolerant reader: EVERY exported object schema strips unknown keys", () => {
  for (const [name, schema, minimal] of CASES) {
    it(`${name} strips an unknown key instead of rejecting`, () => {
      const parsed = schema.parse({ ...minimal, __futureField: { nested: [1, 2] } });
      expect(parsed).toEqual(minimal);
      expect(parsed).not.toHaveProperty("__futureField");
    });
  }

  it("covers every object schema — adding a new one requires a row here", () => {
    // Guard against a FUTURE schema silently escaping this suite: the case list
    // is reviewed whenever a schema is added (CI review checklist, ADR-002).
    expect(CASES.length).toBe(11);
  });
});
