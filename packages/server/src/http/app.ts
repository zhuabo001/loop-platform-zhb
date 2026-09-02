/**
 * The HTTP adapter (plan §HTTP). `createServerApp(coordinator, admin,
 * lifecycle, schedule, ownerControl)` is a PURE assembly seam — it wires the
 * two machine routes plus the local management routes (loop creation, manual
 * trigger, run cancel, goal/task-file/schedule/reopen lifecycle, JSON
 * observation surface) onto a standalone Hono app and returns it. It never
 * reads env vars, opens a DB, listens on a port, registers signals or holds a
 * global singleton; each call is an independent instance (tests drive it via
 * app.request; boot wires exactly one).
 *
 * Routes do exactly four things: extract the Bearer credential, parse the
 * JSON body against the protocol DTO, call the coordinator/admin/lifecycle/
 * schedule/owner-control NARROW INTERFACES, shape the response (review
 * STD-2: no Db/Clock/store-function imports here — business transactions are
 * assembled behind the interfaces). Every response — success or any error
 * branch — is JSON that validates against `apiErrorSchema` / the response
 * schemas; Zod issues, exception messages, stacks and DB details go to the
 * server log only.
 *
 * The management routes carry NO credential at all (Phase 1: localhost /
 * trusted network is the whole security boundary — see config.ts's
 * unauthenticated-exposure warning). The trigger route owns no lifecycle
 * logic: it delegates to `coordinator.enqueueExecRun` (ADR-001 T7); the
 * cancel route delegates to `ownerControl.cancelRun` (ADR-001 T6) — the
 * coordinator's three-method interface is NOT the HTTP permission surface.
 *
 * Unified taxonomy (G-04): 400 invalid request / 401 invalid machine
 * credential / 401 + run_capability_invalid / 409 loop conflict (coded:
 * loop_completed, loop_not_completed; uncoded: schedule/goal revision
 * exhausted, loop state conflict, run in progress) / 413 too large /
 * 404 not found / 500 internal. `code` stays the optional additive field —
 * the full (status, code) set this adapter can emit is pinned by the
 * taxonomy test in app.test.ts.
 */
import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";

import {
  cancelRunRequestSchema,
  createLoopRequestSchema,
  LOOP_COMPLETED_CODE,
  LOOP_NOT_COMPLETED_CODE,
  pollRequestSchema,
  reopenLoopRequestSchema,
  reportRequestSchema,
  RUN_CAPABILITY_INVALID_CODE,
  triggerRunRequestSchema,
  updateGoalRequestSchema,
  updateScheduleRequestSchema,
  updateTaskFileRequestSchema,
} from "@loopzhb/protocol";

import { LoopValidationError } from "../admin/errors.js";
import { LOOP_PATH_CAP, type LoopAdmin } from "../admin/index.js";
import { InvalidMachineCredentialError, RunCapabilityInvalidError } from "../coordinator/errors.js";
import type { RunCoordinator } from "../coordinator/index.js";
import type { Loop } from "../db/schema.js";
import type { LifecycleAdmin } from "../loop-lifecycle/admin.js";
import type { OwnerControl } from "../owner/index.js";
import {
  ScheduleRevisionExhaustedError,
  ScheduleValidationError,
  type ScheduleAdmin,
} from "../schedule/index.js";
import { CapabilityDeclarationInvalidError } from "../store/machines.js";

/** Both machine endpoints share one wire body cap (plan §HTTP). */
const BODY_CAP_BYTES = 2 * 1024 * 1024;

function jsonError(c: Context, status: 400 | 401 | 409 | 413 | 404 | 500, error: string, code?: string): Response {
  return c.json(code === undefined ? { error } : { error, code }, status);
}

/** Extract `Bearer <token>` — anything else is no credential at all. */
function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? undefined : token;
}

/** Parse the JSON body; `undefined` marks malformed JSON (→ 400). */
async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** The manual trigger takes NO business params: an EMPTY body normalizes to
 *  `{}` at this edge (goal §3); malformed JSON still marks `undefined`. */
async function parseJsonBodyOrEmpty(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createServerApp(
  coordinator: RunCoordinator,
  admin: LoopAdmin,
  lifecycle: LifecycleAdmin,
  schedule: ScheduleAdmin,
  ownerControl: OwnerControl,
  onScheduleCommitted?: (loop: Loop) => void,
): Hono {
  const app = new Hono();

  /**
   * The ONE schedule-commit seam (Batch 2 plan §2): invoked synchronously after
   * a committed create/PATCH with the authoritative loop row. A seam failure
   * is logged with a fixed classification and NEVER fails the request — the
   * configuration is already committed, and rolling the response back would
   * leave client and server disagreeing about state.
   */
  const commitSchedule = (loop: Loop): void => {
    if (!onScheduleCommitted) return;
    try {
      onScheduleCommitted(loop);
    } catch {
      console.warn("[http] schedule_commit_sync_failed");
    }
  };

  app.onError((err, c) => {
    console.error("[http] unhandled error", err);
    return jsonError(c, 500, "internal server error");
  });
  app.notFound((c) => jsonError(c, 404, "not found"));

  const cap = bodyLimit({
    maxSize: BODY_CAP_BYTES,
    onError: (c) => jsonError(c, 413, "request body too large"),
  });

  app.post("/api/machine/poll", cap, async (c) => {
    const token = bearerToken(c);
    if (token === undefined) return jsonError(c, 401, "invalid machine credential");
    const raw = await parseJsonBody(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = pollRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] poll DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    try {
      return c.json(await coordinator.poll(token, parsed.data));
    } catch (err) {
      if (err instanceof InvalidMachineCredentialError) {
        console.warn("[http] poll credential rejected", err.message);
        return jsonError(c, 401, "invalid machine credential");
      }
      if (err instanceof CapabilityDeclarationInvalidError) {
        // Phase 4 capability resource policy: fixed classification only —
        // the offending values never reach the log (ADR-009 修订 2026-09-01
        // 决策 1: the WHOLE poll is a 400, before any write happened).
        console.warn("[http] poll capabilities rejected");
        return jsonError(c, 400, "invalid request");
      }
      throw err;
    }
  });

  app.post("/api/machine/report", cap, async (c) => {
    const token = bearerToken(c);
    const raw = await parseJsonBody(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = reportRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] report DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    try {
      // A missing Bearer rides the same path as an unknown credential: the
      // coordinator resolves "" to nothing and denies uniformly.
      const result = await coordinator.report(token ?? "", parsed.data);
      // A legal Finish committed: reconcile the Scheduler through the SAME
      // seam a schedule PATCH uses (ADR-009 修订 2026-09-01 决策 4). The
      // internal loop row never enters the wire response.
      if (result.schedulerReconcile !== undefined) commitSchedule(result.schedulerReconcile);
      return c.json(
        result.reconciled === true ? { ok: true as const, reconciled: true as const } : { ok: true as const },
      );
    } catch (err) {
      if (err instanceof RunCapabilityInvalidError) {
        console.warn("[http] report capability denied", err.reason);
        return jsonError(c, 401, "invalid or expired run capability", RUN_CAPABILITY_INVALID_CODE);
      }
      throw err;
    }
  });

  // ---- local management routes (no credential — Phase 1 loopback boundary) ----

  app.get("/api/machines", async (c) => c.json({ machines: await admin.listMachines() }));

  app.get("/api/loops", async (c) => c.json({ loops: await admin.listLoops() }));

  app.get("/api/loops/:id/runs", async (c) => {
    const list = await admin.listRuns(c.req.param("id"));
    if (list === undefined) return jsonError(c, 404, "not found");
    return c.json({ runs: list });
  });

  app.post("/api/loops", cap, async (c) => {
    const raw = await parseJsonBody(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = createLoopRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] create-loop DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    try {
      const result = await admin.createLoop(parsed.data);
      if (!result.created) return jsonError(c, 404, "not found");

      // Hot-register the schedule through the seam with the authoritative row
      // from the INSERT (no post-commit re-read). The seam never blocks or
      // fails the response — the committed loop stands either way.
      if (result.row.enabled && result.row.cron !== null) {
        commitSchedule(result.row);
      }

      return c.json({ loop: result.loop }, 201);
    } catch (err) {
      if (err instanceof LoopValidationError) {
        console.warn("[http] create-loop cap rejected", err.field);
        return jsonError(c, 400, "invalid request");
      }
      if (err instanceof ScheduleValidationError) {
        // Fixed classification only — the message embeds user input.
        console.warn("[http] create-loop schedule rejected", err.field);
        return jsonError(c, 400, "invalid request");
      }
      throw err;
    }
  });

  app.post("/api/loops/:id/run", cap, async (c) => {
    const raw = await parseJsonBodyOrEmpty(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = triggerRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] trigger DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    // T7 lives in the coordinator — this route only maps its result.
    const result = await coordinator.enqueueExecRun(c.req.param("id"));
    if (result.enqueued) {
      return c.json({ enqueued: true, runId: result.runId, supersededRunIds: result.supersededRunIds }, 202);
    }
    if (result.reason === "loop_not_found") return jsonError(c, 404, "not found");
    if (result.reason === "loop_completed") {
      // Phase 4 (ADR-009 决策 10): Run Now on a Completed loop is a flat 409
      // with the additive code — the success union's reason literals stay
      // untouched so Phase 3 readers keep parsing.
      return jsonError(c, 409, "loop is completed", LOOP_COMPLETED_CODE);
    }
    return c.json({ enqueued: false, reason: "running_exists" }, 200);
  });

  app.post("/api/runs/:id/cancel", cap, async (c) => {
    const raw = await parseJsonBodyOrEmpty(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = cancelRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] cancel DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    // T6 lives in the owner-control module — this route only maps its result.
    const result = await ownerControl.cancelRun(c.req.param("id"));
    if (result.canceled) return c.json({ canceled: true }, 200);
    if (result.reason === "not_found") return jsonError(c, 404, "not found");
    return c.json({ canceled: false, reason: "not_cancelable" }, 200);
  });

  app.patch("/api/loops/:id/schedule", cap, async (c) => {
    const raw = await parseJsonBody(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = updateScheduleRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] update-schedule DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    try {
      const result = await schedule.updateSchedule(c.req.param("id"), parsed.data);

      if (!result.found) return jsonError(c, 404, "not found");
      if ("conflict" in result) {
        // Phase 4: re-enabling a Completed loop is refused — only Reopen
        // restores scheduling (ADR-009 决策 10).
        return jsonError(c, 409, "loop is completed", LOOP_COMPLETED_CODE);
      }

      // Sync the in-memory scheduler through the seam on an EFFECTIVE change
      // (a no-op patch must not replace the job).
      if (result.changed) {
        commitSchedule(result.loop);
      }

      // The wire response is the admin view (LoopSummary with lastRun and
      // computed nextFireAt) — never the raw DB row (ADR-002 wire boundary).
      const loopSummary = await admin.getLoopSummary(result.loop.id);
      if (!loopSummary) return jsonError(c, 404, "not found");

      return c.json({ loop: loopSummary }, 200);
    } catch (err) {
      if (err instanceof ScheduleValidationError) {
        // Fixed classification only — the message embeds user input.
        console.warn("[http] update-schedule validation failed", err.field);
        return jsonError(c, 400, "invalid request");
      }
      if (err instanceof ScheduleRevisionExhaustedError) {
        // Revision ceiling: a stable, ordinary 409 — never a DB overflow 500
        // (ADR-009 决策 4; 修订 2026-09-01 决策 6).
        console.warn("[http] update-schedule revision exhausted", err.loopId);
        return jsonError(c, 409, "schedule revision exhausted");
      }
      throw err;
    }
  });

  // ---- Phase 4 lifecycle routes (ADR-009; Batch 2 mounts them) ----

  app.patch("/api/loops/:id/goal", cap, async (c) => {
    const raw = await parseJsonBody(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = updateGoalRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] update-goal DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    const result = await lifecycle.updateGoal(c.req.param("id"), parsed.data);
    if (!result.found) return jsonError(c, 404, "not found");
    if (result.kind === "rejected") {
      // Fixed classification per rejection reason — the raw goal text
      // (user input) never reaches the log or the response beyond the code.
      console.warn("[http] update-goal rejected", c.req.param("id"), result.reason);
      if (result.reason === "loop_completed") return jsonError(c, 409, "loop is completed", LOOP_COMPLETED_CODE);
      if (result.reason === "invalid_loop_state") return jsonError(c, 409, "loop state conflict");
      if (result.reason === "goal_revision_exhausted") return jsonError(c, 409, "goal revision exhausted");
      return jsonError(c, 400, "invalid request");
    }
    const loopSummary = await admin.getLoopSummary(result.loop.id);
    if (!loopSummary) return jsonError(c, 404, "not found");
    return c.json({ loop: loopSummary }, 200);
  });

  app.patch("/api/loops/:id/task-file", cap, async (c) => {
    const raw = await parseJsonBody(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = updateTaskFileRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] update-task-file DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    // LOOP_PATH_CAP is a pure value constant shared with the admin module —
    // importing the constant creates no behavior coupling (review STD-2).
    if (parsed.data.taskFile.length > LOOP_PATH_CAP) {
      console.warn("[http] update-task-file cap rejected");
      return jsonError(c, 400, "invalid request");
    }
    const result = await lifecycle.updateTaskFile(c.req.param("id"), parsed.data.taskFile);
    if (!result.found) return jsonError(c, 404, "not found");
    if (result.kind === "conflict") {
      // A running run holds the old path's snapshot — retargeting mid-run
      // would let its post-run sync pollute the new path (plan §2.2).
      console.warn("[http] update-task-file conflict", c.req.param("id"), result.reason);
      return jsonError(c, 409, "a run is in progress");
    }
    const loopSummary = await admin.getLoopSummary(result.loop.id);
    if (!loopSummary) return jsonError(c, 404, "not found");
    return c.json({ loop: loopSummary }, 200);
  });

  app.post("/api/loops/:id/reopen", cap, async (c) => {
    const raw = await parseJsonBodyOrEmpty(c);
    if (raw === undefined) return jsonError(c, 400, "invalid request");
    const parsed = reopenLoopRequestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[http] reopen DTO rejected", parsed.error.issues);
      return jsonError(c, 400, "invalid request");
    }
    const result = await lifecycle.reopenLoop(c.req.param("id"));
    if (!result.found) return jsonError(c, 404, "not found");
    if (result.kind === "rejected") {
      console.warn("[http] reopen rejected", c.req.param("id"), result.reason);
      if (result.reason === "loop_not_completed") {
        return jsonError(c, 409, "loop is not completed", LOOP_NOT_COMPLETED_CODE);
      }
      // invalid_loop_state / schedule_revision_exhausted: ordinary 409s, no
      // new codes (ADR-009 修订 2026-09-01 决策 6).
      return jsonError(c, 409, "loop state conflict");
    }
    // Re-arm the schedule through the seam with the authoritative row (the
    // reopen already committed — a seam failure never fails the request).
    commitSchedule(result.loop);
    const loopSummary = await admin.getLoopSummary(result.loop.id);
    if (!loopSummary) return jsonError(c, 404, "not found");
    return c.json({ loop: loopSummary }, 200);
  });

  return app;
}
