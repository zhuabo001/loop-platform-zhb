import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  CODING_AGENTS,
  codingAgentSchema,
  LEASE_STATES,
  leaseStateSchema,
  NOTIFY_POLICIES,
  notifyPolicySchema,
  RUN_OUTCOMES,
  runOutcomeSchema,
  RUN_PHASES,
  runPhaseSchema,
  RUN_ROLES,
  runRoleSchema,
  RUN_STATUSES,
  runStatusSchema,
} from "./enums.js";

/**
 * Pins the exact wire value lists — an accidental edit (rename / reorder /
 * drop) fails here. Widening is allowed (append + this list grows), matching
 * ADR-002's "enums only grow" rule: these tests assert TODAY's set is present,
 * so an additive change updates the list deliberately, in one place.
 */
const CASES: ReadonlyArray<readonly [string, readonly string[], z.ZodType<string>]> = [
  ["RUN_PHASES", RUN_PHASES, runPhaseSchema],
  ["RUN_ROLES", RUN_ROLES, runRoleSchema],
  ["RUN_OUTCOMES", RUN_OUTCOMES, runOutcomeSchema],
  ["RUN_STATUSES", RUN_STATUSES, runStatusSchema],
  ["LEASE_STATES", LEASE_STATES, leaseStateSchema],
  ["CODING_AGENTS", CODING_AGENTS, codingAgentSchema],
  ["NOTIFY_POLICIES", NOTIFY_POLICIES, notifyPolicySchema],
];

const PINNED: Record<string, readonly string[]> = {
  RUN_PHASES: ["pending", "running", "done", "error", "canceled"],
  RUN_ROLES: ["exec", "evolve", "edit"],
  RUN_OUTCOMES: ["silent", "direct", "exec", "error", "evolve", "skipped"],
  RUN_STATUSES: ["new", "resolved", "nothing-new"],
  LEASE_STATES: ["active", "terminal-grace"],
  CODING_AGENTS: ["claude-code", "codex", "grok"],
  NOTIFY_POLICIES: ["always", "auto", "never"],
};

describe("wire enums", () => {
  for (const [name, values, schema] of CASES) {
    it(`${name} matches its pinned value list`, () => {
      expect([...values]).toEqual(PINNED[name]);
    });
    it(`${name} schema accepts every value, rejects unknown`, () => {
      for (const v of values) expect(schema.parse(v)).toBe(v);
      expect(() => schema.parse("bogus")).toThrow();
      expect(() => schema.parse("")).toThrow();
    });
  }
});
