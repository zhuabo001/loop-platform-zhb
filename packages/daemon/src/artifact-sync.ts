/**
 * The artifact sync state machine (Batch 2 slice 4, ADR-010 决策 24).
 *
 * One call turns a local tree into the server's manifest, or returns ONE
 * closed result. The contract points that are easy to get wrong:
 *
 *  - the payload decides the requestId. The session key is
 *    `(namespaceId, machineId, requestId)` and the same key with a DIFFERENT
 *    payload is a hard 409 (决策 6/9), so a pending requestId is reused only
 *    when the fresh `preparePayloadFingerprint` matches; otherwise a new one
 *    is minted.
 *  - a lost response is retryable at every step. All three calls are
 *    idempotent under a frozen requestId/syncId, so a malformed 2xx means
 *    "the response was lost", never fatal (unlike poll).
 *  - the bytes PUT are the bytes verification just read (决策 24). The
 *    scanner's consistency is point-in-time; uploading the verified buffer is
 *    what makes the committed manifest and the uploaded content one snapshot.
 *  - suppression is a CLIENT duty (the server mints a snapshot per committed
 *    session, 决策 11) and only `unchanged`/`synced` may keep the record.
 *    Everything else invalidates the entries: a commit whose response was lost
 *    may have landed, and a later content revert would otherwise suppress
 *    forever against a stale record.
 *  - 401 stops the whole machine; the only 403 the server emits
 *    (`artifact_attribution_missing`) is machine-attribution-wide, so it stops
 *    the machine too. Stops are sticky: later calls make ZERO requests and
 *    return `stopped` until `clearStops()`.
 *
 * No production wiring here: slice 5 owns the watcher and the 60 s reconcile,
 * slice 6 owns the Run-final deadline (which composes as a caller `signal`).
 */
import { randomBytes } from "node:crypto";

import {
  ARTIFACT_ERROR_RETRY_CLASS,
  ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES,
  type ArtifactErrorCode,
  type ArtifactSyncErrorReportRequest,
  type ArtifactWatchItem,
  type NormalizedManifestEntry,
  type PrepareArtifactSyncRequest,
} from "@loopzhb/protocol";
import { preparePayloadFingerprint } from "@loopzhb/protocol/node";

import type { ArtifactHttpOutcome, ArtifactTransport } from "./artifact-client.js";
import type { ArtifactHashCache } from "./artifact-hash-cache.js";
import { resolveArtifactRoot, type ArtifactScanFailure, type ResolvedArtifactRoot } from "./artifact-jail.js";
import { scanArtifactRoot, type ArtifactScanIo, type ArtifactScanLimits } from "./artifact-scan.js";
import { readVerifiedArtifactEntry, type ArtifactVerifyFailure } from "./artifact-verify.js";
import { isTransientStatus } from "./client.js";

/** Daemon-global in-flight blob uploads (决策 24). The gate is INSTANCE-scoped:
 *  one client per daemon (slice 5 constructs exactly one), so the instance is
 *  the daemon-global bound. */
export const ARTIFACT_UPLOAD_CONCURRENCY = 4;
/** Transient backoff: 1, 2, 4, 8 … capped here (plan §1). */
export const ARTIFACT_SYNC_BACKOFF_BASE_MS = 1_000;
export const ARTIFACT_SYNC_BACKOFF_CAP_MS = 60_000;
/** Total attempts for one operation before the call gives up as `unavailable`
 *  (6 attempts ⇒ delays 1, 2, 4, 8, 16 s). */
export const ARTIFACT_SYNC_MAX_ATTEMPTS = 6;
/** Whole-tree re-scans per call (content drifted under a verified read, or the
 *  server refused the uploaded bytes). */
export const ARTIFACT_SYNC_MAX_RESCANS = 2;
/** Server-side restarts (re-read the baseline, re-negotiate) per call. */
export const ARTIFACT_SYNC_MAX_RENEGOTIATIONS = 3;

/** Resolve on schedule OR on abort (never rejects) — the runtime's SleepFn
 *  shape, kept local so this module never imports the runtime (slice 5 wires
 *  this client into the runtime; a shared import would close a cycle). */
export type ArtifactSyncSleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export const defaultArtifactSyncSleep: ArtifactSyncSleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export type ArtifactStopScope = "machine" | "loop";

/** How a local scan/verify failure was adjudicated by the server (决策 24):
 *  `recorded` = the loop's attempt state was written; `stale` = the
 *  generation/base moved on (`recorded:false`, never retried); `unreported` =
 *  the one-shot report did not reach the server. */
export type ArtifactReportState = "recorded" | "stale" | "unreported";

export type ArtifactSyncOutcome =
  | { kind: "unchanged" }
  | { kind: "synced"; manifestRevision: number; artifactSnapshotId: string; uploaded: number }
  | { kind: "failed"; failure: ArtifactScanFailure; detail: string; reported: ArtifactReportState }
  | { kind: "config_changed"; detail: string }
  | { kind: "stopped"; scope: ArtifactStopScope; status: number; detail: string }
  | { kind: "terminal"; code?: ArtifactErrorCode; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "cancelled" };

export type ArtifactBaselineOutcome =
  | { kind: "ok"; configRevision: number; manifestRevision: number; artifactDir: string }
  | { kind: "config_changed"; detail: string }
  | { kind: "stopped"; scope: ArtifactStopScope; status: number; detail: string }
  | { kind: "terminal"; code?: ArtifactErrorCode; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "cancelled" };

export interface ArtifactSyncInput {
  /** The watch item is exactly the sync target (决策 22): the config this sync
   *  is bound to, as delivered to the daemon. */
  target: ArtifactWatchItem;
  /** The daemon's already-canonical allowed roots (the jail intersection). */
  daemonRoots: readonly string[];
  signal?: AbortSignal;
  /** Slice 6: every Run-final sync uses a NEW session even when the content is
   *  unchanged (决策 11), so it bypasses suppression and mints a requestId. */
  freshSession?: boolean;
}

export interface ArtifactSyncClientDeps {
  transport: ArtifactTransport;
  /** Caller-owned hash cache (no singleton, 决策 23). */
  cache: ArtifactHashCache;
  /** TEST-ONLY seams, mirroring the runtime's injectable time. */
  sleep?: ArtifactSyncSleepFn;
  io?: ArtifactScanIo;
  limits?: Partial<ArtifactScanLimits>;
  /** TEST-ONLY overrides; the production values are the exported constants. */
  uploadConcurrency?: number;
  maxAttempts?: number;
  maxRescans?: number;
  maxRenegotiations?: number;
}

export interface ArtifactSyncClient {
  syncLoop(input: ArtifactSyncInput): Promise<ArtifactSyncOutcome>;
  readBaseline(loopId: string, signal?: AbortSignal): Promise<ArtifactBaselineOutcome>;
  /** Clear the sticky 401/403 stops (config generation swap, credential
   *  rotation, or an operator decision to try again). */
  clearStops(): void;
  /** Resolves when no queued or in-flight sync work remains. */
  settled(): Promise<void>;
}

interface Baseline {
  configRevision: number;
  manifestRevision: number;
  /** The last committed manifest — `null` means UNKNOWN (restart, a replayed
   *  receipt, or any outcome other than unchanged/synced). Never `[]`, which
   *  would fake an empty tree. */
  entries: NormalizedManifestEntry[] | null;
}

interface Pending {
  epoch: number;
  requestId: string;
  fingerprint: string;
  syncId: string | null;
}

interface LoopState {
  baseline: Baseline | undefined;
  pending: Pending | undefined;
  epoch: number;
}

interface Stop {
  scope: ArtifactStopScope;
  status: number;
  detail: string;
}

interface Gate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

type SendResult<T> =
  | { kind: "value"; value: ArtifactHttpOutcome<T> }
  | { kind: "exhausted"; detail: string }
  | { kind: "aborted" };

/** The refused arm of any transport outcome (code absent when the server sent
 *  none the client recognizes). */
type ArtifactRefusal = Extract<ArtifactHttpOutcome<unknown>, { kind: "refused" }>;
type StoppedOutcome = Extract<ArtifactSyncOutcome, { kind: "stopped" }>;

/** What the retry class tells the client to DO (决策 13/24). `reprepare` keeps
 *  the payload (and therefore the requestId); a fresh base revision is what
 *  changes the payload, and that only happens after a re-read. */
type RefusalAction = "reprepare" | "rescan" | "recover" | "terminal";

function refusalAction(code: ArtifactErrorCode | undefined): RefusalAction {
  if (code === undefined) return "terminal";
  switch (ARTIFACT_ERROR_RETRY_CLASS[code]) {
    case "idempotent_retry":
    case "resume":
    case "renegotiate":
      return "reprepare";
    case "recover_receipt":
      return "recover";
    case "terminal":
      return code === "artifact_content_mismatch" ? "rescan" : "terminal";
    default:
      return "terminal";
  }
}

function createGate(limit: number): Gate {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

/** A signal may flip at ANY await; going through a call keeps the compiler's
 *  flow analysis from narrowing a later check away. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sameEntries(a: readonly NormalizedManifestEntry[], b: readonly NormalizedManifestEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.path !== right.path || left.hash !== right.hash || left.size !== right.size) return false;
  }
  return true;
}

export function createArtifactSyncClient(deps: ArtifactSyncClientDeps): ArtifactSyncClient {
  const sleep = deps.sleep ?? defaultArtifactSyncSleep;
  const maxAttempts = deps.maxAttempts ?? ARTIFACT_SYNC_MAX_ATTEMPTS;
  const maxRescans = deps.maxRescans ?? ARTIFACT_SYNC_MAX_RESCANS;
  const maxRenegotiations = deps.maxRenegotiations ?? ARTIFACT_SYNC_MAX_RENEGOTIATIONS;
  const gate = createGate(deps.uploadConcurrency ?? ARTIFACT_UPLOAD_CONCURRENCY);

  const states = new Map<string, LoopState>();
  const tails = new Map<string, Promise<unknown>>();
  const loopStops = new Map<string, Stop>();
  let machineStop: Stop | null = null;
  let active = 0;
  const settleWaiters = new Set<() => void>();
  const never = new AbortController().signal;

  function loopState(loopId: string): LoopState {
    const existing = states.get(loopId);
    if (existing !== undefined) return existing;
    const created: LoopState = { baseline: undefined, pending: undefined, epoch: 0 };
    states.set(loopId, created);
    return created;
  }

  function stopFor(loopId: string): Stop | null {
    return machineStop ?? loopStops.get(loopId) ?? null;
  }

  function stoppedOutcome(stop: Stop): StoppedOutcome {
    return { kind: "stopped", scope: stop.scope, status: stop.status, detail: stop.detail };
  }

  /** 401 stops the whole machine; a 403 acquires the scope its CODE implies
   *  (the only 403 the server emits is machine-attribution-wide). */
  function recordStop(loopId: string, refused: ArtifactRefusal): StoppedOutcome | null {
    if (refused.status === 401) {
      machineStop = { scope: "machine", status: 401, detail: refused.reason };
      return stoppedOutcome(machineStop);
    }
    if (refused.status !== 403) return null;
    if (refused.code === undefined || refused.code === "artifact_attribution_missing") {
      machineStop = { scope: "machine", status: 403, detail: refused.reason };
      return stoppedOutcome(machineStop);
    }
    const stop: Stop = { scope: "loop", status: 403, detail: refused.reason };
    loopStops.set(loopId, stop);
    return stoppedOutcome(stop);
  }

  /** Any outcome other than unchanged/synced leaves the record UNKNOWN: a
   *  commit whose response was lost may have landed. */
  function invalidate(state: LoopState): void {
    if (state.baseline !== undefined) state.baseline = { ...state.baseline, entries: null };
  }

  /** One operation with the bounded transient backoff (a per-operation budget;
   *  a non-transient refusal returns immediately and costs nothing). */
  async function send<T>(
    operation: (signal: AbortSignal | undefined) => Promise<ArtifactHttpOutcome<T>>,
    signal: AbortSignal | undefined,
  ): Promise<SendResult<T>> {
    for (let attempt = 1; ; attempt += 1) {
      const value = await operation(signal);
      if (isAborted(signal)) return { kind: "aborted" };
      const transient = value.kind === "unreachable" || (value.kind === "refused" && isTransientStatus(value.status));
      if (!transient) return { kind: "value", value };
      const detail = value.kind === "unreachable" ? value.reason : `HTTP ${value.status}`;
      if (attempt >= maxAttempts) return { kind: "exhausted", detail };
      const delay = Math.min(ARTIFACT_SYNC_BACKOFF_CAP_MS, ARTIFACT_SYNC_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      await sleep(delay, signal ?? never);
      if (isAborted(signal)) return { kind: "aborted" };
    }
  }

  /** The one-shot local failure report (决策 24): never retried, and never
   *  used for transport failures. */
  async function reportFailure(
    target: ArtifactWatchItem,
    state: LoopState,
    failure: ArtifactScanFailure,
    detail: string,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactSyncOutcome> {
    const report: ArtifactSyncErrorReportRequest = {
      failure,
      configRevision: target.configRevision,
      baseManifestRevision: state.baseline?.manifestRevision ?? 0,
      message: detail,
    };
    const sent = await deps.transport.reportSyncError(target.loopId, report, signal);
    if (sent.kind === "refused" && sent.status === 401) {
      machineStop = { scope: "machine", status: 401, detail: sent.reason };
    }
    const reported: ArtifactReportState =
      sent.kind === "ok" ? (sent.value.recorded ? "recorded" : "stale") : "unreported";
    return { kind: "failed", failure, detail, reported };
  }

  async function readBaseline(loopId: string, signal?: AbortSignal): Promise<ArtifactBaselineOutcome> {
    const stop = stopFor(loopId);
    if (stop !== null) return { kind: "stopped", scope: stop.scope, status: stop.status, detail: stop.detail };
    if (isAborted(signal)) return { kind: "cancelled" };
    const read = await send((inner) => deps.transport.readLoop(loopId, inner), signal);
    if (read.kind === "aborted") return { kind: "cancelled" };
    if (read.kind === "exhausted") return { kind: "unavailable", detail: read.detail };
    const outcome = read.value;
    if (outcome.kind === "unreachable") return { kind: "unavailable", detail: outcome.reason };
    if (outcome.kind === "refused") {
      const stopped = recordStop(loopId, outcome);
      if (stopped !== null) return { kind: "stopped", scope: stopped.scope, status: stopped.status, detail: stopped.detail };
      if (outcome.code === "artifact_config_conflict") return { kind: "config_changed", detail: outcome.reason };
      return { kind: "terminal", code: outcome.code, detail: outcome.reason };
    }
    const value = outcome.value;
    const state = loopState(loopId);
    state.baseline = { configRevision: value.configRevision, manifestRevision: value.manifestRevision, entries: null };
    return {
      kind: "ok",
      configRevision: value.configRevision,
      manifestRevision: value.manifestRevision,
      artifactDir: value.artifactDir,
    };
  }

  /** Verify every path behind the negotiated hashes and upload each hash once,
   *  with the verified bytes, through the daemon-global gate. */
  async function uploadNeeded(
    resolved: ResolvedArtifactRoot,
    entries: readonly NormalizedManifestEntry[],
    needHashes: readonly string[],
    syncId: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: "ok"; uploaded: number }
    | { kind: "verify_failed"; failure: ArtifactVerifyFailure; detail: string }
    | { kind: "refused"; refusal: ArtifactRefusal }
    | { kind: "unavailable"; detail: string }
    | { kind: "aborted" }
  > {
    const need = new Set(needHashes);
    const groups = new Map<string, NormalizedManifestEntry[]>();
    for (const entry of entries) {
      if (!need.has(entry.hash)) continue;
      const group = groups.get(entry.hash);
      if (group === undefined) groups.set(entry.hash, [entry]);
      else group.push(entry);
    }
    const results = await Promise.all(
      [...groups.values()].map((group) =>
        gate.run(async () => {
          if (isAborted(signal)) return { kind: "aborted" as const };
          let bytes: Buffer | null = null;
          for (const entry of group) {
            const verified = await readVerifiedArtifactEntry(
              resolved,
              { path: entry.path, hash: entry.hash, size: entry.size },
              { cache: deps.cache, io: deps.io },
            );
            if (verified.kind === "failed") {
              return { kind: "verify_failed" as const, failure: verified.failure, detail: verified.detail };
            }
            bytes ??= verified.bytes;
          }
          const put = await send(
            (inner) => deps.transport.putBlob(group[0]!.hash, syncId, bytes!, inner),
            signal,
          );
          return { kind: "put" as const, put };
        }),
      ),
    );
    for (const result of results) {
      if (result.kind === "aborted") return { kind: "aborted" };
      if (result.kind === "verify_failed") {
        return { kind: "verify_failed", failure: result.failure, detail: result.detail };
      }
      const put = result.put;
      if (put.kind === "aborted") return { kind: "aborted" };
      if (put.kind === "exhausted") return { kind: "unavailable", detail: put.detail };
      if (put.value.kind === "unreachable") return { kind: "unavailable", detail: put.value.reason };
      if (put.value.kind === "refused") return { kind: "refused", refusal: put.value };
    }
    return { kind: "ok", uploaded: groups.size };
  }

  async function runSync(input: ArtifactSyncInput): Promise<ArtifactSyncOutcome> {
    const { target, daemonRoots, signal, freshSession } = input;
    const { loopId, artifactDir, workdir, roots, configRevision } = target;
    const state = loopState(loopId);
    let rescans = 0;
    let renegotiations = 0;

    for (;;) {
      if (isAborted(signal)) return { kind: "cancelled" };

      // (1) Root resolution and the full scan run EVERY round: a roots change
      // takes effect on the next call, never from a cached root.
      const resolution = await resolveArtifactRoot({ artifactDir, workdir, serverRoots: roots, daemonRoots });
      if (resolution.kind === "failed") {
        return reportFailure(target, state, resolution.failure, resolution.detail, signal);
      }
      const resolved = resolution.resolved;
      const scan = await scanArtifactRoot(resolved, {
        cache: deps.cache,
        reuseCachedHashes: false,
        limits: deps.limits,
        io: deps.io,
      });
      if (scan.kind === "failed") return reportFailure(target, state, scan.failure, scan.detail, signal);
      const entries = scan.entries;

      // (2) Suppression: our own last committed manifest, same generation,
      // unchanged content ⇒ nothing to say to the server at all.
      const current = state.baseline;
      if (
        freshSession !== true &&
        current !== undefined &&
        current.entries !== null &&
        current.configRevision === configRevision &&
        sameEntries(current.entries, entries)
      ) {
        return { kind: "unchanged" };
      }

      // (3) The negotiation base must be a revision the SERVER told us about.
      let base = current;
      if (base === undefined || base.entries === null) {
        const read = await readBaseline(loopId, signal);
        if (read.kind === "cancelled") return { kind: "cancelled" };
        if (read.kind === "stopped" || read.kind === "unavailable" || read.kind === "terminal") return read;
        if (read.kind === "config_changed") {
          state.baseline = undefined;
          state.pending = undefined;
          return read;
        }
        if (read.configRevision !== configRevision || read.artifactDir !== artifactDir) {
          state.baseline = undefined;
          state.pending = undefined;
          return {
            kind: "config_changed",
            detail: `server config (revision ${read.configRevision}, dir ${read.artifactDir}) no longer matches the sync target`,
          };
        }
        base = { configRevision: read.configRevision, manifestRevision: read.manifestRevision, entries: null };
        state.baseline = base;
      }

      // (4) Negotiate. The requestId belongs to the PAYLOAD (决策 6/9).
      const payload = {
        loopId,
        configRevision,
        baseManifestRevision: base.manifestRevision,
        entries,
      };
      const fingerprint = preparePayloadFingerprint(payload);
      let pending = state.pending;
      if (freshSession === true || pending === undefined || pending.fingerprint !== fingerprint) {
        pending = { epoch: (state.epoch += 1), requestId: randomBytes(12).toString("hex"), fingerprint, syncId: null };
        state.pending = pending;
      }
      const request: PrepareArtifactSyncRequest = { requestId: pending.requestId, ...payload };
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES) {
        return reportFailure(target, state, "too_large", "prepare payload exceeds the request ceiling", signal);
      }
      const prepared = await send((inner) => deps.transport.prepare(request, inner), signal);
      if (prepared.kind === "aborted") return { kind: "cancelled" };
      if (prepared.kind === "exhausted") return { kind: "unavailable", detail: prepared.detail };
      let needHashes: readonly string[] = [];
      if (prepared.value.kind === "unreachable") return { kind: "unavailable", detail: prepared.value.reason };
      if (prepared.value.kind === "refused") {
        const refusal = prepared.value;
        const stopped = recordStop(loopId, refusal);
        if (stopped !== null) return stopped;
        if (refusal.code === "artifact_config_conflict") {
          state.baseline = undefined;
          state.pending = undefined;
          return { kind: "config_changed", detail: refusal.reason };
        }
        if (refusal.status === 413) return { kind: "terminal", detail: "prepare request rejected (413)" };
        const action = refusalAction(refusal.code);
        if (action === "reprepare") {
          if (++renegotiations > maxRenegotiations) return { kind: "terminal", code: refusal.code, detail: refusal.reason };
          invalidate(state);
          continue;
        }
        return { kind: "terminal", code: refusal.code, detail: refusal.reason };
      }
      // The epoch guard: a response for a session that has since been replaced
      // must never be acted on (slice 5's config-swap cancellation is the
      // expected trigger). Per-loop serialization makes it unreachable today.
      if (state.pending?.epoch !== pending.epoch) continue;
      pending.syncId = prepared.value.value.syncId;
      needHashes = prepared.value.value.needHashes;
      const syncId = pending.syncId;

      // (5) Upload exactly the negotiated hashes, and ONLY those.
      const uploaded = await uploadNeeded(resolved, entries, needHashes, syncId, signal);
      if (uploaded.kind === "aborted") return { kind: "cancelled" };
      if (uploaded.kind === "unavailable") return { kind: "unavailable", detail: uploaded.detail };
      if (uploaded.kind === "verify_failed") {
        if (uploaded.failure === "changed" || uploaded.failure === "missing") {
          if (++rescans > maxRescans) return reportFailure(target, state, "unstable", uploaded.detail, signal);
          invalidate(state);
          continue;
        }
        return reportFailure(target, state, uploaded.failure, uploaded.detail, signal);
      }
      if (uploaded.kind === "refused") {
        const refusal = uploaded.refusal;
        const stopped = recordStop(loopId, refusal);
        if (stopped !== null) return stopped;
        if (refusal.code === "artifact_config_conflict") {
          state.baseline = undefined;
          state.pending = undefined;
          return { kind: "config_changed", detail: refusal.reason };
        }
        // A code-less 404 on PUT is `session_not_found` (the server restarted
        // or its session row expired away): re-prepare the SAME payload, which
        // recreates the session under the same requestId (决策 9/24).
        const action = refusal.status === 404 ? "reprepare" : refusalAction(refusal.code);
        // The session was committed by an earlier attempt: fetch its receipt.
        // This call uploaded nothing before the refusal.
        if (action === "recover") {
          const recovered = await commitOnce(target, state, syncId, entries, 0, signal);
          if (recovered !== null) return recovered;
          if (++renegotiations > maxRenegotiations) {
            return { kind: "terminal", detail: "the sync session vanished repeatedly" };
          }
          invalidate(state);
          continue;
        }
        if (action === "rescan") {
          if (++rescans > maxRescans) return { kind: "terminal", code: refusal.code, detail: refusal.reason };
          invalidate(state);
          continue;
        }
        if (action === "reprepare") {
          if (++renegotiations > maxRenegotiations) {
            return { kind: "terminal", code: refusal.code, detail: refusal.reason };
          }
          invalidate(state);
          continue;
        }
        return { kind: "terminal", code: refusal.code, detail: refusal.reason };
      }

      // (6) Commit with the SAME session and take the fixed receipt.
      const done = await commitOnce(target, state, syncId, entries, uploaded.uploaded, signal);
      if (done !== null) return done;
      if (++renegotiations > maxRenegotiations) {
        return { kind: "terminal", detail: "the sync session vanished repeatedly" };
      }
      invalidate(state);
    }
  }

  /** Commit and adjudicate the receipt (shared by the normal path and the
   *  `recover_receipt` action). A `null` return means the session vanished
   *  (code-less 404): the caller loop re-negotiates the SAME payload, which
   *  recreates it under the same requestId. */
  async function commitOnce(
    target: ArtifactWatchItem,
    state: LoopState,
    syncId: string,
    entries: NormalizedManifestEntry[],
    uploaded: number,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactSyncOutcome | null> {
    const committed = await send((inner) => deps.transport.commit(syncId, inner), signal);
    if (committed.kind === "aborted") return { kind: "cancelled" };
    if (committed.kind === "exhausted") return { kind: "unavailable", detail: committed.detail };
    if (committed.value.kind === "unreachable") return { kind: "unavailable", detail: committed.value.reason };
    if (committed.value.kind === "refused") {
      const refusal = committed.value;
      const stopped = recordStop(target.loopId, refusal);
      if (stopped !== null) return stopped;
      if (refusal.code === "artifact_config_conflict") {
        state.baseline = undefined;
        state.pending = undefined;
        return { kind: "config_changed", detail: refusal.reason };
      }
      // `resume` (blob_missing) and `renegotiate` (expired/conflict) both mean
      // "run the round again": the loop re-reads the baseline, and an unchanged
      // payload reuses the requestId while a moved base mints a new one.
      const action = refusalAction(refusal.code);
      if (refusal.status === 404 || action === "reprepare" || action === "rescan") return null;
      return { kind: "terminal", code: refusal.code, detail: refusal.reason };
    }
    const receipt = committed.value.value;
    const previous = state.baseline?.manifestRevision ?? 0;
    state.baseline = {
      configRevision: target.configRevision,
      manifestRevision: receipt.manifestRevision,
      // A replayed receipt may be older than the loop's pointer (决策 11):
      // anything but the exact next revision leaves the record unknown.
      entries: receipt.manifestRevision === previous + 1 ? entries : null,
    };
    state.pending = undefined;
    return {
      kind: "synced",
      manifestRevision: receipt.manifestRevision,
      artifactSnapshotId: receipt.artifactSnapshotId,
      uploaded,
    };
  }

  async function syncLoop(input: ArtifactSyncInput): Promise<ArtifactSyncOutcome> {
    const { loopId } = input.target;
    const stop = stopFor(loopId);
    if (stop !== null) return stoppedOutcome(stop);
    if (isAborted(input.signal)) return { kind: "cancelled" };
    active += 1;
    const previous = tails.get(loopId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const outcome = await runSync(input);
      // The record survives ONLY an unchanged/synced round (ADR-010 决策 24):
      // a commit whose response was lost may have landed, and a later content
      // revert would otherwise suppress forever against a stale record.
      if (outcome.kind !== "unchanged" && outcome.kind !== "synced") {
        invalidate(loopState(loopId));
      }
      return outcome;
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(loopId, tail);
    void tail.then(() => {
      if (tails.get(loopId) === tail) tails.delete(loopId);
    });
    try {
      return await run;
    } finally {
      active -= 1;
      if (active === 0) {
        const waiters = [...settleWaiters];
        settleWaiters.clear();
        for (const waiter of waiters) waiter();
      }
    }
  }

  return {
    syncLoop,
    readBaseline,
    clearStops() {
      machineStop = null;
      loopStops.clear();
    },
    settled() {
      if (active === 0) return Promise.resolve();
      return new Promise<void>((resolve) => settleWaiters.add(resolve));
    },
  };
}
