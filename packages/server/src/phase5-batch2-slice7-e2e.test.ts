/**
 * Phase 5 Batch 2 slice 7 cross-package E2E (plan §3 AV1/AV5/AV6/AV7 + R3):
 * the BUILT @loopzhb/daemon drives a real booted server (file-backed PGlite,
 * local BlobStore under <dataDir>/blobs, Hono app.request adapted into the
 * daemon's fetch — the slice-6 precedent), with the REAL artifact sync client
 * and a REAL temp artifact directory:
 *
 *   register → create loop WITH artifactDir → run 1 (binds snapshot 1 with
 *   three files) → edit (modify / add / delete) → run 2 (binds snapshot 2) →
 *   the management reads serve the current view, download BYTES equal the
 *   on-disk blob, the structural diff shows exactly the three change classes,
 *   an unbound Run reads as the explicit missing state — and deleting the
 *   blob file under <dataDir>/blobs turns the download into the code-less 404
 *   (R3: path_not_found, byte-identical to /nope, never the table's 409).
 *
 * The daemon's public index deliberately does NOT export the artifact modules
 * (AD4), so this test deep-imports the BUILT dist files — the same
 * "verify what ships" convention as the slice-4/5/6 dist probes.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
import {
  artifactDiffResponseSchema,
  createLoopResponseSchema,
  loopArtifactsResponseSchema,
  runArtifactsResponseSchema,
  triggerRunResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";
import { eq } from "drizzle-orm";

// eslint-disable-next-line no-restricted-imports -- slice-7 E2E: drive the BUILT daemon modules (AD4 keeps them off the public index)
import { createFinalArtifactSync } from "../../daemon/dist/artifact-final-sync.js";
// eslint-disable-next-line no-restricted-imports
import { createArtifactHashCache } from "../../daemon/dist/artifact-hash-cache.js";
// eslint-disable-next-line no-restricted-imports
import { createArtifactSyncClient } from "../../daemon/dist/artifact-sync.js";
// eslint-disable-next-line no-restricted-imports
import { createArtifactTransport } from "../../daemon/dist/artifact-client.js";

import { closeDb, type Db, type DbHandle } from "./db/index.js";
import { artifactManifests, loops, runs } from "./db/schema.js";
import { bootstrapServer, type BootedServer } from "./start.js";
import { makeTestAuthConfig, seedClaimedMachineForToken, TEST_TEAM_ID } from "./testkit/index.js";

const TOKEN = "dk_slice7_e2e_machine";
const V1 = "console.log('v1')";
const V2 = "console.log('v2')";
const NOTES = "hello notes";
const OLD = "old file";

const handles: DbHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

let dataDir: string;

async function boot(): Promise<BootedServer> {
  dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-slice7-e2e-${process.pid}-`));
  dirs.push(dataDir);
  const b = await bootstrapServer({ auth: makeTestAuthConfig(), host: "127.0.0.1", port: 3000, dataDir });
  handles.push(b.handle);
  // Phase 5 Batch 3 slice 3: poll no longer self-registers — state the claimed
  // machine this daemon's token polls as.
  await seedClaimedMachineForToken(b.handle.db, TOKEN);
  return b;
}

/** Adapt the Hono app into the daemon's fetch (the daemon-e2e precedent). */
function appFetch(app: BootedServer["app"]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(url.pathname, init) as Promise<Response>;
  }) as typeof fetch;
}

async function getRun(db: Db, runId: string) {
  return (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
}

describe("slice 7 E2E: reads, download, diff and the R3 blob-missing composition", () => {
  it("two runs bind two snapshots; the reads serve the view, bytes, diff and the missing state; a deleted blob is the code-less 404", async () => {
    const b = await boot();
    const machineId = machineIdFromToken(TOKEN);

    // The real artifact tree. Canonicalized (macOS /var → /private/var): the
    // daemon's jail compares the realpath'd target against the roots verbatim
    // (the slice-6 fixture lesson).
    const artifactRoot = await realpath(await mkdtemp(path.join(tmpdir(), `loopzhb-slice7-artifacts-${process.pid}-`)));
    dirs.push(artifactRoot);
    await mkdir(path.join(artifactRoot, "dist"), { recursive: true });
    await writeFile(path.join(artifactRoot, "dist", "app.js"), V1);
    await writeFile(path.join(artifactRoot, "extra.txt"), OLD);
    const v2Hash = createHash("sha256").update(V2).digest("hex");
    const notesHash = createHash("sha256").update(NOTES).digest("hex");
    const oldHash = createHash("sha256").update(OLD).digest("hex");

    // The daemon: public index pieces + the BUILT artifact modules.
    const client = createMachineClient({ baseUrl: "http://e2e.local", machineCredential: TOKEN, fetchImpl: appFetch(b.app) });
    const syncClient = createArtifactSyncClient({
      transport: createArtifactTransport({ baseUrl: "http://e2e.local", machineCredential: TOKEN, fetchImpl: appFetch(b.app) }),
      cache: createArtifactHashCache(),
    });
    const finalSync = createFinalArtifactSync({ sync: syncClient, daemonRoots: [artifactRoot] });
    const fake = createFakeRunner();
    let runnerCalls = 0;
    const countingRunner: AgentRunner = {
      run: (delivery, ctx) => {
        runnerCalls += 1;
        return fake.run(delivery, ctx);
      },
    };
    const runtime = createDaemonRuntime({
      client,
      runner: countingRunner,
      identity: { host: "e2e-host", platform: "test", arch: "test", version: "0.1.0", capabilities: ["terminal-journal-v1", "artifact-sync-v1"] },
      pollMs: 3000,
      machineCredential: TOKEN,
      finalSync,
    });

    // 1. Register + create the artifact-configured loop.
    await runtime.pollOnce();
    const createRes = await b.app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, name: "e2e-loop", taskFile: "/srv/project/LOOP.md", artifactDir: artifactRoot }),
    });
    expect(createRes.status).toBe(201);
    const { loop } = createLoopResponseSchema.parse(await createRes.json());

    // Also an UNCONFIGURED loop: its run binds nothing and reads as missing.
    const plainRes = await b.app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, name: "plain-loop", taskFile: "/srv/project/LOOP.md" }),
    });
    const { loop: plainLoop } = createLoopResponseSchema.parse(await plainRes.json());

    const triggerRun = async (loopId: string): Promise<string> => {
      const res = await b.app.request(`/api/loops/${loopId}/run`, { method: "POST" });
      const body = triggerRunResponseSchema.parse(await res.json());
      if (!body.enqueued) throw new Error("expected the trigger to enqueue");
      return body.runId;
    };

    // 2. Run 1 binds snapshot 1 (dist/app.js v1 + extra.txt).
    const runId1 = await triggerRun(loop.id);
    await runtime.pollOnce();
    expect(runnerCalls).toBe(1);
    await runtime.executionSettled();
    const run1 = await getRun(b.handle.db, runId1);
    expect(run1.phase).toBe("done");
    const snapshot1 = run1.artifactSnapshotId!;
    expect(snapshot1).toBeTruthy();

    // The plain loop's run binds nothing.
    const plainRunId = await triggerRun(plainLoop.id);
    await runtime.pollOnce();
    await runtime.executionSettled();
    expect((await getRun(b.handle.db, plainRunId)).artifactSnapshotId).toBeNull();

    // 3. Edit: modify dist/app.js, add notes.txt, delete extra.txt → run 2.
    await writeFile(path.join(artifactRoot, "dist", "app.js"), V2);
    await writeFile(path.join(artifactRoot, "notes.txt"), NOTES);
    await rm(path.join(artifactRoot, "extra.txt"));
    const runId2 = await triggerRun(loop.id);
    await runtime.pollOnce();
    await runtime.executionSettled();
    const run2 = await getRun(b.handle.db, runId2);
    expect(run2.phase).toBe("done");
    const snapshot2 = run2.artifactSnapshotId!;
    expect(snapshot2).not.toBe(snapshot1);

    // ---- AV1: the current view serves run 2's file set with sync state ----
    const viewRes = await b.app.request(`/api/loops/${loop.id}/artifacts`);
    expect(viewRes.status).toBe(200);
    const view = loopArtifactsResponseSchema.parse(await viewRes.json());
    expect(view.files.map((f) => f.path).sort()).toEqual(["dist/app.js", "notes.txt"]);
    expect(view.manifestId).toBe(snapshot2);
    expect(view.stale).toBe(false);
    expect(view.sync.error).toBeNull();
    expect(view.sync.succeededAt).not.toBeNull();

    // ---- AV5: download bytes == the on-disk blob bytes ----
    const download = await b.app.request(
      `/api/loops/${loop.id}/artifacts/download?snapshotId=${snapshot2}&path=${encodeURIComponent("dist/app.js")}`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="app.js"');
    const downloaded = new Uint8Array(await download.arrayBuffer());
    const onDisk = await readFile(path.join(dataDir, "blobs", TEST_TEAM_ID, v2Hash));
    expect(Buffer.from(downloaded).equals(onDisk)).toBe(true);
    expect(Buffer.from(downloaded).toString()).toBe(V2);

    // ---- AV6: the structural diff shows exactly the three change classes ----
    const diffRes = await b.app.request(
      `/api/loops/${loop.id}/artifacts/diff?from=${snapshot1}&to=${snapshot2}`,
    );
    expect(diffRes.status).toBe(200);
    expect(artifactDiffResponseSchema.parse(await diffRes.json())).toEqual({
      loopId: loop.id,
      from: { snapshotId: snapshot1, manifestRevision: 1 },
      to: { snapshotId: snapshot2, manifestRevision: 2 },
      added: [{ path: "notes.txt", hash: notesHash, size: Buffer.byteLength(NOTES) }],
      modified: [
        {
          path: "dist/app.js",
          beforeHash: createHash("sha256").update(V1).digest("hex"),
          beforeSize: Buffer.byteLength(V1),
          afterHash: v2Hash,
          afterSize: Buffer.byteLength(V2),
        },
      ],
      removed: [{ path: "extra.txt", hash: oldHash, size: Buffer.byteLength(OLD) }],
    });

    // Omitted from = the empty-set baseline: everything is added.
    const baselineRes = await b.app.request(`/api/loops/${loop.id}/artifacts/diff?to=${snapshot2}`);
    expect(baselineRes.status).toBe(200);
    const baseline = artifactDiffResponseSchema.parse(await baselineRes.json());
    expect(baseline.from).toBeNull();
    expect(baseline.added.map((e) => e.path).sort()).toEqual(["dist/app.js", "notes.txt"]);

    // ---- AV7: the unbound run reads as the explicit missing state ----
    const missingRes = await b.app.request(`/api/runs/${plainRunId}/artifacts`);
    expect(missingRes.status).toBe(200);
    expect(runArtifactsResponseSchema.parse(await missingRes.json())).toEqual({
      runId: plainRunId,
      loopId: plainLoop.id,
      state: "missing",
    });
    // The bound run reads its frozen snapshot.
    const boundRes = await b.app.request(`/api/runs/${runId1}/artifacts`);
    expect(boundRes.status).toBe(200);
    const bound = runArtifactsResponseSchema.parse(await boundRes.json());
    expect(bound).toMatchObject({ state: "bound", snapshotId: snapshot1 });
    if (bound.state !== "bound") throw new Error("fixture must be bound");
    expect(bound.files.map((f) => f.path).sort()).toEqual(["dist/app.js", "extra.txt"]);

    // ---- R3: the blob file deleted under <dataDir>/blobs ⇒ the code-less 404 ----
    await rm(path.join(dataDir, "blobs", TEST_TEAM_ID, v2Hash));
    const gone = await b.app.request(
      `/api/loops/${loop.id}/artifacts/download?snapshotId=${snapshot2}&path=${encodeURIComponent("dist/app.js")}`,
    );
    expect(gone.status).toBe(404);
    const notFound = await b.app.request("/nope");
    expect(await gone.text()).toBe(await notFound.text());
    // The frozen 404 family carries no artifact code (never the table's 409).
    expect(gone.headers.get("content-type")).toBe(notFound.headers.get("content-type"));

    // The manifest row is untouched — history stays frozen (AR3).
    const manifest1 = (await b.handle.db.select().from(artifactManifests).where(eq(artifactManifests.id, snapshot1)))[0]!;
    expect(manifest1.entries.map((e) => e.path).sort()).toEqual(["dist/app.js", "extra.txt"]);
    const loopRow = (await b.handle.db.select().from(loops).where(eq(loops.id, loop.id)))[0]!;
    expect(loopRow.artifactManifestRevision).toBe(2);
  }, 90_000);
});
