/**
 * Phase 5 Batch 2 slice 6 cross-package E2E (plan §3 AR1/AR3): the BUILT
 * @loopzhb/daemon drives a real booted server (file-backed PGlite via
 * bootstrapServer, Hono app.request adapted into the daemon's injectable
 * fetch — the daemon-e2e precedent), with the REAL artifact sync client and
 * a REAL temp artifact directory:
 *
 *   register → create loop WITH artifactDir → trigger → claim (the delivery
 *   carries the pinned artifact generation) → fake runner → RUN-FINAL SYNC
 *   (fresh session, full rehash, real prepare→PUT→commit over the app's
 *   routes) → report carries artifactSnapshotId → the report transaction
 *   BINDS it → a second run after an edit binds a NEW snapshot while the
 *   first run's snapshot and manifest stay frozen (AR3).
 *
 * The daemon's public index deliberately does NOT export the artifact
 * modules (AD4), so this test deep-imports the BUILT dist files — the same
 * "verify what ships" convention as the slice-4/5 dist probes.
 */
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDaemonRuntime, createFakeRunner, createMachineClient, type AgentRunner } from "@loopzhb/daemon";
import { createLoopResponseSchema, triggerRunResponseSchema } from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";
import { eq } from "drizzle-orm";

// eslint-disable-next-line no-restricted-imports -- slice-6 E2E: drive the BUILT daemon modules (AD4 keeps them off the public index)
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

const TOKEN = "dk_slice6_e2e_machine";
const handles: DbHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
});

async function boot(): Promise<BootedServer> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-slice6-e2e-${process.pid}-`));
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

describe("slice 6 E2E: run-final sync binds the snapshot inside the report transaction", () => {
  it("two runs bind two snapshots; the first run's snapshot survives later edits (AR1/AR3)", async () => {
    const b = await boot();
    const machineId = machineIdFromToken(TOKEN);

    // The real artifact tree the daemon will scan. Canonicalized (macOS
    // /var → /private/var): the daemon's jail compares the realpath'd target
    // against the roots verbatim, and production cli.ts hands it
    // already-canonical roots — mirror that here.
    const artifactRoot = await realpath(await mkdtemp(path.join(tmpdir(), `loopzhb-slice6-artifacts-${process.pid}-`)));
    await mkdir(path.join(artifactRoot, "dist"), { recursive: true });
    await writeFile(path.join(artifactRoot, "dist", "app.js"), "console.log('v1')");
    const v1Hash = createHash("sha256").update("console.log('v1')").digest("hex");

    // The daemon: public index pieces + the BUILT artifact modules (deep
    // dist imports — verify what ships).
    const client = createMachineClient({ baseUrl: "http://e2e.local", machineCredential: TOKEN, fetchImpl: appFetch(b.app) });
    const syncClient = createArtifactSyncClient({
      transport: createArtifactTransport({ baseUrl: "http://e2e.local", machineCredential: TOKEN, fetchImpl: appFetch(b.app) }),
      cache: createArtifactHashCache(),
    });
    const finalSync = createFinalArtifactSync({ sync: syncClient, daemonRoots: [artifactRoot] });
    let runnerCalls = 0;
    const fake = createFakeRunner();
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

    // 1. Register, then create the artifact-configured loop over HTTP.
    await runtime.pollOnce();
    const createRes = await b.app.request("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, name: "e2e-loop", taskFile: "/srv/project/LOOP.md", artifactDir: artifactRoot }),
    });
    expect(createRes.status).toBe(201);
    const { loop } = createLoopResponseSchema.parse(await createRes.json());
    expect(loop.artifactDir).toBe(artifactRoot);

    // 2. Run 1: claim → fake run → final sync → report binds the snapshot.
    const trigger1 = await b.app.request(`/api/loops/${loop.id}/run`, { method: "POST" });
    expect(trigger1.status).toBe(202);
    const trigger1Body = triggerRunResponseSchema.parse(await trigger1.json());
    if (!trigger1Body.enqueued) throw new Error("expected the trigger to enqueue");
    const runId1 = trigger1Body.runId;

    await runtime.pollOnce();
    expect(runnerCalls).toBe(1);
    await runtime.executionSettled();
    expect(runtime.pendingCount()).toBe(0);

    const run1 = await getRun(b.handle.db, runId1);
    expect(run1.phase).toBe("done");
    expect(run1.artifactSyncError).toBeNull();
    const snapshotId1 = run1.artifactSnapshotId;
    expect(snapshotId1).toBeTruthy();

    // The bound manifest is real: committed, generation-pinned, and carries
    // the file's actual hash.
    const manifest1 = (await b.handle.db.select().from(artifactManifests).where(eq(artifactManifests.id, snapshotId1!)))[0]!;
    expect(manifest1).toMatchObject({
      // Phase 5 Batch 3 slice 3: the namespace is the OWNING TEAM.
      namespaceId: TEST_TEAM_ID,
      machineId,
      loopId: loop.id,
      configRevision: 1,
      manifestRevision: 1,
      fileCount: 1,
    });
    expect(manifest1.entries).toEqual([{ path: "dist/app.js", hash: v1Hash, size: Buffer.byteLength("console.log('v1')") }]);
    const loopRow1 = (await b.handle.db.select().from(loops).where(eq(loops.id, loop.id)))[0]!;
    expect(loopRow1).toMatchObject({ artifactManifestId: snapshotId1, artifactManifestRevision: 1, artifactSyncError: null });

    // 3. Edit the tree, run 2: a FRESH session mints a second snapshot…
    await writeFile(path.join(artifactRoot, "dist", "app.js"), "console.log('v2')");
    const trigger2 = await b.app.request(`/api/loops/${loop.id}/run`, { method: "POST" });
    const trigger2Body = triggerRunResponseSchema.parse(await trigger2.json());
    if (!trigger2Body.enqueued) throw new Error("expected the trigger to enqueue");
    const runId2 = trigger2Body.runId;
    await runtime.pollOnce();
    await runtime.executionSettled();

    const run2 = await getRun(b.handle.db, runId2);
    expect(run2.phase).toBe("done");
    expect(run2.artifactSnapshotId).toBeTruthy();
    expect(run2.artifactSnapshotId).not.toBe(snapshotId1);

    // …and run 1's snapshot and manifest are FROZEN (AR3): later edits and
    // later syncs never rewrite history.
    const run1After = await getRun(b.handle.db, runId1);
    expect(run1After.artifactSnapshotId).toBe(snapshotId1);
    const manifest1After = (await b.handle.db.select().from(artifactManifests).where(eq(artifactManifests.id, snapshotId1!)))[0]!;
    expect(manifest1After.entries).toEqual(manifest1.entries);
    const loopRow2 = (await b.handle.db.select().from(loops).where(eq(loops.id, loop.id)))[0]!;
    expect(loopRow2.artifactManifestRevision).toBe(2);
  }, 60_000);
});
