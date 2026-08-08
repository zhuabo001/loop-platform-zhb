/**
 * Admin: the LOCAL management API wire contract — loop creation, manual
 * trigger, and the JSON observation surface (GET machines/loops/runs).
 *
 * Unlike the machine routes (poll/report), these DTOs are not mirrored from
 * the reference implementation: the reference's dashboard routes are entangled
 * with its auth model, and Phase 1 here is explicitly unauthenticated
 * (localhost / trusted network only — see docs/roadmap.md 部署边界). The
 * shapes are FIXED by docs/goal/day6-7-manual-trigger-json-observation.md §1;
 * a future CLI/Dashboard client (Phase 4) consumes them from this package, so
 * they live here under the same single-source discipline as the machine wire
 * (ADR-002) instead of being re-defined in the server.
 *
 * Two ADR-002 rules applied to this surface:
 *  - Tolerant reader (决策 1): every object schema strips unknown keys, never
 *    strict. Declared-but-not-yet-open fields (`workflow`/`model`/`agent`/
 *    `state`/`enabled`…) sent by a caller parse away and produce NO effect —
 *    镜像形状 ≠ 已支持语义 (决策 6).
 *  - Caps stay server-side (决策 4): the length ceilings (name 255 / path
 *    4096) are server policy enforced by the management module, NOT schema
 *    concerns. What the schema DOES pin is the malformed-at-boundary value
 *    domain (决策 4's recorded exception): machineId shape, non-empty and
 *    NUL-free strings — a legitimate caller never sends those.
 *
 * Timestamps are ISO strings. Response nullability is FIXED by these DTOs
 * (explicit null, never an omitted key), not inferred from DB row shapes —
 * the server's view mappers normalize to exactly these shapes.
 */
import { z } from "zod";

import { codingAgentSchema, runOutcomeSchema, runPhaseSchema, runRoleSchema, runStatusSchema } from "./enums.js";

/** Machine ids derive from the device token (`@loopzhb/protocol/node`
 *  `machineIdFromToken`): `m-<sha256(token)[:16]>` — lowercase hex. */
export const MACHINE_ID_RE = /^m-[0-9a-f]{16}$/;

/** No NUL bytes in any declared string (malformed at the boundary). */
const nulFreeString = (): z.ZodString => z.string().refine((s) => !s.includes("\0"), { message: "NUL byte" });

/** Admin wire timestamps are real ISO datetimes, not arbitrary strings. Offsets
 *  remain valid for additive clients; current server writers emit UTC `Z`. */
const isoTimestampSchema = z.iso.datetime({ offset: true });

// ---- POST /api/loops ----

export const createLoopRequestSchema = z.object({
  /** Execution machine — must be shaped like a registered machine id (the
   *  registration/existence check itself is the server's, → 404). */
  machineId: z.string().regex(MACHINE_ID_RE),
  /** Non-empty when present; the 255-char ceiling is server policy. */
  name: nulFreeString().min(1).optional(),
  /** Machine-side absolute project dir; 4096-char ceiling is server policy. */
  workdir: nulFreeString().min(1).optional(),
  /** Machine-side path to the loop's durable context+log doc. */
  taskFile: nulFreeString().min(1).optional(),
});
export type CreateLoopRequest = z.infer<typeof createLoopRequestSchema>;

// ---- summaries (observation surface) ----

/** Safe machine view: NEVER carries tokenHash, credentials, or roots. */
export const machineSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string().nullable(),
  platform: z.string().nullable(),
  arch: z.string().nullable(),
  daemonVersion: z.string().nullable(),
  /** Persisted heartbeat watermark (ISO) — presence derives from it + now. */
  lastSeen: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});
export type MachineSummary = z.infer<typeof machineSummarySchema>;

/** The run's live progress as PERSISTED (the server's `at` stamp made
 *  explicit: `null` when the row predates a stamp). Distinct from poll.ts's
 *  `runProgressSchema` — that's the daemon's in-flight heartbeat line. */
export const runProgressSnapshotSchema = z.object({
  step: z.number().int().nonnegative(),
  label: z.string(),
  at: isoTimestampSchema.nullable(),
});
export type RunProgressSnapshot = z.infer<typeof runProgressSnapshotSchema>;

/** Safe run view: no transcript/artifacts/usage/cost/session/state — those
 *  stay server-side until their phases open them. `ts` is the run's LAST
 *  TRANSITION time (ADR-003 决策 6), not a creation time. */
export const runSummarySchema = z.object({
  id: z.string(),
  loopId: z.string(),
  machineId: z.string(),
  phase: runPhaseSchema,
  role: runRoleSchema,
  ts: isoTimestampSchema,
  outcome: runOutcomeSchema.nullable(),
  status: runStatusSchema.nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  progress: runProgressSnapshotSchema.nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

/** Safe loop view: no workflow/model/state/task-file content (not open in
 *  Phase 1). `lastRun` is the latest EXEC run by `ts DESC, id DESC`. */
export const loopSummarySchema = z.object({
  id: z.string(),
  machineId: z.string(),
  name: z.string().nullable(),
  workdir: z.string().nullable(),
  taskFile: z.string().nullable(),
  agent: codingAgentSchema,
  allowControl: z.boolean(),
  enabled: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  lastRun: runSummarySchema.nullable(),
});
export type LoopSummary = z.infer<typeof loopSummarySchema>;

// ---- response envelopes ----

export const createLoopResponseSchema = z.object({
  loop: loopSummarySchema,
});
export type CreateLoopResponse = z.infer<typeof createLoopResponseSchema>;

/** POST /api/loops/:id/run — currently NO business params: `{}` (and the
 *  empty body, normalized to `{}` at the HTTP edge) is the whole request;
 *  unknown keys strip away. Future trigger options arrive as additive
 *  optional fields only (ADR-002 演进只增不减). */
export const triggerRunRequestSchema = z.object({});
export type TriggerRunRequest = z.infer<typeof triggerRunRequestSchema>;

/** POST /api/loops/:id/run — 202 when enqueued, 200 no-op while a run is
 *  running. (`loop_not_found` never rides this body: it is the flat 404.) */
export const triggerRunResponseSchema = z.union([
  z.object({
    enqueued: z.literal(true),
    runId: z.string(),
    supersededRunIds: z.array(z.string()),
  }),
  z.object({
    enqueued: z.literal(false),
    reason: z.literal("running_exists"),
  }),
]);
export type TriggerRunResponse = z.infer<typeof triggerRunResponseSchema>;

export const machineListResponseSchema = z.object({
  machines: z.array(machineSummarySchema),
});
export type MachineListResponse = z.infer<typeof machineListResponseSchema>;

export const loopListResponseSchema = z.object({
  loops: z.array(loopSummarySchema),
});
export type LoopListResponse = z.infer<typeof loopListResponseSchema>;

export const runListResponseSchema = z.object({
  runs: z.array(runSummarySchema),
});
export type RunListResponse = z.infer<typeof runListResponseSchema>;
