/**
 * The HTTP adapter (plan §HTTP). `createServerApp(coordinator)` is a PURE
 * assembly seam — it wires the two machine routes onto a standalone Hono app
 * and returns it. It never reads env vars, opens a DB, listens on a port,
 * registers signals or holds a global singleton; each call is an independent
 * instance (tests drive it via app.request; boot wires exactly one).
 *
 * Routes do exactly four things: extract the Bearer credential, parse the
 * JSON body against the protocol DTO, call the coordinator, shape the
 * response. Every response — success or any error branch — is JSON that
 * validates against `apiErrorSchema` / the response schemas; Zod issues,
 * exception messages, stacks and DB details go to the server log only.
 *
 * Unified taxonomy (G-04): 400 invalid request / 401 invalid machine
 * credential / 401 + run_capability_invalid / 413 too large / 404 not found /
 * 500 internal. `code` stays the optional additive field — this batch mints
 * no code besides `run_capability_invalid`.
 */
import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";

import { pollRequestSchema, reportRequestSchema } from "@loopzhb/protocol";

import { InvalidMachineCredentialError, RunCapabilityInvalidError } from "../coordinator/errors.js";
import type { RunCoordinator } from "../coordinator/index.js";

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

export function createServerApp(coordinator: RunCoordinator): Hono {
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
        return jsonError(c, 401, "invalid or expired run capability", "run_capability_invalid");
      }
      throw err;
    }
  });

  return app;
}
