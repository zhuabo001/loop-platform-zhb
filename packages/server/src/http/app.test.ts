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

import {
  apiErrorSchema,
  cancelRunResponseSchema,
  createLoopResponseSchema,
  deliverySchema,
  loopListResponseSchema,
  machineListResponseSchema,
  pollResponseSchema,
  reportResponseSchema,
  runListResponseSchema,
  triggerRunResponseSchema,
} from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";
import { eq } from "drizzle-orm";

import { createLoopAdmin, type LoopAdmin } from "../admin/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { machines } from "../db/schema.js";
import { createOwnerControl, type OwnerControl } from "../owner/index.js";
import {
  FakeClock,
  seedLease,
  seedLoop,
  seedMachine,
  seedMachineForToken,
  seedRun,
  snapshotLoops,
  snapshotRuns,
  testDeps,
} from "../testkit/index.js";
import { createRunCoordinator, type RunCoordinator } from "../coordinator/index.js";
import { createServerApp } from "./app.js";

const TOKEN = "dk_test_machine_alpha";
const MACHINE_ID = "m-0123456789abcdef";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let coordinator: RunCoordinator;
let admin: LoopAdmin;
let ownerControl: OwnerControl;
let app: ReturnType<typeof createServerApp>;

async function fresh(): Promise<void> {
  const h = await openMigratedDb();
  handles.push(h);
  db = h.db;
  clock = new FakeClock();
  coordinator = createRunCoordinator(testDeps(db, clock));
  let loopN = 0;
  admin = createLoopAdmin({ db, clock, newLoopId: () => `loop-${++loopN}` });
  ownerControl = createOwnerControl({ db, clock });
  app = createServerApp(coordinator, admin, ownerControl, db, clock);
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

async function createLoopReq(body: unknown): Promise<Response> {
  return app.request("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** `body` ABSENT means no request body at all (the empty-body case). */
async function triggerReq(loopId: string, body?: unknown): Promise<Response> {
  return app.request(`/api/loops/${loopId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

/** `body` ABSENT means no request body at all (the empty-body case). */
async function cancelReq(runId: string, body?: unknown): Promise<Response> {
  return app.request(`/api/runs/${runId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
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
    const other = createServerApp(coordinator, admin, ownerControl, db, clock);
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

describe("POST /api/loops", () => {
  it("201 with a schema-valid LoopSummary for a registered machine — and NO run", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const res = await createLoopReq({
      machineId: MACHINE_ID,
      name: "react-doctor",
      workdir: "/home/dev/project",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(createLoopResponseSchema.parse(json)).toBeTruthy();
    expect(json).toEqual({
      loop: {
        id: "loop-1",
        machineId: MACHINE_ID,
        name: "react-doctor",
        workdir: "/home/dev/project",
        taskFile: null,
        agent: "claude-code",
        allowControl: true,
        enabled: true,
        createdAt: clock.iso(),
        updatedAt: clock.iso(),
        lastRun: null,
        cron: null,
        timezone: "UTC",
        nextFireAt: null,
        goal: null,
        completedAt: null,
        completionReason: null,
        taskFileSyncedAt: null,
        taskFileSyncAttemptedAt: null,
        taskFileSyncError: null,
      },
    });
    expect(await snapshotLoops(db)).toHaveLength(1);
    // Creation NEVER enqueues (goal: 创建与触发分离; HTTP 重试不得产生隐式 Run).
    expect(await snapshotRuns(db)).toEqual([]);
  });

  it("404 + zero writes for a well-shaped but unregistered machine", async () => {
    await fresh();
    const res = await createLoopReq({ machineId: "m-ffffffffffffffff" });
    await expectJsonError(res, 404, { error: "not found" });
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("400 for malformed JSON and every non-object JSON, all zero-write", async () => {
    await fresh();
    for (const body of ["{", "[1,2]", '"str"', "null", "42"]) {
      await expectJsonError(await createLoopReq(body), 400, { error: "invalid request" });
    }
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("400 for malformed machineId, empty/NUL strings and over-cap fields", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const bad = [
      { machineId: "m-UPPERCASED789AB" }, // not m-<16 lowercase hex>
      { machineId: "" },
      { machineId: MACHINE_ID, name: "" },
      { machineId: MACHINE_ID, name: "a\0b" },
      { machineId: MACHINE_ID, workdir: "\0" },
      { machineId: MACHINE_ID, name: "n".repeat(256) },
      { machineId: MACHINE_ID, workdir: "/".repeat(4097) },
      { machineId: MACHINE_ID, taskFile: "t".repeat(4097) },
    ];
    for (const body of bad) {
      await expectJsonError(await createLoopReq(body), 400, { error: "invalid request" });
    }
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("strips not-yet-open fields — the row keeps Phase-1 fixed defaults (ADR-002 决策 6)", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const res = await createLoopReq({
      machineId: MACHINE_ID,
      workflow: "return true",
      model: "claude-opus",
      agent: "codex",
      enabled: false,
      state: { hijack: true },
    });
    expect(res.status).toBe(201);
    const parsed = createLoopResponseSchema.parse(await res.json());
    expect(parsed.loop).toMatchObject({ agent: "claude-code", allowControl: true, enabled: true });
    const rows = await snapshotLoops(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "claude-code", enabled: true, workflow: null, model: null, state: null });
  });

  it("413 over the shared 2 MiB body cap", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const res = await createLoopReq({ machineId: MACHINE_ID, name: "x".repeat(2 * 1024 * 1024) });
    await expectJsonError(res, 413, { error: "request body too large" });
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("400 (never 500) for an invalid cron — ScheduleValidationError maps into the taxonomy", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const bad = [
      { machineId: MACHINE_ID, cron: "not a cron" },
      { machineId: MACHINE_ID, cron: "@daily" }, // macros rejected
      { machineId: MACHINE_ID, cron: "0 10 * * * *" }, // six segments rejected
      { machineId: MACHINE_ID, cron: "61 10 * * *" }, // out-of-range minute
    ];
    for (const body of bad) {
      await expectJsonError(await createLoopReq(body), 400, { error: "invalid request" });
    }
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("400 for an invalid timezone — including timezone-ONLY creation (no cron)", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    // Timezone-only creation must not bypass validation: a manual-only loop
    // still persists its timezone, so an invalid one is rejected up front.
    await expectJsonError(
      await createLoopReq({ machineId: MACHINE_ID, timezone: "Not/AZone" }),
      400,
      { error: "invalid request" },
    );
    await expectJsonError(
      await createLoopReq({ machineId: MACHINE_ID, cron: "0 10 * * *", timezone: "Not/AZone" }),
      400,
      { error: "invalid request" },
    );
    expect(await snapshotLoops(db)).toEqual([]);
  });

  it("201 for timezone-only creation — timezone persisted, cron stays null", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const res = await createLoopReq({ machineId: MACHINE_ID, timezone: "Asia/Shanghai" });
    expect(res.status).toBe(201);
    const parsed = createLoopResponseSchema.parse(await res.json());
    expect(parsed.loop).toMatchObject({ cron: null, timezone: "Asia/Shanghai", nextFireAt: null });
    const rows = await snapshotLoops(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cron: null, timezone: "Asia/Shanghai" });
  });

  it("201 for scheduled creation — cron normalized, nextFireAt computed", async () => {
    await fresh();
    await seedMachine(db, MACHINE_ID);
    const res = await createLoopReq({
      machineId: MACHINE_ID,
      cron: "  0   10  * *  * ", // whitespace normalizes
      timezone: "UTC",
    });
    expect(res.status).toBe(201);
    const parsed = createLoopResponseSchema.parse(await res.json());
    expect(parsed.loop.cron).toBe("0 10 * * *");
    expect(parsed.loop.timezone).toBe("UTC");
    // Clock is the FakeClock default (2026-07-29T00:00Z) → next 10:00 UTC
    expect(parsed.loop.nextFireAt).toBe("2026-07-29T10:00:00.000Z");
  });
});

describe("POST /api/loops/:id/run", () => {
  it("202 enqueues exactly one pending exec run (empty body normalizes to {})", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, { id: "loop-1" });
    const res = await triggerReq("loop-1"); // NO body at all
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(triggerRunResponseSchema.parse(json)).toBeTruthy();
    expect(json).toEqual({ enqueued: true, runId: "run-1", supersededRunIds: [] });
    const rows = await snapshotRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "run-1", loopId: "loop-1", phase: "pending", role: "exec", ts: clock.iso() });
  });

  it("inherits T7 over HTTP: re-trigger atomically supersedes the stale pending run", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, { id: "loop-1" });
    await triggerReq("loop-1", {});
    // Unknown keys strip away; the second trigger supersedes the first.
    const res = await triggerReq("loop-1", { futureField: 1 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true, runId: "run-2", supersededRunIds: ["run-1"] });
    const byId = new Map((await snapshotRuns(db)).map((r) => [r.id, r]));
    expect(byId.get("run-1")).toMatchObject({ phase: "canceled", outcome: "skipped" });
    expect(byId.get("run-2")).toMatchObject({ phase: "pending" });
  });

  it("200 no-op with zero writes while a run is running", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-live", phase: "running" });
    const before = await snapshotRuns(db);
    const res = await triggerReq("loop-1", {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(triggerRunResponseSchema.parse(json)).toBeTruthy();
    expect(json).toEqual({ enqueued: false, reason: "running_exists" });
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it("404 + zero writes for an unknown loop", async () => {
    await fresh();
    await expectJsonError(await triggerReq("loop-nope", {}), 404, { error: "not found" });
    expect(await snapshotRuns(db)).toEqual([]);
  });

  it("400 for malformed or non-object JSON, zero writes", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, { id: "loop-1" });
    for (const body of ["{", "[1]", '"str"', "null"]) {
      await expectJsonError(await triggerReq("loop-1", body), 400, { error: "invalid request" });
    }
    expect(await snapshotRuns(db)).toEqual([]);
  });
});

describe("POST /api/runs/:id/cancel", () => {
  it("200 {canceled:true} on a running run — the capability is revoked in the same transaction (T6's HTTP face)", async () => {
    await fresh();
    const machineId = await seedMachineForToken(db, TOKEN);
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-1", machineId });
    const runToken = pollResponseSchema.parse(await (await pollReq()).json()).deliveries[0]!.runToken;

    const res = await cancelReq("run-1"); // NO body at all — normalizes to {}
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(cancelRunResponseSchema.parse(json)).toBeTruthy();
    expect(json).toEqual({ canceled: true });

    // phase + ts only: no outcome/message/error late-write ever lands.
    expect((await snapshotRuns(db))[0]).toMatchObject({
      phase: "canceled",
      ts: clock.iso(),
      outcome: null,
      message: null,
      error: null,
    });
    // The revoked credential meets the unified coded 401.
    await expectJsonError(await reportReq({ ok: true }, runToken), 401, {
      error: "invalid or expired run capability",
      code: "run_capability_invalid",
    });
  });

  it("200 {canceled:true} on a pending run (no lease existed)", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", phase: "pending" });
    const res = await cancelReq("run-1", { futureField: 1 }); // unknown keys strip away
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canceled: true });
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "canceled", ts: clock.iso() });
  });

  it("200 {canceled:false,not_cancelable} for an already-terminal run — the repeat cancel is idempotent, zero writes", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", phase: "done", outcome: "exec", message: "finished" });
    const before = await snapshotRuns(db);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await cancelReq("run-1", {});
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(cancelRunResponseSchema.parse(json)).toBeTruthy();
      expect(json).toEqual({ canceled: false, reason: "not_cancelable" });
    }
    expect(await snapshotRuns(db)).toEqual(before);
  });

  it("404 + not found for an unknown run", async () => {
    await fresh();
    await expectJsonError(await cancelReq("run-ghost", {}), 404, { error: "not found" });
  });

  it("400 for malformed or non-object JSON, zero writes", async () => {
    await fresh();
    await seedRun(db, { id: "run-1", phase: "running" });
    for (const body of ["{", "[1]", '"str"', "null"]) {
      await expectJsonError(await cancelReq("run-1", body), 400, { error: "invalid request" });
    }
    expect((await snapshotRuns(db))[0]).toMatchObject({ phase: "running" }); // untouched
  });

  it("413 over the shared 2 MiB body cap", async () => {
    await fresh();
    const huge = JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) });
    await expectJsonError(await cancelReq("run-1", huge), 413, { error: "request body too large" });
  });
});

describe("GET observation surface", () => {
  it("GET /api/machines returns schema-valid summaries without tokenHash/roots", async () => {
    await fresh();
    await db.insert(machines).values({
      id: MACHINE_ID,
      name: "mbp",
      tokenHash: "secret-hash-must-not-leak",
      roots: ["/secret/root"],
      hostname: "mbp.local",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const res = await app.request("/api/machines");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret-hash-must-not-leak");
    expect(text).not.toContain("/secret/root");
    const json = machineListResponseSchema.parse(JSON.parse(text));
    expect(json.machines).toEqual([
      {
        id: MACHINE_ID,
        name: "mbp",
        hostname: "mbp.local",
        platform: null,
        arch: null,
        daemonVersion: null,
        lastSeen: null,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  it("GET /api/loops returns schema-valid summaries with lastRun, no unopened fields", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, {
      id: "loop-1",
      workflow: "secret-js-body",
      state: { secret: "cursor" },
      taskFileContent: "secret-doc",
    });
    await seedRun(db, {
      id: "run-1",
      loopId: "loop-1",
      phase: "done",
      outcome: "exec",
      message: "fake runner completed",
      durationMs: 7,
      ts: "2026-07-01T00:00:01.000Z",
    });
    const res = await app.request("/api/loops");
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const leak of ["secret-js-body", "secret-doc", "cursor"]) {
      expect(text).not.toContain(leak);
    }
    const json = loopListResponseSchema.parse(JSON.parse(text));
    expect(json.loops).toEqual([
      {
        id: "loop-1",
        machineId: "m-test",
        name: null,
        workdir: null,
        taskFile: null,
        agent: "claude-code",
        allowControl: true,
        enabled: true,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        cron: null,
        timezone: "UTC",
        nextFireAt: null,
        goal: null,
        completedAt: null,
        completionReason: null,
        taskFileSyncedAt: null,
        taskFileSyncAttemptedAt: null,
        taskFileSyncError: null,
        lastRun: {
          id: "run-1",
          loopId: "loop-1",
          machineId: "m-test",
          phase: "done",
          role: "exec",
          ts: "2026-07-01T00:00:01.000Z",
          outcome: "exec",
          status: null,
          message: "fake runner completed",
          error: null,
          durationMs: 7,
          progress: null,
        },
      },
    ]);
  });

  it("GET /api/loops/:id/runs returns schema-valid runs; 404 for an unknown loop", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, { id: "run-1", loopId: "loop-1", ts: "2026-07-01T00:00:01.000Z" });

    const res = await app.request("/api/loops/loop-1/runs");
    expect(res.status).toBe(200);
    const json = runListResponseSchema.parse(await res.json());
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0]).toMatchObject({ id: "run-1", loopId: "loop-1", phase: "pending" });

    await expectJsonError(await app.request("/api/loops/loop-nope/runs"), 404, { error: "not found" });
  });

  it("never exposes unopened Run columns through lastRun or the Run list", async () => {
    await fresh();
    await seedMachine(db, "m-test");
    await seedLoop(db, { id: "loop-1" });
    await seedRun(db, {
      id: "run-1",
      loopId: "loop-1",
      phase: "done",
      outcome: "exec",
      ts: "2026-07-01T00:00:01.000Z",
      state: { marker: "run-state-secret" },
      sessionId: "run-session-secret",
      costUsd: 987654.321,
      usage: { inputTokens: 999991 },
      artifacts: [{ path: "run-artifact-secret", kind: "created" }],
      transcript: [{ kind: "text", text: "run-transcript-secret" }],
    });

    const expectedRun = {
      id: "run-1",
      loopId: "loop-1",
      machineId: "m-test",
      phase: "done",
      role: "exec",
      ts: "2026-07-01T00:00:01.000Z",
      outcome: "exec",
      status: null,
      message: null,
      error: null,
      durationMs: null,
      progress: null,
    };

    const loopsResponse = await app.request("/api/loops");
    expect(loopsResponse.status).toBe(200);
    const loopsText = await loopsResponse.text();
    const loopsJson = JSON.parse(loopsText) as { loops: Array<{ lastRun: unknown }> };
    expect(loopsJson.loops[0]!.lastRun).toEqual(expectedRun);
    expect(() => loopListResponseSchema.parse(loopsJson)).not.toThrow();

    const runsResponse = await app.request("/api/loops/loop-1/runs");
    expect(runsResponse.status).toBe(200);
    const runsText = await runsResponse.text();
    const runsJson = JSON.parse(runsText) as { runs: unknown[] };
    expect(runsJson.runs).toEqual([expectedRun]);
    expect(() => runListResponseSchema.parse(runsJson)).not.toThrow();

    for (const sentinel of [
      "run-state-secret",
      "run-session-secret",
      "987654.321",
      "999991",
      "run-artifact-secret",
      "run-transcript-secret",
    ]) {
      expect(loopsText).not.toContain(sentinel);
      expect(runsText).not.toContain(sentinel);
    }
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
    const sabotaged = createServerApp(
      {
        ...coordinator,
        poll: () => {
          throw new Error("pg connection failed: password=hunter2 at db.internal:5432");
        },
      },
      admin,
      ownerControl,
      db,
      clock,
    );
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
