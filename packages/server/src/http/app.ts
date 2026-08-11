/**
 * The HTTP adapter (plan §HTTP). `createServerApp(coordinator, admin,
 * ownerControl)` is a PURE assembly seam — it wires the two machine routes
 * plus the local management routes (loop creation, manual trigger, run
 * cancel, JSON observation surface) onto a standalone Hono app and returns
 * it. It never reads env vars, opens a DB, listens on a port, registers
 * signals or holds a global singleton; each call is an independent instance
 * (tests drive it via app.request; boot wires exactly one).
 *
 * Routes do exactly four things: extract the Bearer credential, parse the
 * JSON body against the protocol DTO, call the coordinator/admin/owner-control
 * module, shape the response. Every response — success or any error branch —
 * is JSON that validates against `apiErrorSchema` / the response schemas;
 * Zod issues, exception messages, stacks and DB details go to the server log
 * only.
 *
 * The management routes carry NO credential at all (Phase 1: localhost /
 * trusted network is the whole security boundary — see config.ts's
 * unauthenticated-exposure warning). The trigger route owns no lifecycle
 * logic: it delegates to `coordinator.enqueueExecRun` (ADR-001 T7); the
 * cancel route delegates to `ownerControl.cancelRun` (ADR-001 T6) — the
 * coordinator's three-method interface is NOT the HTTP permission surface.
 *
 * Unified taxonomy (G-04): 400 invalid request / 401 invalid machine
 * credential / 401 + run_capability_invalid / 413 too large / 404 not found /
 * 500 internal. `code` stays the optional additive field — this batch mints
 * no code besides `run_capability_invalid`.
 */
import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";

import {
  cancelRunRequestSchema,
  createLoopRequestSchema,
  pollRequestSchema,
  reportRequestSchema,
  RUN_CAPABILITY_INVALID_CODE,
  triggerRunRequestSchema,
} from "@loopzhb/protocol";

import { LoopValidationError } from "../admin/errors.js";
import type { LoopAdmin } from "../admin/index.js";
import { InvalidMachineCredentialError, RunCapabilityInvalidError } from "../coordinator/errors.js";
import type { RunCoordinator } from "../coordinator/index.js";
import type { OwnerControl } from "../owner/index.js";

/** Both machine endpoints share one wire body cap (plan §HTTP). */
const BODY_CAP_BYTES = 2 * 1024 * 1024;

function jsonError(c: Context, status: 400 | 401 | 413 | 404 | 500, error: string, code?: string): Response {
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

export function createServerApp(coordinator: RunCoordinator, admin: LoopAdmin, ownerControl: OwnerControl): Hono {
  const app = new Hono();

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
      return c.json(await coordinator.report(token ?? "", parsed.data));
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
      return c.json({ loop: result.loop }, 201);
    } catch (err) {
      if (err instanceof LoopValidationError) {
        console.warn("[http] create-loop cap rejected", err.message);
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

  return app;
}
