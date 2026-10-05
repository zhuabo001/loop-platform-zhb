/**
 * Slice 4 acceptance (Batch 2 plan §3, AS1–AS6/AS9–AS11) driven through the
 * in-memory fake server (src/testkit/artifact-sync-fake.ts). Every test states
 * the mutation that would make it red in its name or its assertion comment.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactWatchItem } from "@loopzhb/protocol";

import { createArtifactTransport } from "./artifact-client.js";
import { createArtifactHashCache } from "./artifact-hash-cache.js";
import {
  createArtifactSyncClient,
  type ArtifactSyncClient,
  type ArtifactSyncInput,
  type ArtifactSyncOutcome,
} from "./artifact-sync.js";
import { createFakeArtifactServer, type FakeArtifactServer } from "./testkit/artifact-sync-fake.js";

const CREDENTIAL = "dk_slice4_fixture_credential";
const LOOP_ID = "loop-1";

let base: string;
let extraDirs: string[];
let server: FakeArtifactServer;
let client: ArtifactSyncClient;
let delays: number[];

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-artifact-sync-test-"));
  extraDirs = [];
  delays = [];
});

afterEach(() => {
  for (const dir of [base, ...extraDirs]) rmSync(dir, { recursive: true, force: true });
});

function write(relativePath: string, content: string): { hash: string; bytes: Buffer } {
  const absolute = path.join(base, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const bytes = Buffer.from(content, "utf8");
  writeFileSync(absolute, bytes);
  return { hash: createHash("sha256").update(bytes).digest("hex"), bytes };
}

function start(options: { artifactDir?: string | null; uploadConcurrency?: number; maxAttempts?: number } = {}): void {
  server = createFakeArtifactServer({
    machineCredential: CREDENTIAL,
    loops: [
      {
        loopId: LOOP_ID,
        artifactDir: options.artifactDir === undefined ? base : options.artifactDir,
      },
    ],
  });
  client = makeClient(options);
}

/** A client over the CURRENT fake server — a second call models a restarted
 *  daemon process (no in-process baseline). */
function makeClient(options: { uploadConcurrency?: number; maxAttempts?: number } = {}): ArtifactSyncClient {
  return createArtifactSyncClient({
    transport: createArtifactTransport({
      baseUrl: "http://fake.invalid",
      machineCredential: CREDENTIAL,
      fetchImpl: server.fetchImpl,
    }),
    cache: createArtifactHashCache(),
    // Time is injected, never faked: the delay sequence IS the evidence.
    sleep: async (ms) => {
      delays.push(ms);
    },
    uploadConcurrency: options.uploadConcurrency,
    maxAttempts: options.maxAttempts,
  });
}

function target(overrides: Partial<ArtifactWatchItem> = {}): ArtifactWatchItem {
  return { loopId: LOOP_ID, artifactDir: base, workdir: null, roots: [], configRevision: 1, ...overrides };
}

function sync(overrides: Partial<ArtifactSyncInput> = {}): Promise<ArtifactSyncOutcome> {
  return client.syncLoop({ target: target(), daemonRoots: [base], ...overrides });
}

/** Poll until a condition holds, with a deadline so a regression FAILS instead
 *  of wedging the suite. */
async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("deadline exceeded waiting for the in-flight request");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function loop(): NonNullable<ReturnType<FakeArtifactServer["loops"]["get"]>> {
  return server.loops.get(LOOP_ID)!;
}

describe("AS1 — an unreachable server", () => {
  it("exhausts the attempt budget with 1/2/4/8/16s backoff and reports nothing", async () => {
    write("a.txt", "alpha");
    start();
    server.offline = true;

    const outcome = await sync();

    expect(outcome).toEqual({ kind: "unavailable", detail: expect.any(String) });
    // 6 attempts total ⇒ 5 delays; the cap (60s) is never reached here.
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(server.calls).toHaveLength(6);
    // A network failure is NOT a local scan failure: no doomed error report.
    expect(server.stepCalls("report")).toHaveLength(0);
    await client.settled();
  });
});

describe("AS2 — a lost prepare response", () => {
  it("retries the identical bytes under the same requestId and reuses the session", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("prepare", { kind: "throw_after_apply" });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[1]!.requestId).toBe(prepares[0]!.requestId);
    expect(prepares[1]!.bodyDigest).toBe(prepares[0]!.bodyDigest);
    expect(server.sessions.size).toBe(1);
    expect(server.stepCalls("put")).toHaveLength(1);
    expect(server.stepCalls("commit")).toHaveLength(1);
    expect(loop().manifestRevision).toBe(1);
  });
});

describe("AS3 — a lost PUT response", () => {
  it("re-sends the same hash, observes the dedupe, and uploads only needHashes", async () => {
    const alpha = write("a.txt", "alpha");
    const beta = write("b.txt", "beta");
    start();
    // Already on the server: it must never be uploaded at all.
    server.seedBlob(alpha.hash, alpha.bytes);
    server.failNext("put", { kind: "throw_after_apply" });

    const outcome = await sync();

    expect(outcome).toEqual({ kind: "synced", manifestRevision: 1, artifactSnapshotId: expect.any(String), uploaded: 1 });
    expect(server.putCount(beta.hash)).toBe(2);
    // The retry is the same operation: the key already exists (published:false).
    expect(server.stepCalls("put")[1]!.published).toBe(false);
    expect(server.putCount(alpha.hash)).toBe(0);
    expect(server.stepCalls("prepare")).toHaveLength(1);
    expect(loop().manifestRevision).toBe(1);
  });
});

describe("AS4 — a lost commit response", () => {
  it("replays to the same fixed receipt and leaves exactly one revision", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("commit", { kind: "throw_after_apply" });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    const commits = server.stepCalls("commit");
    expect(commits).toHaveLength(2);
    expect(commits[1]!.syncId).toBe(commits[0]!.syncId);
    expect(loop().manifestRevision).toBe(1);
    expect(server.sessions.size).toBe(1);

    // The receipt was recovered, so the record is trustworthy: the next
    // identical call must say nothing to the server at all.
    const before = server.calls.length;
    expect(await sync()).toEqual({ kind: "unchanged" });
    expect(server.calls.length).toBe(before);
  });
});

describe("AS5 — a session lost server-side", () => {
  it("re-negotiates the same payload (same requestId) after a restart drops it", async () => {
    write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const inflight = sync();
    await until(() => server.stepCalls("put").length === 1);
    server.dropSessions();
    release();

    const outcome = await inflight;

    expect(outcome.kind).toBe("synced");
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[1]!.requestId).toBe(prepares[0]!.requestId);
    // The recreated session is a NEW session; the commit that raced the
    // restart got the code-less 404 and was re-run against the new one.
    expect(new Set(server.stepCalls("commit").map((call) => call.syncId)).size).toBe(2);
    expect(loop().manifestRevision).toBe(1);
  });

  it("renews an expired session in place: one requestId, one syncId", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("put", { kind: "status", status: 409, code: "artifact_session_expired" });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[1]!.requestId).toBe(prepares[0]!.requestId);
    expect(new Set(server.stepCalls("put").map((call) => call.syncId)).size).toBe(1);
    expect(server.sessions.size).toBe(1);
    expect(loop().manifestRevision).toBe(1);
  });
});

describe("AS6 — a restarted daemon", () => {
  it("rebuilds the base from the server, commits, then suppresses", async () => {
    write("a.txt", "alpha");
    start();
    const first = await sync();
    expect(first).toMatchObject({ kind: "synced", manifestRevision: 1 });

    // A new process: no in-process baseline, so it must ask the server.
    const restarted = makeClient();
    const second = await restarted.syncLoop({ target: target(), daemonRoots: [base] });

    expect(second).toMatchObject({ kind: "synced", manifestRevision: 2, uploaded: 0 });
    expect((second as { artifactSnapshotId: string }).artifactSnapshotId).not.toBe(
      (first as { artifactSnapshotId: string }).artifactSnapshotId,
    );
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[0]!.baseManifestRevision).toBe(0);
    expect(prepares[1]!.baseManifestRevision).toBe(1);
    // One baseline read per process (each instance starts with no record).
    expect(server.stepCalls("read")).toHaveLength(2);
    // Identical content still minted a revision: accepted residual (no
    // server-side content equality, ADR-010 决策 11).
    expect(loop().manifestRevision).toBe(2);

    const before = server.calls.length;
    expect(await restarted.syncLoop({ target: target(), daemonRoots: [base] })).toEqual({ kind: "unchanged" });
    expect(server.calls.length).toBe(before);
  });
});

describe("AS9 — roots and jail changes", () => {
  it("fails a vanished directory closed, with a report and zero sync requests", async () => {
    start();
    const outcome = await sync({ target: target({ artifactDir: path.join(base, "gone") }) });

    expect(outcome).toEqual({
      kind: "failed",
      failure: "directory_missing",
      detail: expect.any(String),
      reported: "recorded",
    });
    expect(server.stepCalls("prepare")).toHaveLength(0);
    expect(server.stepCalls("put")).toHaveLength(0);
    expect(server.stepCalls("commit")).toHaveLength(0);
    expect(loop().syncError).toEqual({ failure: "directory_missing", configRevision: 1, baseManifestRevision: 0 });
  });

  it("fails a roots narrowing that no longer intersects the daemon roots", async () => {
    write("a.txt", "alpha");
    const elsewhere = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-artifact-sync-other-"));
    extraDirs.push(elsewhere);
    start();

    const outcome = await sync({ target: target({ roots: [elsewhere] }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "outside_jail", reported: "recorded" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
    expect(loop().syncError?.failure).toBe("outside_jail");
  });

  it("fails the whole sync on an in-tree symlink, without reading or uploading", async () => {
    write("a.txt", "alpha");
    symlinkSync(path.join(base, "a.txt"), path.join(base, "link"));
    start();

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "failed", failure: "symlink", reported: "recorded" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
    expect(server.stepCalls("put")).toHaveLength(0);
  });
});
