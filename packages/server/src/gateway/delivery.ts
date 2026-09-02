/**
 * Delivery assembly (plan §2, A-07). Pure functions — no DB, no clock — so the
 * exact prompt text is unit-testable without fixtures, and future prompt
 * evolution swaps ONLY this builder (never claim / lease / HTTP code).
 */
import type { Delivery } from "@loopzhb/protocol";

import type { Loop, Run } from "../db/schema.js";

/** The minimal one-pass exec instructions (A-07, locked text — golden-tested).
 *
 *  With a task file the agent reads and executes it; without one the delivery
 *  says so honestly (Phase 1's Fake Runner may still accept it; the Phase 2
 *  real-agent E2E requires a loop with a local taskFile). Every interpolated
 *  value is JSON-encoded so quotes/newlines/backticks in ids, names or paths
 *  can never break the template's line structure. The task NEVER advertises
 *  in-run verbs (`loopany report/finish`), evolve/edit, workflow, control or
 *  artifact semantics that Phase 1 doesn't honor.
 */
export function buildExecTask(loop: Pick<Loop, "id" | "name" | "taskFile">): string {
  const displayName = loop.name ?? loop.id;
  const lines = [
    "[loop run]",
    `Loop id: ${JSON.stringify(loop.id)}`,
    `Loop name: ${JSON.stringify(displayName)}`,
  ];
  if (loop.taskFile != null) {
    lines.push(`Read the task file first: ${JSON.stringify(loop.taskFile)}`, "Do the work it describes.");
  } else {
    lines.push("No task file is configured; this delivery has no real-agent task source.");
  }
  lines.push("Run once, then stop.");
  return lines.join("\n");
}

/** Assemble the full protocol Delivery for a claimed exec run.
 *
 *  Field sources (all pinned by test): `roots` is the polling machine's
 *  workdir allowlist ([] = unrestricted); `prevState` is the loop's workflow
 *  cursor (opaque passthrough); `systemPrompt` is EXACTLY "" in Phase 1; the
 *  DTO `name` falls back to the loop id when no friendly name is set. The
 *  wire `loop.allowControl` carries the REAL loop config — it is not a grant
 *  (the lease's all-false caps are the effective authority, ADR-003).
 *
 *  Phase 4 Batch 2 (ADR-009 决策 7): every new claim mints a v1 lease, so the
 *  Delivery carries `terminalProtocol: 1` and the loop's CURRENT goal — both
 *  from the claim transaction's authoritative loop snapshot. The `task` text
 *  stays the Phase 3 template (v0 golden unchanged): a v1 daemon builds its
 *  own prompt from the goal + task-file path + journal contract, and an old
 *  daemon simply strips the unknown fields (tolerant reader, ADR-002). */
export function buildDelivery(input: { loop: Loop; run: Run; roots: string[]; runToken: string }): Delivery {
  const { loop, run, roots, runToken } = input;
  return {
    runId: run.id,
    runToken,
    role: run.role,
    loop: {
      id: loop.id,
      name: loop.name || loop.id,
      workdir: loop.workdir ?? null,
      taskFile: loop.taskFile ?? null,
      workflow: loop.workflow ?? null,
      model: loop.model ?? null,
      allowControl: loop.allowControl,
      agent: loop.agent,
      goal: loop.goal ?? null,
    },
    prevState: loop.state ?? null,
    roots,
    systemPrompt: "",
    task: buildExecTask(loop),
    terminalProtocol: 1,
  };
}
