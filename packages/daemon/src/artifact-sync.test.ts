/**
 * Slice 4 acceptance (Batch 2 plan §3, AS1–AS6/AS9–AS11) driven through the
 * in-memory fake server (src/testkit/artifact-sync-fake.ts). Every test states
 * the mutation that would make it red in its name or its assertion comment.
 */
import { createHash } from "node:crypto";
import { promises as fs, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactErrorCode, ArtifactWatchItem } from "@loopzhb/protocol";

import { createArtifactTransport } from "./artifact-client.js";
import { createArtifactHashCache, type ArtifactHashCache } from "./artifact-hash-cache.js";
import type { ArtifactScanIo } from "./artifact-scan.js";
import {
  createArtifactSyncClient,
  createGate,
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

function start(
  options: {
    artifactDir?: string | null;
    uploadConcurrency?: number;
    maxAttempts?: number;
    cache?: ArtifactHashCache;
    io?: ArtifactScanIo;
  } = {},
): void {
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
function makeClient(
  options: {
    uploadConcurrency?: number;
    maxAttempts?: number;
    cache?: ArtifactHashCache;
    io?: ArtifactScanIo;
    fetchImpl?: typeof fetch;
  } = {},
): ArtifactSyncClient {
  return createArtifactSyncClient({
    transport: createArtifactTransport({
      baseUrl: "http://fake.invalid",
      machineCredential: CREDENTIAL,
      fetchImpl: options.fetchImpl ?? server.fetchImpl,
    }),
    cache: options.cache ?? createArtifactHashCache(),
    // Time is injected, never faked: the delay sequence IS the evidence.
    sleep: async (ms) => {
      delays.push(ms);
    },
    uploadConcurrency: options.uploadConcurrency,
    maxAttempts: options.maxAttempts,
    io: options.io,
  });
}

/** A cache whose write-back throws for one path ONCE ARMED: an ALLOWED
 *  interface fault (no monkey-patching), i.e. an internal exception inside one
 *  upload group while its siblings keep going. The scanner writes the cache
 *  too, so the test arms it after the scan (at prepare time) — the fault then
 *  lands in the pre-upload verification. */
function faultingCacheOn(
  suffix: string,
  error: unknown = new Error("injected cache fault"),
): { cache: ArtifactHashCache; arm: () => void } {
  const real = createArtifactHashCache();
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    cache: {
      get: (absolutePath) => real.get(absolutePath),
      set: (absolutePath, entry) => {
        if (armed && absolutePath.endsWith(suffix)) throw error;
        real.set(absolutePath, entry);
      },
      delete: (absolutePath) => real.delete(absolutePath),
      clear: () => real.clear(),
      get size() {
        return real.size;
      },
    },
  };
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
    const gone = path.join(base, "gone");
    // The server's config points at the same path, so this is a LOCAL failure
    // (the directory vanished), not a config generation change.
    start({ artifactDir: gone });
    const outcome = await sync({ target: target({ artifactDir: gone }) });

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

  it("surfaces a watch target that disagrees with the server's dir as config_changed", async () => {
    write("a.txt", "alpha");
    start();
    // The baseline read is what proves the target is stale, and it happens
    // BEFORE any local work — so no failure is reported for a target that is
    // simply out of date.
    const outcome = await sync({ target: target({ artifactDir: path.join(base, "gone") }) });

    expect(outcome).toMatchObject({ kind: "config_changed" });
    expect(server.stepCalls("report")).toHaveLength(0);
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

describe("#91 (片 5) — the never-sync root guard", () => {
  it("refuses a root inside a never-sync region with zero scan, upload or commit", async () => {
    const keys = path.join(base, "real", ".ssh", "keys");
    mkdirSync(keys, { recursive: true });
    // An innocuous entry name: it is the ROOT that makes this a refusal, not
    // the relative-entry policy (which never sees the root, #91).
    writeFileSync(path.join(keys, "notes.txt"), "ordinary-looking");
    start({ artifactDir: keys });

    const outcome = await sync({ target: target({ artifactDir: keys }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "outside_jail", reported: "recorded" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
    expect(server.stepCalls("put")).toHaveLength(0);
    expect(server.stepCalls("commit")).toHaveLength(0);
    expect(server.stepCalls("report")).toHaveLength(1);
    // The report carried the REAL base revisions (the baseline read precedes
    // every fallible local step, #95) and the loop's pointer never moved.
    expect(loop().syncError).toEqual({ failure: "outside_jail", configRevision: 1, baseManifestRevision: 0 });
    expect(loop().manifestRevision).toBe(0);
    expect(server.blobs.size).toBe(0);
  });

  it("refuses a root whose ancestor symlink lands in a never-sync region", async () => {
    mkdirSync(path.join(base, "real", ".ssh", "proj"), { recursive: true });
    mkdirSync(path.join(base, "work"));
    symlinkSync(path.join(base, "real", ".ssh"), path.join(base, "work", "link"));
    const root = path.join(base, "work", "link", "proj");
    start({ artifactDir: root });

    const outcome = await sync({ target: target({ artifactDir: root }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "outside_jail", reported: "recorded" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
  });

  it("refuses a root SYMLINK whose landing point is a never-sync region", async () => {
    mkdirSync(path.join(base, "real", ".config", "gcloud"), { recursive: true });
    symlinkSync(path.join(base, "real", ".config", "gcloud"), path.join(base, "gcloud-link"));
    const root = path.join(base, "gcloud-link");
    start({ artifactDir: root });

    const outcome = await sync({ target: target({ artifactDir: root }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "outside_jail", reported: "recorded" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
  });

  it("still syncs a DIRECTORY merely named like a credential file (file rules do not apply)", async () => {
    write("credentials/notes.txt", "ordinary content");
    const root = path.join(base, "credentials");
    start({ artifactDir: root });

    const outcome = await sync({ target: target({ artifactDir: root }) });

    expect(outcome).toMatchObject({ kind: "synced", uploaded: 1 });
  });
});

describe("片 5 — the slice-5 sync seams (决策 25)", () => {
  /** Counts every byte-carrying open (scans AND pre-upload verification). */
  function countingOpen(): { io: ArtifactScanIo; count: () => number } {
    let count = 0;
    return {
      io: {
        open: async (target, flags, mode) => {
          count += 1;
          return fs.open(target, flags as never, mode as never);
        },
      },
      count: () => count,
    };
  }

  it("reuses cached hashes ONLY when the caller opts in (the event path)", async () => {
    write("a.txt", "alpha");
    const counting = countingOpen();
    start({ io: counting.io });

    expect(await sync()).toMatchObject({ kind: "synced", uploaded: 1 });
    const afterFirst = counting.count();
    expect(afterFirst).toBeGreaterThan(0);

    // Default (startup / 60 s reconcile / run-final): full rehash, even though
    // the cache holds a five-field-identical entry.
    expect(await sync()).toEqual({ kind: "unchanged" });
    const afterDefault = counting.count();
    expect(afterDefault).toBeGreaterThan(afterFirst);

    // Event path: the cache hit means ZERO re-reads.
    expect(await sync({ reuseCachedHashes: true })).toEqual({ kind: "unchanged" });
    expect(counting.count()).toBe(afterDefault);
  });

  it("returns cancelled on an aborted signal — zero requests, zero reports, no partial manifest", async () => {
    write("a.txt", "alpha");
    start();
    const ctl = new AbortController();
    const aborting: ArtifactScanIo = {
      lstat: async (target) => {
        ctl.abort();
        return fs.lstat(target);
      },
    };
    client = makeClient({ io: aborting });

    const outcome = await sync({ signal: ctl.signal });

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(server.stepCalls("prepare")).toHaveLength(0);
    expect(server.stepCalls("put")).toHaveLength(0);
    expect(server.stepCalls("commit")).toHaveLength(0);
    // A cancellation is NOT a local failure: nothing may be reported.
    expect(server.stepCalls("report")).toHaveLength(0);
    expect(loop().manifestRevision).toBe(0);
  });

  it("reports a local failure once with the server's real revisions, then invalidates the record", async () => {
    write("a.txt", "alpha");
    start();
    expect(await sync()).toMatchObject({ kind: "synced" });

    const outcome = await client.reportLocalFailure({
      target: target(),
      failure: "watcher_error",
      detail: "chokidar exploded",
    });

    expect(outcome).toEqual({
      kind: "failed",
      failure: "watcher_error",
      detail: "chokidar exploded",
      reported: "recorded",
    });
    expect(server.stepCalls("report")).toHaveLength(1);
    // The report carried the manifest revision the baseline read returned.
    expect(loop().syncError).toEqual({ failure: "watcher_error", configRevision: 1, baseManifestRevision: 1 });
    // Decision 24: only unchanged/synced may keep the record — the report did
    // NOT, so the next call re-reads the baseline and re-commits instead of
    // suppressing (the accepted equivalent-content residual, ADR-010 决策 24).
    const reads = server.stepCalls("read").length;
    expect(await sync()).toMatchObject({ kind: "synced", manifestRevision: 2 });
    expect(server.stepCalls("read").length).toBeGreaterThan(reads);
  });

  it("returns `stale` when the pointer moved before the report landed", async () => {
    start();
    server.beforeReport = () => {
      loop().manifestRevision += 1;
    };

    const outcome = await client.reportLocalFailure({
      target: target(),
      failure: "watcher_error",
      detail: "late",
    });

    expect(outcome).toMatchObject({ kind: "failed", reported: "stale" });
  });

  it("returns `unreported` when the report's own transport fails — the failure stays the outcome", async () => {
    start();
    // Only the REPORT fails: the baseline read that precedes it still lands.
    server.failNext("report", { kind: "network_error" });

    const outcome = await client.reportLocalFailure({
      target: target(),
      failure: "timeout",
      detail: "deadline",
    });

    expect(outcome).toMatchObject({ kind: "failed", failure: "timeout", reported: "unreported" });
    // One-shot: the failed report is NEVER retried.
    expect(server.stepCalls("report")).toHaveLength(1);
  });

  it("a 401 on the report records the machine stop and keeps the failure as the outcome", async () => {
    start();
    server.failNext("report", { kind: "status", status: 401 });

    const outcome = await client.reportLocalFailure({
      target: target(),
      failure: "watcher_error",
      detail: "unauthorized",
    });

    expect(outcome).toMatchObject({ kind: "failed", reported: "unreported" });
    const calls = server.calls.length;
    expect(await sync()).toMatchObject({ kind: "stopped", scope: "machine" });
    expect(server.calls.length).toBe(calls); // sticky: zero further requests
  });

  it("says config_changed (no report) when the target disagrees with the server's dir", async () => {
    start();

    const outcome = await client.reportLocalFailure({
      target: target({ artifactDir: path.join(base, "gone") }),
      failure: "watcher_error",
      detail: "stale target",
    });

    expect(outcome).toMatchObject({ kind: "config_changed" });
    expect(server.stepCalls("report")).toHaveLength(0);
  });

  it("serializes behind an in-flight round for the same loop", async () => {
    write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const round = sync();
    await until(() => server.stepCalls("put").length === 1);

    const reporting = client.reportLocalFailure({
      target: target(),
      failure: "watcher_error",
      detail: "during the round",
    });
    await Promise.resolve();
    expect(server.stepCalls("report")).toHaveLength(0); // queued, not interleaved

    release();
    expect(await round).toMatchObject({ kind: "synced" });
    expect(await reporting).toMatchObject({ kind: "failed", failure: "watcher_error" });
    expect(server.stepCalls("report")).toHaveLength(1);
  });

  it("counts a pending report in settled() so a drain cannot miss it", async () => {
    start();
    let releaseReport!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    let reportStarted = 0;
    client = makeClient({
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/artifact-sync-error")) {
          reportStarted += 1;
          await gate;
        }
        return server.fetchImpl(input, init);
      },
    });

    const pending = client.reportLocalFailure({ target: target(), failure: "watcher_error", detail: "held" });
    await until(() => reportStarted === 1);
    let settled = false;
    void client.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseReport();
    expect(await pending).toMatchObject({ kind: "failed", reported: "recorded" });
    await client.settled();
    expect(settled).toBe(true);
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

  it("stops the machine when the REPORT itself is refused, and keeps making zero requests", async () => {
    const gone = path.join(base, "gone");
    start({ artifactDir: gone });
    server.failNext("report", { kind: "status", status: 403, code: "artifact_attribution_missing" });

    const outcome = await sync({ target: target({ artifactDir: gone }) });

    // Reporting is best-effort, so the outcome is still the local failure...
    expect(outcome).toMatchObject({ kind: "failed", failure: "directory_missing", reported: "unreported" });
    // ...but the machine must not keep negotiating with a credential the
    // server refuses: no loop, and no second report ([#94]).
    const before = server.calls.length;
    expect(await sync({ target: target({ artifactDir: gone }) })).toMatchObject({
      kind: "stopped",
      scope: "machine",
      status: 403,
    });
    const other = await client.syncLoop({ target: target({ loopId: "loop-2" }), daemonRoots: [base] });
    expect(other).toMatchObject({ kind: "stopped", scope: "machine", status: 403 });
    expect(server.calls.length).toBe(before);
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

  it("cancels gate waiters while another loop holds all permits, then admits successors", async () => {
    const loopIds = ["holder", "cancel-1", "cancel-2", "successor"];
    for (let index = 0; index < 4; index += 1) write(`holder/${index}.txt`, `held ${index}`);
    for (const loopId of loopIds.slice(1)) write(`${loopId}/file.txt`, loopId);
    server = createFakeArtifactServer({
      machineCredential: CREDENTIAL,
      loops: loopIds.map((loopId) => ({ loopId, artifactDir: path.join(base, loopId) })),
    });
    client = makeClient();
    const run = (loopId: string, signal?: AbortSignal) => client.syncLoop({
      target: target({ loopId, artifactDir: path.join(base, loopId) }),
      daemonRoots: [base],
      signal,
    });
    const release = server.holdPuts();
    const holder = run("holder");
    const rounds: Promise<ArtifactSyncOutcome>[] = [holder];
    try {
      await until(() => server.stepCalls("put").length === 4);
      const controllers = [new AbortController(), new AbortController()];
      let cancelled = 0;
      const waiters = controllers.map((controller, index) => {
        const round = run(`cancel-${index + 1}`, controller.signal).then((outcome) => {
          cancelled += 1;
          return outcome;
        });
        rounds.push(round);
        return round;
      });
      await until(() => server.stepCalls("prepare").length === 3);
      // Let both prepared rounds reach the full gate before aborting them.
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const controller of controllers) controller.abort();
      await until(() => cancelled === 2, 200);
      expect(await Promise.all(waiters)).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }]);
      expect(server.stepCalls("put")).toHaveLength(4);
      expect(server.stepCalls("commit")).toHaveLength(0);
      let drained = false;
      const drain = client.settled().then(() => { drained = true; });
      const successor = run("successor");
      rounds.push(successor);
      await until(() => server.stepCalls("prepare").length === 4);
      expect(drained).toBe(false);
      expect(server.stepCalls("put")).toHaveLength(4);
      release();
      expect((await holder).kind).toBe("synced");
      expect((await successor).kind).toBe("synced");
      await drain;
      expect(drained).toBe(true);
      expect(server.stepCalls("put")).toHaveLength(5);
      expect(server.maxConcurrentPuts).toBe(4);
      // Reusing a previously cancelled loop also proves no permit was lost.
      expect((await run("cancel-1")).kind).toBe("synced");
    } finally {
      release();
      await Promise.allSettled(rounds);
    }
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

  it("hands a released permit to the waiter instead of racing a newcomer", async () => {
    // The gate's own invariant, pinned at the microtask level: after a release
    // the permit is TRANSFERRED, so a newcomer that lands in the release→wake
    // window must queue behind the woken waiter, never run beside it ([#99]).
    const gate = createGate(1);
    let inFlight = 0;
    let peak = 0;
    let open!: () => void;
    const latch = new Promise<void>((resolve) => {
      open = resolve;
    });
    const task = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await latch;
      inFlight -= 1;
    };

    const first = gate.run(task);
    const queued = gate.run(task);
    await Promise.resolve();
    open();
    // Two nested microtasks place the newcomer exactly between the release
    // (which decrements) and the woken waiter's resumption: the buggy
    // decrement-then-wake gate observes TWO uploads in flight here.
    queueMicrotask(() => queueMicrotask(() => void gate.run(task)));

    await Promise.all([first, queued]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(1);
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

  it("a report whose base moved on before it landed is `stale`, sent exactly once", async () => {
    const gone = path.join(base, "gone");
    start({ artifactDir: gone });
    // The loop's pointer moves between the client's baseline read and the
    // report: the double-match gate must refuse it, and it is never retried.
    server.beforeReport = () => {
      loop().manifestRevision = 5;
    };

    const outcome = await sync({ target: target({ artifactDir: gone }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "directory_missing", reported: "stale" });
    expect(server.stepCalls("report")).toHaveLength(1);
  });

  it("an unreachable report is `unreported`, and is never retried", async () => {
    const gone = path.join(base, "gone");
    start({ artifactDir: gone });
    server.failNext("report", { kind: "network_error" });

    const outcome = await sync({ target: target({ artifactDir: gone }) });

    expect(outcome).toMatchObject({ kind: "failed", failure: "directory_missing", reported: "unreported" });
    expect(server.stepCalls("report")).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("reads the server baseline BEFORE a local failure, so the report is not stale forever", async () => {
    const art = path.join(base, "art");
    mkdirSync(art);
    write("art/a.txt", "alpha");
    start({ artifactDir: art });
    expect((await sync({ target: target({ artifactDir: art }) })).kind).toBe("synced");
    expect(loop().manifestRevision).toBe(1);
    rmSync(art, { recursive: true, force: true });

    // A restarted daemon (no in-process record) whose directory is gone: the
    // base must come from the server. A guessed 0 would be refused by the
    // double-match gate for good, leaving the loop's error state unwritten.
    const restarted = makeClient();

    const outcome = await restarted.syncLoop({ target: target({ artifactDir: art }), daemonRoots: [base] });

    expect(outcome).toEqual({
      kind: "failed",
      failure: "directory_missing",
      detail: expect.any(String),
      reported: "recorded",
    });
    expect(loop().syncError).toEqual({ failure: "directory_missing", configRevision: 1, baseManifestRevision: 1 });
    expect(server.calls.slice(-2).map((call) => call.step)).toEqual(["read", "report"]);
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

  it("terminates with the original content mismatch after two rescans, without committing or continuing", async () => {
    const file = write("a.txt", "alpha");
    start();
    // The fourth refusal must never be requested: initial PUT + two rescans.
    for (let index = 0; index < 4; index += 1) {
      server.failNextPut(file.hash, { kind: "status", status: 400, code: "artifact_content_mismatch" });
    }

    expect(await sync()).toMatchObject({ kind: "terminal", code: "artifact_content_mismatch" });
    await client.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.stepCalls("prepare")).toHaveLength(3);
    expect(server.stepCalls("put")).toHaveLength(3);
    expect(server.stepCalls("commit")).toHaveLength(0);
    expect(server.stepCalls("report")).toHaveLength(0);
    expect(loop().manifestRevision).toBe(0);
    expect(new Set(server.stepCalls("prepare").map((call) => call.requestId)).size).toBe(1);
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

  it("ends a queued call as soon as it is aborted, without waiting for the running PUT", async () => {
    write("a.txt", "alpha");
    start();
    const release = server.holdPuts();
    const first = sync();
    await until(() => server.stepCalls("put").length === 1);

    const controller = new AbortController();
    const queued = sync({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    let outcome: ArtifactSyncOutcome | null = null;
    void queued.then((value) => {
      outcome = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The predecessor's PUT is STILL held: the abort must end the queued call
    // now, not once the running round finally finishes ([#93]).
    expect(outcome).toEqual({ kind: "cancelled" });

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

  it("keeps the drain pending while a sibling upload is in flight after an internal fault", async () => {
    write("a.txt", "alpha");
    write("b.txt", "beta");
    const fault = faultingCacheOn("a.txt");
    start({ cache: fault.cache });
    const release = server.holdPuts();
    server.beforePrepare = () => fault.arm();
    let roundDone = false;
    const inflight = sync().then(
      () => {
        roundDone = true;
        return "resolved";
      },
      () => {
        roundDone = true;
        return "rejected";
      },
    );
    await until(() => server.stepCalls("put").length === 1);

    // One group faulted; the other is still uploading. The round must not have
    // reported yet (its sibling was detached), and the drain must not report a
    // settled client while those bytes are on the wire ([#92]).
    let settled = false;
    const waiter = client.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(roundDone).toBe(false);
    expect(settled).toBe(false);

    release();
    await waiter;

    // The sibling ran to completion (its blob landed), and the fault still
    // surfaces to the caller instead of being swallowed as an outcome.
    expect(server.stepCalls("put")[0]!.published).toBe(true);
    expect(await inflight).toBe("rejected");
  });

  it.each([
    { status: 401, code: undefined },
    { status: 403, code: "artifact_attribution_missing" as const },
    { status: 400, code: undefined },
  ].flatMap((refusal) => [
    { ...refusal, error: new Error("original upload exception"), errorKind: "Error" },
    { ...refusal, error: new TypeError("original upload exception"), errorKind: "TypeError" },
    { ...refusal, error: { unknown: "original upload exception" }, errorKind: "unknown" },
  ]))("preserves the original $errorKind alongside HTTP $status and drains its sibling", async ({ status, code, error }) => {
    write("a.txt", "alpha");
    const beta = write("b.txt", "beta");
    write("c.txt", "charlie");
    const fault = faultingCacheOn("a.txt", error);
    start({ cache: fault.cache });
    const release = server.holdPuts();
    server.beforePrepare = () => fault.arm();
    server.failNextPut(beta.hash, { kind: "status", status, code });
    let roundDone = false;
    const inflight = sync().then(
      (value) => {
        roundDone = true;
        return { kind: "resolved" as const, value };
      },
      (reason: unknown) => {
        roundDone = true;
        return { kind: "rejected" as const, reason };
      },
    );
    let settled = false;
    const drain = client.settled().then(() => { settled = true; });
    try {
      await until(() => server.stepCalls("put").length === 2);
      expect(roundDone).toBe(false);
      expect(settled).toBe(false);
      release();
      const result = await inflight;
      expect(result).toEqual({ kind: "rejected", reason: error });
      if (result.kind === "rejected") expect(result.reason).toBe(error);
      await drain;
      if (status === 401 || status === 403) {
        const before = server.calls.length;
        expect(await sync()).toMatchObject({ kind: "stopped", scope: "machine", status });
        expect(await sync({ target: target({ loopId: "another-loop" }) })).toMatchObject({ kind: "stopped", scope: "machine", status });
        expect(server.calls.length).toBe(before);
      }
    } finally {
      release();
      await Promise.allSettled([inflight, drain]);
    }
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

  it("keeps ONE identity when a freshSession round has to renew an expired session", async () => {
    write("a.txt", "alpha");
    start();
    await sync();
    // A real upload, so the session is exercised — freshSession skips
    // suppression, not the server's needHashes.
    write("b.txt", "beta");
    // The fresh call's session expires under it: the recovery must renew in
    // place under the SAME requestId, not mint a second session ([#97]).
    server.failNext("put", { kind: "status", status: 409, code: "artifact_session_expired" });

    const outcome = await sync({ freshSession: true });

    expect(outcome).toMatchObject({ kind: "synced", manifestRevision: 2 });
    const prepares = server.stepCalls("prepare");
    expect(prepares).toHaveLength(3);
    // The first call minted one identity; the fresh call minted one and reused
    // it across the renewal.
    expect(prepares.at(-1)!.requestId).toBe(prepares.at(-2)!.requestId);
    expect(prepares.at(-2)!.requestId).not.toBe(prepares.at(-3)!.requestId);
    expect(new Set(server.stepCalls("put").slice(-2).map((call) => call.syncId)).size).toBe(1);
    // One session per call: the renewal did not create a third.
    expect(server.sessions.size).toBe(2);
  });

  it("records a sticky stop even when another group's transient budget masks it", async () => {
    const alpha = write("a.txt", "alpha");
    const beta = write("b.txt", "beta");
    start({ maxAttempts: 2 });
    // The FIRST group exhausts its transient budget while the second is
    // refused with a machine-wide 401: the stop must not be masked.
    server.failNextPut(alpha.hash, { kind: "status", status: 500 });
    server.failNextPut(alpha.hash, { kind: "status", status: 500 });
    server.failNextPut(beta.hash, { kind: "status", status: 401 });

    const outcome = await sync();

    expect(outcome).toMatchObject({ kind: "stopped", scope: "machine", status: 401 });
    const before = server.calls.length;
    expect(await sync()).toMatchObject({ kind: "stopped", scope: "machine", status: 401 });
    expect(server.calls.length).toBe(before);
  });
});
