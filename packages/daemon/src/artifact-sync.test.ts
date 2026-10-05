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

import type { ArtifactErrorCode, ArtifactWatchItem } from "@loopzhb/protocol";

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

/** A client whose backoff hangs until the signal aborts — for cancellation
 *  tests, which need the call parked INSIDE a sleep. */
function makeAbortableClient(): ArtifactSyncClient {
  return createArtifactSyncClient({
    transport: createArtifactTransport({
      baseUrl: "http://fake.invalid",
      machineCredential: CREDENTIAL,
      fetchImpl: server.fetchImpl,
    }),
    cache: createArtifactHashCache(),
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
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

describe("AS10 — 401/403 stops", () => {
  it("a 401 stops the whole machine and keeps making zero requests until cleared", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("read", { kind: "status", status: 401 });

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "stopped", scope: "machine", status: 401 });
    const before = server.calls.length;
    // Any loop, not just the one that saw the 401: the stop is machine-scoped.
    const other = await client.syncLoop({
      target: target({ loopId: "loop-2" }),
      daemonRoots: [base],
    });
    expect(other).toMatchObject({ kind: "stopped", scope: "machine", status: 401 });
    expect(server.calls.length).toBe(before);

    client.clearStops();
    expect((await sync()).kind).toBe("synced");
  });

  it("a 403 attribution_missing stops the machine and reports nothing", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("read", { kind: "status", status: 403, code: "artifact_attribution_missing" });

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "stopped", scope: "machine", status: 403 });
    expect(server.stepCalls("report")).toHaveLength(0);
  });
});

describe("AS11 — backoff, budgets and the upload gate", () => {
  it("backoff doubles from 1s, keeps one session, and ends at one revision", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("commit", { kind: "status", status: 500 });
    server.failNext("commit", { kind: "status", status: 500 });
    server.failNext("commit", { kind: "status", status: 500 });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(new Set(server.stepCalls("prepare").map((call) => call.requestId)).size).toBe(1);
    expect(new Set(server.stepCalls("commit").map((call) => call.syncId)).size).toBe(1);
    expect(loop().manifestRevision).toBe(1);
  });

  it("caps the backoff delay at 60s", async () => {
    write("a.txt", "alpha");
    start({ maxAttempts: 9 });
    for (let index = 0; index < 9; index += 1) server.failNext("read", { kind: "network_error" });

    const outcome = await sync();

    expect(outcome.kind).toBe("unavailable");
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("keeps at most 4 PUTs in flight across 5 loops", async () => {
    const loopIds = ["loop-0", "loop-1", "loop-2", "loop-3", "loop-4"];
    for (const loopId of loopIds) write(`${loopId}/file.txt`, `content of ${loopId}`);
    server = createFakeArtifactServer({
      machineCredential: CREDENTIAL,
      loops: loopIds.map((loopId) => ({ loopId, artifactDir: path.join(base, loopId) })),
    });
    client = makeClient();

    const release = server.holdPuts();
    const all = Promise.all(
      loopIds.map((loopId) =>
        client.syncLoop({
          target: { loopId, artifactDir: path.join(base, loopId), workdir: null, roots: [], configRevision: 1 },
          daemonRoots: [base],
        }),
      ),
    );
    await until(() => server.stepCalls("put").length === 4);
    // Give a broken (unbounded) gate time to send the fifth.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.stepCalls("put")).toHaveLength(4);
    expect(server.maxConcurrentPuts).toBe(4);
    release();

    const outcomes = await all;
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["synced", "synced", "synced", "synced", "synced"]);
    expect(server.maxConcurrentPuts).toBe(4);
  });

  it("serializes two calls for the same loop and lets the second see the first's result", async () => {
    write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const first = sync();
    await until(() => server.stepCalls("put").length === 1);
    const second = sync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The queued call has not issued anything while the first still runs.
    expect(server.stepCalls("prepare")).toHaveLength(1);
    release();

    expect((await first).kind).toBe("synced");
    expect(await second).toEqual({ kind: "unchanged" });
    expect(server.stepCalls("prepare")).toHaveLength(1);
  });
});

describe("numbered-outside evidence", () => {
  it("suppression needs content AND generation: a changed tree re-negotiates", async () => {
    const alpha = write("a.txt", "alpha");
    start();
    expect(await sync()).toMatchObject({ kind: "synced", manifestRevision: 1 });

    write("b.txt", "beta");
    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 2, uploaded: 1 });
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    // A different payload must be a different idempotency key.
    expect(prepares[1]!.requestId).not.toBe(prepares[0]!.requestId);
    expect(prepares[1]!.baseManifestRevision).toBe(1);
    expect(server.blobs.has(alpha.hash)).toBe(true);
  });

  it("a round whose commit response was lost invalidates the record: a revert still re-negotiates", async () => {
    write("a.txt", "alpha");
    start();
    expect((await sync()).kind).toBe("synced");
    write("a.txt", "beta");
    for (let index = 0; index < 6; index += 1) server.failNext("commit", { kind: "throw_after_apply" });

    const lost = await sync();

    expect(lost.kind).toBe("unavailable");
    // The commit DID land: the first attempt advanced the server's pointer.
    expect(loop().manifestRevision).toBe(2);
    write("a.txt", "alpha");
    const before = server.calls.length;

    const recovered = await sync();

    // Without the invalidation rule this would suppress (the content equals the
    // last recorded manifest) and leave the server on `beta` forever.
    expect(server.calls.length).toBeGreaterThan(before);
    expect(recovered).toMatchObject({ kind: "synced", manifestRevision: 3 });
  });

  it("uploads the verified bytes, and a rewrite during the PUT is the NEXT sync's business", async () => {
    const alpha = write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const inflight = sync();
    await until(() => server.stepCalls("put").length === 1);
    write("a.txt", "gamma");
    release();

    const outcome = await inflight;

    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 1 });
    // The wire carried the verified bytes (the server re-hashes and would have
    // refused anything else), so the committed manifest is a point-in-time
    // snapshot — the documented residual. The next full check commits gamma.
    expect(server.stepCalls("put")[0]!.bodyDigest).toBe(alpha.hash);
    expect(server.blobs.get(alpha.hash)!.bytes.toString("utf8")).toBe("alpha");
    expect(await sync()).toMatchObject({ kind: "synced", manifestRevision: 2 });
  });

  it("catches a tree that moved between the scan and the upload, before any PUT", async () => {
    const alpha = write("a.txt", "alpha");
    start();
    // The tree changes after the scan's read and before the negotiation
    // returns: pre-upload verification is what must refuse the stale bytes.
    let rewritten = false;
    server.beforePrepare = () => {
      rewritten = true;
      write("a.txt", "beta");
    };

    const outcome = await sync();

    expect(rewritten).toBe(true);
    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 1 });
    // The stale hash never reached the wire, and the second prepare carried
    // the rescanned manifest.
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[0]!.bodyDigest).not.toBe(prepares[1]!.bodyDigest);
    expect(server.stepCalls("put").some((call) => call.hash === alpha.hash)).toBe(false);
  });

  it("renegotiates from a fresh base when the server's revision moved underneath", async () => {
    write("a.txt", "alpha");
    start();
    await sync();
    // Another actor advanced the loop while this client was idle.
    loop().manifestRevision = 5;
    loop().manifest = [];
    write("a.txt", "beta");

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 6 });
    const prepares = server.stepCalls("prepare");
    // First prepare carried the stale base 1 and was refused; the re-read
    // supplied base 5, and the changed payload minted a new requestId.
    expect(prepares[1]!.baseManifestRevision).toBe(1);
    expect(prepares.at(-1)!.baseManifestRevision).toBe(5);
    expect(prepares.at(-1)!.requestId).not.toBe(prepares[1]!.requestId);
  });

  it("a stale report is `stale`, sent exactly once", async () => {
    write("a.txt", "alpha");
    start();
    // The loop's base moved on: the report's generation/base no longer match.
    loop().manifestRevision = 5;

    const outcome = await sync({ target: target({ artifactDir: path.join(base, "gone") }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "directory_missing", reported: "stale" });
    expect(server.stepCalls("report")).toHaveLength(1);
  });

  it("an unreachable report is `unreported`, and is never retried", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("report", { kind: "network_error" });

    const outcome = await sync({ target: target({ artifactDir: path.join(base, "gone") }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "directory_missing", reported: "unreported" });
    expect(server.stepCalls("report")).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("surfaces a config generation mismatch as config_changed, without negotiating", async () => {
    write("a.txt", "alpha");
    start();

    const outcome = await sync({ target: target({ configRevision: 2 }) });

    expect(outcome).toMatchObject({ kind: "config_changed" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
  });

  it("surfaces a config conflict at prepare as config_changed", async () => {
    write("a.txt", "alpha");
    start();
    await sync();
    loop().configRevision = 2; // the server moved to a new generation
    write("b.txt", "beta"); // force a real attempt (no suppression)

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "config_changed" });
  });

  it("resumes a commit that reports a missing blob by re-preparing the same payload", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("commit", { kind: "status", status: 409, code: "artifact_blob_missing" });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[1]!.requestId).toBe(prepares[0]!.requestId);
    expect(loop().manifestRevision).toBe(1);
  });

  it("fetches the receipt when a PUT says the session is already committed", async () => {
    write("a.txt", "alpha");
    start();
    // A competing commit lands while our PUT is in flight: the server refuses
    // it for real, and the receipt must come back with NO second PUT.
    server.beforePut = (session) => server.commitSession(session.syncId);

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 1 });
    expect(server.stepCalls("put")).toHaveLength(1);
    expect(server.stepCalls("commit")).toHaveLength(1);
    expect(server.blobs.size).toBe(0);
  });

  it("re-negotiates a hash the server says was never negotiated", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("put", { kind: "status", status: 409, code: "artifact_hash_not_negotiated" });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(2);
    expect(prepares[1]!.requestId).toBe(prepares[0]!.requestId);
  });

  it.each<[ArtifactErrorCode, number, ArtifactSyncOutcome["kind"]]>([
    ["artifact_validation_failed", 400, "terminal"],
    ["artifact_revision_exhausted", 409, "terminal"],
  ])("maps a %s refusal at prepare to %s", async (code, status, expected) => {
    write("a.txt", "alpha");
    start();
    server.failNext("prepare", { kind: "status", status, code });

    const outcome = await sync();

    expect(outcome.kind).toBe(expected);
  });

  it("recovers from a content mismatch with one bounded rescan", async () => {
    write("a.txt", "alpha");
    start();
    server.failNext("put", { kind: "status", status: 400, code: "artifact_content_mismatch" });

    const outcome = await sync();

    expect(outcome.kind).toBe("synced");
    expect(loop().manifestRevision).toBe(1);
  });

  it("cancels during the backoff without a further request or a report", async () => {
    write("a.txt", "alpha");
    start();
    server.offline = true;
    client = makeAbortableClient();
    const controller = new AbortController();
    const inflight = sync({ signal: controller.signal });
    await until(() => server.calls.length === 1);

    controller.abort();
    const outcome = await inflight;

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(server.calls).toHaveLength(1);
    expect(server.stepCalls("report")).toHaveLength(0);
  });

  it("cancels a call that is still queued without issuing anything", async () => {
    write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const first = sync();
    await until(() => server.stepCalls("put").length === 1);
    const controller = new AbortController();
    const queued = sync({ signal: controller.signal });
    controller.abort();
    release();

    expect((await first).kind).toBe("synced");
    expect(await queued).toEqual({ kind: "cancelled" });
    expect(server.stepCalls("prepare")).toHaveLength(1);
  });

  it("settled() waits for queued work and resolves only once the queue drains", async () => {
    write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const first = sync();
    await until(() => server.stepCalls("put").length === 1);
    const queued = sync();
    let settled = false;
    const waiter = client.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await Promise.all([first, queued]);
    await waiter;

    expect(settled).toBe(true);
  });

  it("freshSession mints a new session even when nothing changed", async () => {
    write("a.txt", "alpha");
    start();
    await sync();
    const preparesBefore = server.stepCalls("prepare").length;

    const outcome = await sync({ freshSession: true });

    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 2, uploaded: 0 });
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(preparesBefore + 1);
    expect(prepares.at(-1)!.requestId).not.toBe(prepares.at(-2)!.requestId);
    expect(server.stepCalls("commit")).toHaveLength(2);
  });
});
