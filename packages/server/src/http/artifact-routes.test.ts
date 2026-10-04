/**
 * AH2/AH4/AH6/AH7/AH8/AH9/AH10 (route level) — the six artifact routes Batch 2
 * slice 2 mounts, driven through the REAL facade over an in-memory PGlite and
 * a memory BlobStore: config PATCH, the machine read, the prepare dual gate,
 * the prepare → PUT → commit flow with its idempotent replays, and the
 * sync-error report.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiErrorSchema,
  ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES,
  ARTIFACT_SYNC_ID_HEADER,
  ARTIFACT_SYNC_SESSION_TTL_MILLIS,
  commitArtifactSyncResponseSchema,
  machineLoopArtifactsResponseSchema,
  prepareArtifactSyncResponseSchema,
  putArtifactBlobResponseSchema,
} from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";

import { createLoopAdmin } from "../admin/index.js";
import { createArtifactApi } from "../artifact/api.js";
import { createMachineAttributionResolver } from "../artifact/attribution-machine.js";
import { createMemoryBlobStore } from "../artifact/blob-store-memory.js";
import { createRunCoordinator } from "../coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactSyncSessions, loops } from "../db/schema.js";
import { createLifecycleAdmin } from "../loop-lifecycle/admin.js";
import { createOwnerControl } from "../owner/index.js";
import { createScheduleAdmin } from "../schedule/index.js";
import { REVISION_INT32_MAX } from "../schedule/transition.js";
import { FakeClock, seedLoop, seedMachineForToken, staticAttribution, testDeps } from "../testkit/index.js";
import { createServerApp } from "./app.js";

const TOKEN = "dk_routes_machine_alpha";
const OTHER_TOKEN = "dk_routes_machine_beta";
const CONTENT_A = "artifact bytes A";
const HASH_A = sha256(CONTENT_A); // the REAL digest — writeVerified checks bytes, not declarations
const HASH_B = "b".repeat(64); // never negotiated

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let clock: FakeClock;
let app: ReturnType<typeof createServerApp>;
let machineId: string;
let syncSeq = 0;
let manifestSeq = 0;

/**
 * Poison the Nth top-level `select()` on a Db (every other query still runs
 * against the real handle). The machine read flow reads exactly three times —
 * credential, attribution, loop — so `at` names the failing stage (#85).
 */
function faultingSelect(db: Db, at: number, cause: unknown): Db {
  let n = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "select") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (...args: unknown[]) => {
        n += 1;
        if (n === at) throw cause;
        return (target.select as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Db;
}

async function fresh(options: { artifactFault?: { at: number; cause: unknown } } = {}): Promise<void> {
  const handle = await openMigratedDb();
  handles.push(handle);
  db = handle.db;
  clock = new FakeClock();
  syncSeq = 0;
  manifestSeq = 0;
  machineId = await seedMachineForToken(db, TOKEN);
  const otherMachineId = await seedMachineForToken(db, OTHER_TOKEN);
  const artifactDb = options.artifactFault ? faultingSelect(db, options.artifactFault.at, options.artifactFault.cause) : db;
  app = createServerApp(
    createRunCoordinator(testDeps(db, clock)),
    createLoopAdmin({ db, clock, newLoopId: () => "loop-x" }),
    createLifecycleAdmin({ db, clock }),
    createScheduleAdmin({ db, clock }),
    createOwnerControl({ db, clock }),
    undefined,
    undefined,
    createArtifactApi({
      db: artifactDb,
      clock,
      ids: { syncId: () => `sync-${++syncSeq}`, manifestId: () => `amf-${++manifestSeq}` },
      blobStore: createMemoryBlobStore(),
      // Stage-2 fault injection needs a REAL attribution read: the production
      // resolver queries the machines row, staticAttribution never reads.
      attribution: options.artifactFault
        ? createMachineAttributionResolver({ db: artifactDb })
        : staticAttribution({ [machineId]: "ns-1", [otherMachineId]: "ns-2" }),
    }),
  );
}

const jsonHeaders = { "content-type": "application/json" };
const machineHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});

const machineReq = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...machineHeaders(), ...(init.headers as Record<string, string>) } });

const loopRow = async () => (await db.select().from(loops).where(eq(loops.id, "loop-1")))[0]!;

async function expectJson(res: Response, status: number, body: Record<string, unknown>): Promise<void> {
  expect(res.status).toBe(status);
  const parsed = apiErrorSchema.parse(await res.json());
  expect(parsed).toEqual(body);
}

async function configuredLoop(overrides: Record<string, unknown> = {}): Promise<void> {
  await seedLoop(db, {
    id: "loop-1",
    machineId,
    artifactDir: "/data/out",
    artifactConfigRevision: 1,
    ...overrides,
  });
}

/** prepare → the negotiated session id for CONTENT_A. */
async function negotiate(base = 0, hash = HASH_A, size = CONTENT_A.length, requestId = "req-1"): Promise<string> {
  const res = await machineReq("/api/machine/sync", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      requestId,
      loopId: "loop-1",
      configRevision: 1,
      baseManifestRevision: base,
      entries: [{ path: "a.txt", hash, size }],
    }),
  });
  expect(res.status).toBe(200);
  return prepareArtifactSyncResponseSchema.parse(await res.json()).syncId;
}

describe("AH2: PATCH /api/loops/:id/artifact-dir", () => {
  it("set → 200 with the committed dir at generation 1; an equal value is a strict no-op", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId, workdir: "/home/dev/project" });
    const res = await app.request("/api/loops/loop-1/artifact-dir", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ artifactDir: "/data/out" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loop: { artifactDir: string | null } };
    expect(body.loop.artifactDir).toBe("/data/out");
    const afterSet = await loopRow();
    expect(afterSet.artifactConfigRevision).toBe(1);

    const noop = await app.request("/api/loops/loop-1/artifact-dir", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ artifactDir: "/data/out" }),
    });
    expect(noop.status).toBe(200);
    const afterNoop = await loopRow();
    expect(afterNoop.artifactConfigRevision).toBe(1);
    expect(afterNoop.revision).toBe(afterSet.revision); // zero writes
    expect(afterNoop.updatedAt).toBe(afterSet.updatedAt);
  });

  it("clear → 200 with artifactDir null and the generation advanced", async () => {
    await fresh();
    await configuredLoop();
    const res = await app.request("/api/loops/loop-1/artifact-dir", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ artifactDir: null }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { loop: { artifactDir: unknown } }).loop.artifactDir).toBeNull();
    expect((await loopRow()).artifactConfigRevision).toBe(2);
  });

  it("unknown loop → flat 404; malformed DTO → 400", async () => {
    await fresh();
    await expectJson(
      await app.request("/api/loops/loop-ghost/artifact-dir", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ artifactDir: "/data" }),
      }),
      404,
      { error: "not found" },
    );
    await expectJson(
      await app.request("/api/loops/loop-1/artifact-dir", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ artifactDir: 42 }),
      }),
      400,
      { error: "invalid request" },
    );
  });

  it("a relative dir without a workdir is the coded 400 (artifact_validation_failed)", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    await expectJson(
      await app.request("/api/loops/loop-1/artifact-dir", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ artifactDir: "dist" }),
      }),
      400,
      { error: "invalid artifact directory", code: "artifact_validation_failed" },
    );
    expect((await loopRow()).artifactDir).toBeNull();
  });

  it("the int32 ceiling is a stable 409 artifact_revision_exhausted with zero writes", async () => {
    await fresh();
    await configuredLoop({ artifactConfigRevision: REVISION_INT32_MAX });
    const before = await loopRow();
    await expectJson(
      await app.request("/api/loops/loop-1/artifact-dir", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ artifactDir: "/data/other" }),
      }),
      409,
      { error: "artifact revision exhausted", code: "artifact_revision_exhausted" },
    );
    expect(await loopRow()).toEqual(before);
  });
});

describe("AH9: GET /api/machine/loops/:id/artifacts", () => {
  it("a configured loop returns the four frozen fields", async () => {
    await fresh();
    await configuredLoop({ artifactManifestRevision: 4 });
    const res = await machineReq("/api/machine/loops/loop-1/artifacts");
    expect(res.status).toBe(200);
    const body = machineLoopArtifactsResponseSchema.parse(await res.json());
    expect(body).toEqual({ loopId: "loop-1", artifactDir: "/data/out", configRevision: 1, manifestRevision: 4 });
  });

  it("an unconfigured loop → 409 artifact_config_conflict; unknown/cross-machine → flat 404", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    await seedLoop(db, { id: "loop-other", machineId: "m-other", artifactDir: "/x" });
    await expectJson(await machineReq("/api/machine/loops/loop-1/artifacts"), 409, {
      error: "artifact config conflict",
      code: "artifact_config_conflict",
    });
    await expectJson(await machineReq("/api/machine/loops/loop-ghost/artifacts"), 404, { error: "not found" });
    await expectJson(await machineReq("/api/machine/loops/loop-other/artifacts"), 404, { error: "not found" });
  });

  it("no bearer → 401 (never the flat 404)", async () => {
    await fresh();
    await configuredLoop();
    await expectJson(await app.request("/api/machine/loops/loop-1/artifacts"), 401, {
      error: "invalid machine credential",
    });
  });
});

describe("AH7: POST /api/machine/sync — the dual gate and the wire errors", () => {
  it("a real prepare answers 200 with a schema-valid body", async () => {
    await fresh();
    await configuredLoop();
    const res = await machineReq("/api/machine/sync", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        requestId: "req-1",
        loopId: "loop-1",
        configRevision: 1,
        baseManifestRevision: 0,
        entries: [{ path: "a.txt", hash: HASH_A, size: CONTENT_A.length }],
      }),
    });
    expect(res.status).toBe(200);
    const body = prepareArtifactSyncResponseSchema.parse(await res.json());
    expect(body.needHashes).toEqual([HASH_A]);
  });

  it("a body over the transport cap is a 413 before any parse", async () => {
    await fresh();
    const res = await machineReq("/api/machine/sync", {
      method: "POST",
      headers: jsonHeaders,
      body: `{"pad":"${"x".repeat(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES)}"}`,
    });
    await expectJson(res, 413, { error: "request body too large" });
  });

  it("the RAW-TEXT gate is not redundant: invalid UTF-8 inflates past the cap under a legal Content-Length", async () => {
    await fresh();
    // 8 MiB of lone continuation bytes: Content-Length equals the cap (the
    // transport gate passes), but decoding yields U+FFFD per byte — 3 UTF-8
    // bytes each — so the pre-parse text gate is what actually rejects it.
    const res = await machineReq("/api/machine/sync", {
      method: "POST",
      headers: jsonHeaders,
      body: new Uint8Array(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES).fill(0x80),
    });
    await expectJson(res, 413, { error: "request body too large" });
  });

  it("malformed JSON stays code-less 400; DTO rejections are the coded 400 (#86); a policy rejection shares the code", async () => {
    await fresh();
    await configuredLoop();
    await expectJson(
      await machineReq("/api/machine/sync", { method: "POST", headers: jsonHeaders, body: "{" }),
      400,
      { error: "invalid request" },
    );
    // Missing required fields — the schema domain maps through the frozen
    // `manifest_invalid` → artifact_validation_failed entry (ADR-010 决策 13).
    await expectJson(
      await machineReq("/api/machine/sync", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ requestId: "r", loopId: "loop-1" }),
      }),
      400,
      { error: "invalid artifact sync request", code: "artifact_validation_failed" },
    );
    // A wrong entry field TYPE takes the same coded path.
    await expectJson(
      await machineReq("/api/machine/sync", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          requestId: "r",
          loopId: "loop-1",
          configRevision: 1,
          baseManifestRevision: 0,
          entries: [{ path: "a.txt", hash: HASH_A, size: "1" }],
        }),
      }),
      400,
      { error: "invalid artifact sync request", code: "artifact_validation_failed" },
    );
    // Zero domain work and zero state for either rejection: no session row,
    // no attempt stamp on the loop.
    expect(await db.select().from(artifactSyncSessions)).toHaveLength(0);
    expect((await loopRow()).artifactSyncError).toBeNull();
    // A never-sync path is a policy rejection, not a schema issue.
    await expectJson(
      await machineReq("/api/machine/sync", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          requestId: "r",
          loopId: "loop-1",
          configRevision: 1,
          baseManifestRevision: 0,
          entries: [{ path: ".env", hash: HASH_A, size: 1 }],
        }),
      }),
      400,
      { error: "invalid artifact sync request", code: "artifact_validation_failed" },
    );
  });
});

describe("AH6/AH8: the prepare → PUT → commit flow and its refusals", () => {
  it("completes over HTTP, replays idempotently, and refuses a PUT after the commit", async () => {
    await fresh();
    await configuredLoop();
    const syncId = await negotiate();

    const put = await machineReq(`/api/machine/blob/${HASH_A}`, {
      method: "PUT",
      headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
      body: CONTENT_A,
    });
    expect(put.status).toBe(200);
    expect(putArtifactBlobResponseSchema.parse(await put.json())).toEqual({
      ok: true,
      size: CONTENT_A.length,
      published: true,
    });

    // The same bytes again on the PENDING session: verified all the same,
    // published:false (the dedupe path).
    const repeatPut = await machineReq(`/api/machine/blob/${HASH_A}`, {
      method: "PUT",
      headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
      body: CONTENT_A,
    });
    expect(repeatPut.status).toBe(200);
    expect(putArtifactBlobResponseSchema.parse(await repeatPut.json())).toEqual({
      ok: true,
      size: CONTENT_A.length,
      published: false,
    });

    const commit = await machineReq(`/api/machine/sync/${syncId}/commit`, { method: "POST" });
    expect(commit.status).toBe(200);
    const receipt = commitArtifactSyncResponseSchema.parse(await commit.json());
    expect(receipt.manifestRevision).toBe(1);
    expect((await loopRow()).artifactManifestId).toBe(receipt.artifactSnapshotId);

    // The repeated commit returns the FIXED receipt (recover_receipt).
    const repeatCommit = await machineReq(`/api/machine/sync/${syncId}/commit`, { method: "POST" });
    expect(repeatCommit.status).toBe(200);
    expect(commitArtifactSyncResponseSchema.parse(await repeatCommit.json())).toEqual(receipt);

    // A PUT after the commit is refused with the recover_receipt code.
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_A}`, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
        body: CONTENT_A,
      }),
      409,
      { error: "artifact sync session already committed", code: "artifact_session_committed" },
    );
  });

  it("refuses a mismatched blob with 400 artifact_content_mismatch (the session survives)", async () => {
    await fresh();
    await configuredLoop();
    const syncId = await negotiate();
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_A}`, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
        body: "different bytes!",
      }),
      400,
      { error: "artifact content mismatch", code: "artifact_content_mismatch" },
    );
  });

  it("refuses an unnegotiated hash with 409 artifact_hash_not_negotiated", async () => {
    await fresh();
    await configuredLoop();
    const syncId = await negotiate();
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_B}`, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
        body: CONTENT_A,
      }),
      409,
      { error: "artifact hash not negotiated", code: "artifact_hash_not_negotiated" },
    );
  });

  it("a missing sync-id header is a 400; an unknown session is a flat 404 for PUT and commit", async () => {
    await fresh();
    await configuredLoop();
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_A}`, { method: "PUT", body: CONTENT_A }),
      400,
      { error: "invalid request" },
    );
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_A}`, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: "sync-ghost" },
        body: CONTENT_A,
      }),
      404,
      { error: "not found" },
    );
    await expectJson(await machineReq("/api/machine/sync/sync-ghost/commit", { method: "POST" }), 404, {
      error: "not found",
    });
  });

  it("a commit after the session TTL is 409 artifact_session_expired", async () => {
    await fresh();
    await configuredLoop();
    const syncId = await negotiate();
    clock.advance(ARTIFACT_SYNC_SESSION_TTL_MILLIS);
    await expectJson(await machineReq(`/api/machine/sync/${syncId}/commit`, { method: "POST" }), 409, {
      error: "artifact sync session expired",
      code: "artifact_session_expired",
    });
  });

  it("a PUT on a committed session is 409 artifact_session_committed (recover_receipt)", async () => {
    await fresh();
    await configuredLoop();
    const syncId = await negotiate();
    await machineReq(`/api/machine/blob/${HASH_A}`, {
      method: "PUT",
      headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
      body: CONTENT_A,
    });
    await machineReq(`/api/machine/sync/${syncId}/commit`, { method: "POST" });
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_A}`, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
        body: CONTENT_A,
      }),
      409,
      { error: "artifact sync session already committed", code: "artifact_session_committed" },
    );
  });

  it("a prepared session is invisible to another machine (flat 404, the owner can still use it)", async () => {
    await fresh();
    await configuredLoop();
    const syncId = await negotiate();
    const otherRes = await app.request(`/api/machine/blob/${HASH_A}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OTHER_TOKEN}`, [ARTIFACT_SYNC_ID_HEADER]: syncId },
      body: CONTENT_A,
    });
    await expectJson(otherRes, 404, { error: "not found" });
    const ownerRes = await machineReq(`/api/machine/blob/${HASH_A}`, {
      method: "PUT",
      headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
      body: CONTENT_A,
    });
    expect(ownerRes.status).toBe(200);
  });
});

describe("AH10: POST /api/machine/loops/:id/artifact-sync-error", () => {
  it("a matching report is recorded; a drifted one is not (zero writes)", async () => {
    await fresh();
    await configuredLoop({ artifactManifestRevision: 3 });
    const ok = await machineReq("/api/machine/loops/loop-1/artifact-sync-error", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ failure: "watcher_error", configRevision: 1, baseManifestRevision: 3 }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, recorded: true });
    expect((await loopRow()).artifactSyncError).toBe("watcher_error");

    const before = await loopRow();
    const drifted = await machineReq("/api/machine/loops/loop-1/artifact-sync-error", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ failure: "timeout", configRevision: 1, baseManifestRevision: 2 }),
    });
    expect(drifted.status).toBe(200);
    expect(await drifted.json()).toEqual({ ok: true, recorded: false });
    expect(await loopRow()).toEqual(before); // zero writes
  });

  it("unknown and cross-machine loops are flat 404s with zero writes; a bad DTO is 400", async () => {
    await fresh();
    await configuredLoop();
    await expectJson(
      await machineReq("/api/machine/loops/loop-ghost/artifact-sync-error", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ failure: "timeout", configRevision: 1, baseManifestRevision: 0 }),
      }),
      404,
      { error: "not found" },
    );
    await seedLoop(db, { id: "loop-other", machineId: "m-other", artifactDir: "/x" });
    await expectJson(
      await machineReq("/api/machine/loops/loop-other/artifact-sync-error", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ failure: "timeout", configRevision: 0, baseManifestRevision: 0 }),
      }),
      404,
      { error: "not found" },
    );
    await expectJson(
      await machineReq("/api/machine/loops/loop-1/artifact-sync-error", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ failure: "not-a-class", configRevision: 1, baseManifestRevision: 0 }),
      }),
      400,
      { error: "invalid request" },
    );
  });
});

describe("AH4/AH9: recognized storage faults map to 500 artifact_storage_error (#85)", () => {
  const recoverable = () => Object.assign(new Error("injected connection failure"), { code: "08006" });
  const STORAGE_ERROR = { error: "artifact storage error", code: "artifact_storage_error" };

  it("the machine read returns the stable error for a fault at ANY of its three reads", async () => {
    for (const at of [1, 2, 3]) {
      await fresh({ artifactFault: { at, cause: recoverable() } });
      await configuredLoop();
      await expectJson(await machineReq("/api/machine/loops/loop-1/artifacts"), 500, STORAGE_ERROR);
    }
  });

  it("every machine route classifies a fault in the SHARED credential read the same way", async () => {
    // One boot per request: the poison targets the FIRST read of the request,
    // so each route needs its own armed app.
    await fresh({ artifactFault: { at: 1, cause: recoverable() } });
    await expectJson(await machineReq("/api/machine/loops/loop-1/artifacts"), 500, STORAGE_ERROR);
    await fresh({ artifactFault: { at: 1, cause: recoverable() } });
    await expectJson(
      await machineReq("/api/machine/sync", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          requestId: "r",
          loopId: "loop-1",
          configRevision: 1,
          baseManifestRevision: 0,
          entries: [],
        }),
      }),
      500,
      STORAGE_ERROR,
    );
    await fresh({ artifactFault: { at: 1, cause: recoverable() } });
    await expectJson(
      await machineReq(`/api/machine/blob/${HASH_A}`, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: "sync-x" },
        body: CONTENT_A,
      }),
      500,
      STORAGE_ERROR,
    );
    await fresh({ artifactFault: { at: 1, cause: recoverable() } });
    await expectJson(await machineReq("/api/machine/sync/sync-x/commit", { method: "POST" }), 500, STORAGE_ERROR);
    await fresh({ artifactFault: { at: 1, cause: recoverable() } });
    await expectJson(
      await machineReq("/api/machine/loops/loop-1/artifact-sync-error", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ failure: "timeout", configRevision: 1, baseManifestRevision: 0 }),
      }),
      500,
      STORAGE_ERROR,
    );
  });

  it("an UNRECOGNIZED fault keeps the raw boundary: 500 without a code, never misclassified", async () => {
    await fresh({ artifactFault: { at: 1, cause: new Error("plain driver defect") } });
    await expectJson(await machineReq("/api/machine/loops/loop-1/artifacts"), 500, { error: "internal server error" });
    await fresh({ artifactFault: { at: 1, cause: Object.assign(new Error("unique violation"), { code: "23505" }) } });
    await expectJson(await machineReq("/api/machine/loops/loop-1/artifacts"), 500, { error: "internal server error" });
  });
});
