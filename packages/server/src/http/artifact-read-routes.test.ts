/**
 * AV1/AV2/AV4/AV6/AV7/AV8 (route level) — the four slice-7 read routes driven
 * through the REAL facade over an in-memory PGlite and a memory BlobStore:
 * the current view, the run bound/missing discrimination, cross-scope
 * refusals byte-identical to /nope, the download headers and byte fidelity,
 * the R3 blob-missing composition (404 path_not_found, never the table's
 * 409), the structural diff incl. the empty-string baseline normalization,
 * and the AV8 handle-release matrix via a counting store and an injected
 * AbortController.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  apiErrorSchema,
  artifactDiffResponseSchema,
  loopArtifactsResponseSchema,
  runArtifactsResponseSchema,
} from "@loopzhb/protocol";
import { sha256 } from "@loopzhb/protocol/node";

import { createLoopAdmin } from "../admin/index.js";
import { createArtifactApi } from "../artifact/api.js";
import { createMemoryBlobStore } from "../artifact/blob-store-memory.js";
import type { BlobKey, BlobReadResult, BlobStore } from "../artifact/blob-store.js";
import { createRunCoordinator } from "../coordinator/index.js";
import { closeDb, openMigratedDb, type Db, type DbHandle } from "../db/index.js";
import { artifactManifests } from "../db/schema.js";
import { createLifecycleAdmin } from "../loop-lifecycle/admin.js";
import { createOwnerControl } from "../owner/index.js";
import { createScheduleAdmin } from "../schedule/index.js";
import { FakeClock, seedLoop, seedMachineForToken, seedRun, staticAttribution, testDeps } from "../testkit/index.js";
import { createServerApp } from "./app.js";

const CONTENT_A = "artifact bytes A";
const CONTENT_B = "artifact bytes B";
const HASH_A = sha256(CONTENT_A);
const HASH_B = sha256(CONTENT_B);
const NOW = "2026-10-06T00:00:00.000Z";

const handles: DbHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

let db: Db;
let app: ReturnType<typeof createServerApp>;
let machineId: string;
let storeLog: { opens: number; releases: number };
let store: BlobStore;

/** A BlobStore wrapper that counts REAL releases (idempotence-aware, mirroring
 *  the local adapter's closePromise) — the AV8 invariant is "released exactly
 *  once", not "the close function was invoked n times". */
function countingStore(inner: BlobStore): BlobStore {
  return {
    writeVerified: (input) => inner.writeVerified(input),
    has: (key) => inner.has(key),
    read: async (key: BlobKey): Promise<BlobReadResult> => {
      const result = await inner.read(key);
      if (!result.ok) return result;
      storeLog.opens += 1;
      let released = false;
      const innerClose = result.close;
      return {
        ok: true,
        bytes: result.bytes,
        size: result.size,
        close: async () => {
          if (!released) {
            released = true;
            storeLog.releases += 1;
          }
          await innerClose();
        },
      };
    },
  };
}

async function fresh(options: { unmappedAttribution?: boolean } = {}): Promise<void> {
  const handle = await openMigratedDb();
  handles.push(handle);
  db = handle.db;
  const clock = new FakeClock();
  machineId = await seedMachineForToken(db, "dk_read_routes_machine");
  storeLog = { opens: 0, releases: 0 };
  store = countingStore(createMemoryBlobStore());
  app = createServerApp(
    createRunCoordinator(testDeps(db, clock)),
    createLoopAdmin({ db, clock, newLoopId: () => "loop-x" }),
    createLifecycleAdmin({ db, clock }),
    createScheduleAdmin({ db, clock }),
    createOwnerControl({ db, clock }),
    undefined,
    undefined,
    createArtifactApi({
      db,
      clock,
      ids: { syncId: () => "sync-1", manifestId: () => "amf-1" },
      blobStore: store,
      attribution: staticAttribution(options.unmappedAttribution ? {} : { [machineId]: "ns-1" }),
    }),
  );
}

async function seedManifest(
  overrides: Partial<{
    id: string;
    loopId: string;
    manifestRevision: number;
    configRevision: number;
    entries: Array<{ path: string; hash: string; size: number }>;
  }> = {},
): Promise<void> {
  const entries = overrides.entries ?? [
    { path: "a.txt", hash: HASH_A, size: CONTENT_A.length },
    { path: "dir/b.txt", hash: HASH_B, size: CONTENT_B.length },
  ];
  await db.insert(artifactManifests).values({
    id: "amf-1",
    namespaceId: "ns-1",
    machineId,
    loopId: "loop-1",
    configRevision: 1,
    manifestRevision: 1,
    entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    committedAt: NOW,
    ...overrides,
  });
}

/** loop-1 (generation 1) bound to amf-1, blobs for both entries uploaded. */
async function boundLoop(overrides: Record<string, unknown> = {}): Promise<void> {
  await seedManifest();
  await seedLoop(db, {
    id: "loop-1",
    machineId,
    artifactDir: "/data/out",
    artifactConfigRevision: 1,
    artifactManifestRevision: 1,
    artifactManifestId: "amf-1",
    ...overrides,
  });
  for (const [hash, content] of [
    [HASH_A, CONTENT_A],
    [HASH_B, CONTENT_B],
  ] as const) {
    const put = await store.writeVerified({
      namespaceId: "ns-1",
      hash,
      expectedSize: content.length,
      bytes: (async function* () {
        yield new TextEncoder().encode(content);
      })(),
    });
    if (!put.ok) throw new Error(`blob fixture must succeed: ${JSON.stringify(put)}`);
  }
}

const notFoundBody = async (): Promise<string> => (await app.request("/nope")).text();

describe("GET /api/loops/:id/artifacts (AV1/AV7)", () => {
  it("bound loop: 200 with the frozen view shape, sync state included", async () => {
    await fresh();
    await boundLoop({ artifactSyncAttemptedAt: NOW, artifactSyncError: "timeout" });
    const res = await app.request("/api/loops/loop-1/artifacts");
    expect(res.status).toBe(200);
    const body = loopArtifactsResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      loopId: "loop-1",
      artifactDir: "/data/out",
      configRevision: 1,
      manifestRevision: 1,
      manifestId: "amf-1",
      stale: false,
      fileCount: 2,
      sync: { attemptedAt: NOW, succeededAt: null, error: "timeout" },
    });
    expect(body.files.map((f) => f.path)).toEqual(["a.txt", "dir/b.txt"]);
  });

  it("unconfigured loop: the nullable view shape, NOT an error (AV7)", async () => {
    await fresh();
    await seedLoop(db, { id: "loop-1", machineId });
    const res = await app.request("/api/loops/loop-1/artifacts");
    expect(res.status).toBe(200);
    expect(loopArtifactsResponseSchema.parse(await res.json())).toMatchObject({
      artifactDir: null,
      configRevision: 0,
      manifestRevision: 0,
      manifestId: null,
      stale: false,
      fileCount: 0,
      totalBytes: 0,
      files: [],
    });
  });

  it("config generation moved on ⇒ stale:true, the old view still served (AV7)", async () => {
    await fresh();
    await boundLoop({ artifactConfigRevision: 2 });
    const res = await app.request("/api/loops/loop-1/artifacts");
    expect(res.status).toBe(200);
    expect(loopArtifactsResponseSchema.parse(await res.json()).stale).toBe(true);
  });

  it("unknown loop ⇒ the code-less 404, byte-identical to /nope (AV2)", async () => {
    await fresh();
    const res = await app.request("/api/loops/loop-nope/artifacts");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await notFoundBody());
    expect(apiErrorSchema.parse(JSON.parse(await (await app.request("/nope")).text()))).toEqual({ error: "not found" });
  });

  it("attribution missing ⇒ 403 artifact_attribution_missing (AV2)", async () => {
    await fresh({ unmappedAttribution: true });
    await seedLoop(db, { id: "loop-1", machineId });
    const res = await app.request("/api/loops/loop-1/artifacts");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "artifact attribution missing", code: "artifact_attribution_missing" });

    // Order pin (决策 27): attribution is judged BEFORE any snapshot/path
    // resolution — a poisoned attribution wins over a nonexistent snapshot
    // (an order flip would surface the snapshot's 404 first).
    const download = await app.request(
      "/api/loops/loop-1/artifacts/download?snapshotId=amf-ghost&path=a.txt",
    );
    expect(download.status).toBe(403);
    const diff = await app.request("/api/loops/loop-1/artifacts/diff?to=amf-ghost");
    expect(diff.status).toBe(403);
  });
});

describe("GET /api/runs/:id/artifacts (AV1/AV7)", () => {
  it("bound run: 200 with the frozen bound shape", async () => {
    await fresh();
    await boundLoop();
    await seedRun(db, { id: "run-1", loopId: "loop-1", machineId, artifactSnapshotId: "amf-1" });
    const res = await app.request("/api/runs/run-1/artifacts");
    expect(res.status).toBe(200);
    expect(runArtifactsResponseSchema.parse(await res.json())).toMatchObject({
      state: "bound",
      snapshotId: "amf-1",
      manifestRevision: 1,
      fileCount: 2,
    });
  });

  it("unbound run: the explicit missing state (AV7)", async () => {
    await fresh();
    await boundLoop();
    await seedRun(db, { id: "run-1", loopId: "loop-1", machineId, artifactSnapshotId: null });
    const res = await app.request("/api/runs/run-1/artifacts");
    expect(res.status).toBe(200);
    expect(runArtifactsResponseSchema.parse(await res.json())).toEqual({
      runId: "run-1",
      loopId: "loop-1",
      state: "missing",
    });
  });

  it("unknown run ⇒ code-less 404 byte-identical to /nope (AV2)", async () => {
    await fresh();
    const res = await app.request("/api/runs/run-nope/artifacts");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await notFoundBody());
  });
});

describe("GET /api/loops/:id/artifacts/download (AV4/AV5/AV8, R3)", () => {
  const downloadPath = `/api/loops/loop-1/artifacts/download?snapshotId=amf-1&path=${encodeURIComponent("dir/b.txt")}`;

  it("200 with the exact attachment headers and the real blob bytes (AV4/AV5)", async () => {
    await fresh();
    await boundLoop();
    const res = await app.request(downloadPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="b.txt"');
    expect(res.headers.get("content-length")).toBe(String(CONTENT_B.length));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(CONTENT_B);
    expect(storeLog).toEqual({ opens: 1, releases: 1 }); // natural EOF: released exactly once
  });

  it("R3: blob gone from disk ⇒ 404 path_not_found, byte-identical to /nope (never the table's 409)", async () => {
    await fresh();
    await seedManifest();
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      artifactDir: "/data/out",
      artifactConfigRevision: 1,
      artifactManifestRevision: 1,
      artifactManifestId: "amf-1",
    });
    const res = await app.request(
      `/api/loops/loop-1/artifacts/download?snapshotId=amf-1&path=${encodeURIComponent("a.txt")}`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await notFoundBody());
  });

  it("cross-loop snapshot and manifest-absent path ⇒ code-less 404, indistinguishable (AV2)", async () => {
    await fresh();
    await boundLoop();
    await seedManifest({ id: "amf-other", loopId: "loop-2" });
    await seedLoop(db, { id: "loop-2", machineId });
    const canonical = await notFoundBody();
    const crossLoop = await app.request(
      `/api/loops/loop-1/artifacts/download?snapshotId=amf-other&path=${encodeURIComponent("a.txt")}`,
    );
    expect(crossLoop.status).toBe(404);
    expect(await crossLoop.text()).toBe(canonical);
    const absentPath = await app.request(
      `/api/loops/loop-1/artifacts/download?snapshotId=amf-1&path=${encodeURIComponent("absent.txt")}`,
    );
    expect(absentPath.status).toBe(404);
    expect(await absentPath.text()).toBe(canonical);
  });

  it("malformed query (missing path / missing both) ⇒ the route's own 400", async () => {
    await fresh();
    await boundLoop();
    const missingPath = await app.request("/api/loops/loop-1/artifacts/download?snapshotId=amf-1");
    expect(missingPath.status).toBe(400);
    expect(await missingPath.json()).toEqual({ error: "invalid request" });
    const missingBoth = await app.request("/api/loops/loop-1/artifacts/download");
    expect(missingBoth.status).toBe(400);
  });

  it("AV8: client abort mid-stream releases the handle exactly once", async () => {
    await fresh();
    await boundLoop();
    // A store whose second chunk never arrives until the handle is released:
    // the ONLY way the pump unwinds after an abort is the abort hook's
    // close() — the finally-in-finally path never runs while the stream hangs.
    const gatedLog = { opens: 0, releases: 0 };
    let releaseGate: (() => void) | null = null;
    let released = false;
    const gatedStore: BlobStore = {
      writeVerified: (input) => store.writeVerified(input),
      has: (key) => store.has(key),
      read: async (): Promise<BlobReadResult> => {
        gatedLog.opens += 1;
        return {
          ok: true,
          size: CONTENT_B.length * 2,
          bytes: (async function* () {
            yield { ok: true as const, chunk: new TextEncoder().encode(CONTENT_B) };
            await new Promise<void>((resolve) => {
              releaseGate = resolve;
            });
          })(),
          close: async () => {
            if (!released) {
              released = true;
              gatedLog.releases += 1;
              releaseGate?.();
            }
          },
        };
      },
    };
    const clock = new FakeClock();
    const gatedApp = createServerApp(
      createRunCoordinator(testDeps(db, clock)),
      createLoopAdmin({ db, clock, newLoopId: () => "loop-x" }),
      createLifecycleAdmin({ db, clock }),
      createScheduleAdmin({ db, clock }),
      createOwnerControl({ db, clock }),
      undefined,
      undefined,
      createArtifactApi({
        db,
        clock,
        ids: { syncId: () => "sync-1", manifestId: () => "amf-1" },
        blobStore: gatedStore,
        attribution: staticAttribution({ [machineId]: "ns-1" }),
      }),
    );
    const ctl = new AbortController();
    const res = await gatedApp.request(downloadPath, { signal: ctl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // chunk 1 delivered; the pump now hangs on chunk 2
    ctl.abort(); // client gone: the abort hook must release the handle
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the pump unwind
    expect(gatedLog).toEqual({ opens: 1, releases: 1 });
    await reader.cancel().catch(() => {});
  });

  it("AV8: mid-stream storage error truncates the body and still releases exactly once", async () => {
    await fresh();
    await seedManifest({
      entries: [{ path: "big.bin", hash: HASH_A, size: 128 * 1024 }],
    });
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      artifactDir: "/data/out",
      artifactConfigRevision: 1,
      artifactManifestRevision: 1,
      artifactManifestId: "amf-1",
    });
    // Faults must be wired at store CREATION — rebuild the app against a
    // store whose read yields one chunk and then the terminal storage_error
    // element (决策 14's two-phase channel).
    const faultyLog = { opens: 0, releases: 0 };
    let released = false;
    const faultyStore: BlobStore = {
      writeVerified: (input) => store.writeVerified(input),
      has: (key) => store.has(key),
      read: async (): Promise<BlobReadResult> => {
        faultyLog.opens += 1;
        return {
          ok: true,
          size: 128 * 1024,
          bytes: (async function* () {
            yield { ok: true as const, chunk: new Uint8Array(64 * 1024) };
            yield { ok: false as const, failure: "storage_error" as const, cause: new Error("injected") };
          })(),
          close: async () => {
            if (!released) {
              released = true;
              faultyLog.releases += 1;
            }
          },
        };
      },
    };
    const clock = new FakeClock();
    const faultyApp = createServerApp(
      createRunCoordinator(testDeps(db, clock)),
      createLoopAdmin({ db, clock, newLoopId: () => "loop-x" }),
      createLifecycleAdmin({ db, clock }),
      createScheduleAdmin({ db, clock }),
      createOwnerControl({ db, clock }),
      undefined,
      undefined,
      createArtifactApi({
        db,
        clock,
        ids: { syncId: () => "sync-1", manifestId: () => "amf-1" },
        blobStore: faultyStore,
        attribution: staticAttribution({ [machineId]: "ns-1" }),
      }),
    );
    const res = await faultyApp.request(
      `/api/loops/loop-1/artifacts/download?snapshotId=amf-1&path=${encodeURIComponent("big.bin")}`,
    );
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBe(128 * 1024);
    const received = await res.arrayBuffer();
    expect(received.byteLength).toBe(64 * 1024); // truncated at the terminal element
    expect(faultyLog).toEqual({ opens: 1, releases: 1 }); // released exactly once
  });
});

describe("GET /api/loops/:id/artifacts/diff (AV6)", () => {
  async function twoSnapshots(): Promise<void> {
    await seedManifest({
      id: "amf-1",
      manifestRevision: 1,
      entries: [
        { path: "a.txt", hash: HASH_A, size: CONTENT_A.length },
        { path: "gone.txt", hash: HASH_B, size: CONTENT_B.length },
      ],
    });
    await seedManifest({
      id: "amf-2",
      manifestRevision: 2,
      entries: [
        { path: "a.txt", hash: HASH_A, size: CONTENT_A.length },
        { path: "b.txt", hash: HASH_B, size: CONTENT_B.length },
      ],
    });
    await seedLoop(db, {
      id: "loop-1",
      machineId,
      artifactDir: "/data/out",
      artifactConfigRevision: 2,
      artifactManifestRevision: 2,
      artifactManifestId: "amf-2",
    });
  }

  it("from+to: the frozen diff shape with the three classes", async () => {
    await fresh();
    await twoSnapshots();
    const res = await app.request("/api/loops/loop-1/artifacts/diff?from=amf-1&to=amf-2");
    expect(res.status).toBe(200);
    expect(artifactDiffResponseSchema.parse(await res.json())).toEqual({
      loopId: "loop-1",
      from: { snapshotId: "amf-1", manifestRevision: 1 },
      to: { snapshotId: "amf-2", manifestRevision: 2 },
      added: [{ path: "b.txt", hash: HASH_B, size: CONTENT_B.length }],
      modified: [],
      removed: [{ path: "gone.txt", hash: HASH_B, size: CONTENT_B.length }],
    });
  });

  it("empty-string from (the HTML form's empty baseline) ⇒ null = empty-set baseline", async () => {
    await fresh();
    await twoSnapshots();
    const res = await app.request("/api/loops/loop-1/artifacts/diff?from=&to=amf-2");
    expect(res.status).toBe(200);
    const body = artifactDiffResponseSchema.parse(await res.json());
    expect(body.from).toBeNull();
    expect(body.added.map((e) => e.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(body.removed).toEqual([]);
  });

  it("omitted from entirely ⇒ the same empty-set baseline", async () => {
    await fresh();
    await twoSnapshots();
    const res = await app.request("/api/loops/loop-1/artifacts/diff?to=amf-2");
    expect(res.status).toBe(200);
    expect(artifactDiffResponseSchema.parse(await res.json()).from).toBeNull();
  });

  it("missing to / cross-loop snapshot ⇒ 400 / the code-less 404 (AV2)", async () => {
    await fresh();
    await twoSnapshots();
    // A REAL snapshot belonging to ANOTHER loop: the cross-scope refusal must
    // come from the loopId check, not from mere absence.
    await seedManifest({ id: "amf-other", loopId: "loop-2" });
    await seedLoop(db, { id: "loop-2", machineId });
    const missingTo = await app.request("/api/loops/loop-1/artifacts/diff");
    expect(missingTo.status).toBe(400);
    expect(await missingTo.json()).toEqual({ error: "invalid request" });
    const crossLoop = await app.request("/api/loops/loop-1/artifacts/diff?to=amf-other");
    expect(crossLoop.status).toBe(404);
    expect(await crossLoop.text()).toBe(await notFoundBody());
  });
});
