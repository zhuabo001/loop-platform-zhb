/**
 * AH5/AH6 — the slice-2 acceptance the plan words as "真实 HTTP 完成
 * prepare → PUT → commit": the FULL production assembly (bootstrapServer →
 * file-backed PGlite + the real local BlobStore under `<dataDir>/blobs`), a
 * REAL listener, and fetch. No internal shortcut: the machine enrolls itself
 * through poll, the loop is created through POST /api/loops with its
 * artifactDir, and every sync step rides the mounted routes.
 *
 * Also covered here: the CHUNKED prepare cap (a streamed oversize body is
 * rejected at the transport gate — the app.request-level suite can only
 * drive the content-length path), and the on-disk blob bytes.
 *
 * PGlite single-connection evidence; the multi-physical-connection acceptance
 * stays with #11/#72.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES,
  ARTIFACT_SYNC_ID_HEADER,
  commitArtifactSyncResponseSchema,
  createLoopResponseSchema,
  prepareArtifactSyncResponseSchema,
  putArtifactBlobResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { artifactManifests, loops } from "./db/schema.js";
import { FakeClock, makeTestAuthConfig } from "./testkit/index.js";
import { bootstrapServer, waitForListening } from "./start.js";

const TOKEN = "dk_e2e_batch2_slice2_token";
const CONTENT = "artifact payload — batch 2 slice 2 e2e";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => {});
});

interface Harness {
  base: string;
  dataDir: string;
  handle: DbHandle;
  close: () => Promise<void>;
}

async function bootRealServer(): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "loopzhb-slice2-e2e-"));
  const booted = await bootstrapServer(
    { auth: makeTestAuthConfig(), host: "127.0.0.1", port: 0, dataDir },
    { clock: new FakeClock() },
  );
  const server: ServerType = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
  await waitForListening(server);
  const { port } = server.address() as AddressInfo;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb(booted.handle);
    await fs.rm(dataDir, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { base: `http://127.0.0.1:${port}`, dataDir, handle: booted.handle, close };
}

const machineHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});

async function enrollMachine(base: string): Promise<void> {
  const res = await fetch(`${base}/api/machine/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", ...machineHeaders() },
    body: JSON.stringify({ capabilities: ["terminal-journal-v1", "artifact-sync-v1"] }),
  });
  expect(res.status).toBe(200);
}

async function createConfiguredLoop(base: string, artifactDir: string): Promise<string> {
  const res = await fetch(`${base}/api/loops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineId: machineIdFromToken(TOKEN),
      taskFile: "/home/dev/TASK.md",
      artifactDir,
    }),
  });
  expect(res.status).toBe(201);
  const body = createLoopResponseSchema.parse(await res.json());
  expect(body.loop.artifactDir).toBe(artifactDir);
  return body.loop.id;
}

describe("AH5: the real-HTTP prepare → chunked PUT → commit chain", () => {
  it("syncs a file end to end and lands the bytes under <dataDir>/blobs", async () => {
    const harness = await bootRealServer();
    await enrollMachine(harness.base);
    const loopId = await createConfiguredLoop(harness.base, "/home/dev/project/dist");

    const bytes = new TextEncoder().encode(CONTENT);
    const hash = createHash("sha256").update(bytes).digest("hex");

    const prepare = await fetch(`${harness.base}/api/machine/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", ...machineHeaders() },
      body: JSON.stringify({
        requestId: "req-e2e-1",
        loopId,
        configRevision: 1,
        baseManifestRevision: 0,
        entries: [{ path: "dist/bundle.js", hash, size: bytes.byteLength }],
      }),
    });
    expect(prepare.status).toBe(200);
    const negotiate = prepareArtifactSyncResponseSchema.parse(await prepare.json());
    expect(negotiate.needHashes).toEqual([hash]);

    // A CHUNKED upload: three chunks through a real socket, so the streamed
    // route path (never buffered by the adapter) is what runs.
    const chunks = [bytes.slice(0, 5), bytes.slice(5, 11), bytes.slice(11)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const put = await fetch(`${harness.base}/api/machine/blob/${hash}`, {
      method: "PUT",
      headers: { [ARTIFACT_SYNC_ID_HEADER]: negotiate.syncId, ...machineHeaders() },
      body: stream,
      // undici requires `duplex` for stream bodies (the DOM types omit it).
      duplex: "half",
    });
    expect(put.status).toBe(200);
    expect(putArtifactBlobResponseSchema.parse(await put.json())).toEqual({
      ok: true,
      size: bytes.byteLength,
      published: true,
    });

    const commit = await fetch(`${harness.base}/api/machine/sync/${negotiate.syncId}/commit`, {
      method: "POST",
      headers: machineHeaders(),
    });
    expect(commit.status).toBe(200);
    const receipt = commitArtifactSyncResponseSchema.parse(await commit.json());
    expect(receipt.manifestRevision).toBe(1);

    // The bytes are on disk at the production path, byte-for-byte.
    const blobPath = path.join(harness.dataDir, "blobs", machineIdFromToken(TOKEN), hash);
    expect(await fs.readFile(blobPath)).toEqual(Buffer.from(bytes));

    // The loop's pointer advanced to the receipt's snapshot.
    const [row] = await harness.handle.db.select().from(loops).where(eq(loops.id, loopId));
    expect(row!.artifactManifestId).toBe(receipt.artifactSnapshotId);
    expect(row!.artifactManifestRevision).toBe(1);
    expect(row!.artifactSyncError).toBeNull();
    expect(row!.artifactSyncSucceededAt).not.toBeNull();

    // Replays over real HTTP: the same bytes publish:false, the same commit
    // returns the FIXED receipt with no second manifest.
    const replayPut = await fetch(`${harness.base}/api/machine/blob/${hash}`, {
      method: "PUT",
      headers: { [ARTIFACT_SYNC_ID_HEADER]: negotiate.syncId, ...machineHeaders() },
      body: bytes,
    });
    // A committed session refuses the PUT before the bytes matter.
    expect(replayPut.status).toBe(409);
    await replayPut.body?.cancel();

    const replayCommit = await fetch(`${harness.base}/api/machine/sync/${negotiate.syncId}/commit`, {
      method: "POST",
      headers: machineHeaders(),
    });
    expect(replayCommit.status).toBe(200);
    expect(commitArtifactSyncResponseSchema.parse(await replayCommit.json())).toEqual(receipt);

    const manifests = await harness.handle.db.select().from(artifactManifests);
    expect(manifests).toHaveLength(1);
  });

  it("rejects a CHUNKED body over the 8 MiB prepare cap at the transport gate", async () => {
    const harness = await bootRealServer();
    await enrollMachine(harness.base);
    const oversize = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES));
        controller.enqueue(new Uint8Array(1)); // one byte past the cap
        controller.close();
      },
    });
    const res = await fetch(`${harness.base}/api/machine/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", ...machineHeaders() },
      body: oversize,
      duplex: "half",
    });
    expect(res.status).toBe(413);
    await res.body?.cancel();
  });
});
