/**
 * HTTP adapter boundary tests (plan §HTTP, G-04's unified taxonomy).
 *
 * createServerApp(coordinator) is a pure assembly seam: no env reads, no DB,
 * no listener, no signals, no singleton — tests drive it with app.request
 * against their own in-memory PGlite fixture. Every response — success AND
 * every error branch — is JSON and validates against the protocol schemas
 * (pollResponse / reportResponse / apiError), with the exact status/body the
 * plan pins. Zod issues, exception messages, stacks and DB details NEVER
 * reach the wire.
 */
import { afterEach, describe, expect, it } from "vitest";

import { apiErrorSchema, deliverySchema, pollResponseSchema, reportResponseSchema } from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";
import { eq } from "drizzle-orm";

import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import {
  FakeClock,
  seedLease,
  seedLoop,
  seedMachineForToken,
  seedRun,
  snapshotRuns,
  testDeps,
} from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createServerApp } from "./app.js";

const TOKEN = "dk_test_machine_alpha";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let coordinator: RunCoordinator;
let app: ReturnType<typeof createServerApp>;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  coordinator = createRunCoordinator(testDeps(db, new FakeClock()));
  app = createServerApp(coordinator);
}

async function pollReq(body: unknown = {}, token: string | null = TOKEN): Promise<Response> {
  return app.request("/api/machine/poll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token == null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function reportReq(body: unknown = { ok: true }, token: string | null = "rk_cred"): Promise<Response> {
  return app.request("/api/machine/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token == null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectJsonError(res: Response, status: number, body: { error: string; code?: string }): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  const json = await res.json();
  expect(json).toEqual(body); // exact — no zod issues, no extra fields
  expect(apiErrorSchema.parse(json)).toBeTruthy();
}

describe("createServerApp: seam properties", () => {
  it("returns an independent app per call and constructs with no DB/env/listener side effects", async () => {
    await fresh();
    const other = createServerApp(coordinator);
    expect(other).not.toBe(app);
    // Both serve independently.
    expect((await app.request("/api/machine/poll", { method: "GET" })).status).toBe(404);
    expect((await other.request("/api/machine/poll", { method: "GET" })).status).toBe(404);
  });
});

describe("POST /api/machine/poll", () => {
  it("self-registers and returns a schema-valid empty delivery list", async () => {
    await fresh();
    const res = await pollReq({ host: "mbp.local" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const json = await res.json();
    expect(json).toEqual({ deliveries: [] });
    expect(pollResponseSchema.parse(json)).toBeTruthy();
  });

  it("delivers a schema-valid Delivery end-to-end over HTTP", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1", taskFile: "/srv/loop/README.md" });
    await seedRun(db, { id: "run-1", machineId });

    const res = await pollReq();
    expect(res.status).toBe(200);
    const json = pollResponseSchema.parse(await res.json());
    expect(json.deliveries).toHaveLength(1);
    expect(deliverySchema.parse(json.deliveries[0])).toBeTruthy();
    expect(json.deliveries[0]!.runId).toBe("run-1");
    expect((await snapshotRuns(db))[0]!.phase).toBe("running");
  });

  it("400 + invalid request for malformed JSON", async () => {
    await fresh();
    await expectJsonError(await pollReq("{not json"), 400, { error: "invalid request" });
  });

  it("400 + invalid request for a schema-invalid body (tolerant parse still enforces shapes)", async () => {
    await fresh();
    await expectJsonError(await pollReq({ wait: "yes-please" }), 400, { error: "invalid request" });
  });

  it("401 + invalid machine credential when the Authorization header is missing or not Bearer", async () => {
    await fresh();
    await expectJsonError(await pollReq({}, null), 401, { error: "invalid machine credential" });
    const res = await app.request("/api/machine/poll", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic abc" },
      body: "{}",
    });
    await expectJsonError(res, 401, { error: "invalid machine credential" });
  });

  it("401 + invalid machine credential for a malformed or mismatched device token", async () => {
    await fresh();
    await expectJsonError(await pollReq({}, "rk_not_a_device_token"), 401, { error: "invalid machine credential" });
    // Mismatched full hash at the derived id (enrolled under another token).
    const id = await seedMachineForToken(db, "dk_enrolled_elsewhere", {});
    await db.update(machines).set({ tokenHash: sha256("dk_somebody_else") }).where(eq(machines.id, id));
    await expectJsonError(await pollReq({}, "dk_enrolled_elsewhere"), 401, { error: "invalid machine credential" });
  });

  it("413 + request body too large beyond the 2 MiB wire cap", async () => {
    await fresh();
    const huge = JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) });
    await expectJsonError(await pollReq(huge), 413, { error: "request body too large" });
  });
});

describe("POST /api/machine/report", () => {
  it("finalizes over HTTP and returns a schema-valid {ok:true}; repeat → 401 with code", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-1", machineId });
    const pollJson = pollResponseSchema.parse(await (await pollReq()).json());
    const runToken = pollJson.deliveries[0]!.runToken;

    const res = await reportReq({ ok: true, message: "done" }, runToken);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(reportResponseSchema.parse(json)).toBeTruthy();

    // The consumed credential gets the unified 401 + code on the wire.
    await expectJsonError(await reportReq({ ok: true }, runToken), 401, {
      error: "invalid or expired run capability",
      code: "run_capability_invalid",
    });
  });

  it("401 + run_capability_invalid for an unknown credential", async () => {
    await fresh();
    await expectJsonError(await reportReq({ ok: true }, "rk_unknown_cred"), 401, {
      error: "invalid or expired run capability",
      code: "run_capability_invalid",
    });
  });

  it("400 + invalid request for malformed JSON or an invalid DTO", async () => {
    await fresh();
    await expectJsonError(await reportReq("[1,2"), 400, { error: "invalid request" });
    await expectJsonError(await reportReq({ ok: "yes" }), 400, { error: "invalid request" });
  });

  it("a forged body.runId cannot steer the finalize (lease is authoritative)", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-1", machineId, phase: "running" });
    await seedLease(db, { tokenHash: sha256("rk_real"), runId: "run-1", machineId });
    await seedRun(db, { id: "run-victim", machineId, phase: "running" });

    const res = await reportReq({ ok: true, runId: "run-victim" }, "rk_real");
    expect(res.status).toBe(200);
    const byId = new Map((await snapshotRuns(db)).map((r) => [r.id, r.phase]));
    expect(byId.get("run-1")).toBe("done");
    expect(byId.get("run-victim")).toBe("running");
  });
});

describe("unified error surface", () => {
  it("404 + not found as JSON (never Hono's default text) for unknown routes and methods", async () => {
    await fresh();
    await expectJsonError(await app.request("/nope"), 404, { error: "not found" });
    await expectJsonError(await app.request("/api/machine/poll", { method: "GET" }), 404, { error: "not found" });
  });

  it("500 + internal server error without leaking exception, stack or DB details", async () => {
    await fresh();
    const sabotaged = createServerApp({
      ...coordinator,
      poll: () => {
        throw new Error("pg connection failed: password=hunter2 at db.internal:5432");
      },
    });
    const res = await sabotaged.request("/api/machine/poll", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal server error" });
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("pg connection");
    expect(text).not.toContain("at ");
  });
});
