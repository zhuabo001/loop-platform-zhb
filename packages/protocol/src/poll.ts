/**
 * Poll: POST /api/machine/poll — the daemon's heartbeat + run claim.
 *
 * Auth rides the `Authorization: Bearer <dk_…>` header; the body carries NO
 * credential. The body is FLAT and every field is optional — mirrors the
 * reference (loop-platform packages/daemon/src/daemon.ts `buildPollBody`,
 * packages/server/src/routes/api.machine.poll.ts:17-27).
 *
 * Evolution notes (ADR-002): `watchDigest` (artifact-sync echo) joins in
 * Phase 3 as an additive optional field; unknown keys are stripped on parse,
 * so a newer peer's extra fields never break an older reader.
 */
import { z } from "zod";

import { codingAgentSchema, runRoleSchema } from "./enums.js";
import { runTokenSchema } from "./tokens.js";

/** Live "what's it doing" line for one in-flight run (the server stamps `at`). */
export const runProgressSchema = z.object({
  runId: z.string(),
  step: z.number().int().nonnegative(),
  label: z.string(),
});
export type RunProgress = z.infer<typeof runProgressSchema>;

export const pollRequestSchema = z.object({
  /** os.hostname() — machine identity hint (also the fallback machine name). */
  host: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  /** Daemon package version — drives the fleet's "update available" hint. */
  version: z.string().optional(),
  /** One entry per in-flight run; absent/empty when idle. */
  progress: z.array(runProgressSchema).optional(),
  /** Long-poll opt-in — only ever SENT as true, and only while idle (a run in
   *  flight keeps the short ~3s cadence so the progress heartbeat flows). Old
   *  servers ignore it and answer instantly; both sides degrade gracefully. */
  wait: z.literal(true).optional(),
});
export type PollRequest = z.infer<typeof pollRequestSchema>;

/** The loop's machine-side config, as a run needs to execute it. */
export const deliveryLoopSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Machine-side cwd; null ⇒ daemon picks a scratch dir. */
  workdir: z.string().nullable(),
  taskFile: z.string().nullable(),
  /** Zero-LLM pre-filter JS, run on the machine before escalating to the agent. */
  workflow: z.string().nullable(),
  model: z.string().nullable(),
  allowControl: z.boolean(),
  /** Coding agent to execute with. OPTIONAL on the wire: an old server omits
   *  it and the daemon defaults to claude-code. */
  agent: codingAgentSchema.optional(),
});
export type DeliveryLoop = z.infer<typeof deliveryLoopSchema>;

/** Everything the daemon needs to run one loop tick.
 *  Mirrors loop-platform packages/server/src/gateway/delivery.ts:17-41. */
export const deliverySchema = z.object({
  runId: z.string(),
  /** The run-lease wire token (`rk_…`) minted at claim time (shape-checked). */
  runToken: runTokenSchema,
  role: runRoleSchema,
  loop: deliveryLoopSchema,
  /** Workflow cursor (loop.state) passed back as the gate's `prev`. */
  prevState: z.unknown(),
  /** Server-configured workdir jail ([] = unrestricted; may only NARROW the
   *  daemon's local LOOPANY_ROOTS). */
  roots: z.array(z.string()),
  /** Empty string on the current server (instructions live in `task`); the
   *  daemon skips the sys-prompt file + flag when empty. */
  systemPrompt: z.string(),
  /** The full first-user-turn instructions. */
  task: z.string(),
});
export type Delivery = z.infer<typeof deliverySchema>;

export const pollResponseSchema = z.object({
  deliveries: z.array(deliverySchema),
});
export type PollResponse = z.infer<typeof pollResponseSchema>;
