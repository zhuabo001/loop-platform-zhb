/**
 * TEST-ONLY in-memory fake of the artifact machine routes (ADR-010 决策 9/10/11/24).
 *
 * Excluded from the build via tsconfig.build.json; `tsc --noEmit` still
 * type-checks it. The daemon cannot import the real server (dependency
 * direction), so this models ONLY the branches the slice-4 client forks on,
 * and it validates every request with the REAL protocol schemas, the REAL
 * `normalizeManifestEntries` policy and the REAL `preparePayloadFingerprint` —
 * the fake never restates the wire contract in its own words. The semantic
 * cross-check against the real server is the server suite's job (AH5/AH6) and
 * slice 8's real-HTTP integration; this file is deliberately not a second
 * server implementation (no PGlite, no transactions, no OCC, no races).
 *
 * The load-bearing mode is `throw_after_apply`: it applies the mutation and
 * THEN breaks the response, which is the only way to produce a genuine
 * "the response was lost" at each of the three steps.
 */
import { createHash } from "node:crypto";

import {
  ARTIFACT_SYNC_ID_HEADER,
  normalizeManifestEntries,
  prepareArtifactSyncRequestSchema,
  artifactSyncErrorReportRequestSchema,
  type ArtifactErrorCode,
  type NormalizedManifestEntry,
} from "@loopzhb/protocol";
import { preparePayloadFingerprint } from "@loopzhb/protocol/node";

/** The opaque pending-session expiry the fake reports (never a clock). */
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
/** The frozen int32 ceiling the real commit precheck refuses at. */
const REVISION_INT32_MAX = 2_147_483_647;

export type FakeStep = "read" | "prepare" | "put" | "commit" | "report";

export interface FakeCall {
  step: FakeStep;
  method: string;
  path: string;
  authorization: string | undefined;
  /** The session this request addresses: the PUT header or the commit path. */
  syncId: string | undefined;
  requestId: string | undefined;
  hash: string | undefined;
  bodyBytes: number;
  /** sha256 of the request body — for a PUT this is the uploaded content's
   *  digest, so "the bytes on the wire are the verified bytes" is assertable. */
  bodyDigest: string;
  /** Parsed from a prepare body: the revision base the client negotiated on. */
  baseManifestRevision?: number;
  /** Set by the PUT handler: false = the key already existed (dedupe path). */
  published?: boolean;
}

export type FakeFailMode =
  /** Reject before touching state (a connection that never landed). */
  | { kind: "network_error" }
  /** Apply the mutation, then reject (the lost response). */
  | { kind: "throw_after_apply" }
  /** Apply the mutation, then return an unparseable 200. */
  | { kind: "malformed_2xx" }
  /** Refuse before touching state. */
  | { kind: "status"; status: number; code?: ArtifactErrorCode };

export interface FakeLoopState {
  artifactDir: string | null;
  configRevision: number;
  manifestRevision: number;
  manifest: NormalizedManifestEntry[];
  syncError: { failure: string; configRevision: number; baseManifestRevision: number } | null;
}

export interface FakeSessionState {
  syncId: string;
  loopId: string;
  requestId: string;
  fingerprint: string;
  configRevision: number;
  baseManifestRevision: number;
  entries: NormalizedManifestEntry[];
  /** Recomputed by every prepare for this session (决策 9). */
  needHashes: string[];
  receipt: { artifactSnapshotId: string; manifestRevision: number } | null;
  expired: boolean;
}

export interface FakeArtifactServer {
  readonly fetchImpl: typeof fetch;
  readonly calls: FakeCall[];
  readonly loops: Map<string, FakeLoopState>;
  readonly blobs: Map<string, { bytes: Buffer; size: number }>;
  readonly sessions: Map<string, FakeSessionState>;
  /** The observed maximum of simultaneously in-flight PUTs. */
  maxConcurrentPuts: number;
  /** Every request fails with a network error until cleared. */
  offline: boolean;
  /** Queue a one-shot failure for the NEXT request of that step. */
  failNext: (step: FakeStep, mode: FakeFailMode) => void;
  /** Queue a one-shot failure for the next PUT of THIS hash — the group-scoped
   *  seam, so a test never depends on which concurrent group reaches the
   *  server first. */
  failNextPut: (hash: string, mode: FakeFailMode) => void;
  expireSession: (syncId: string) => void;
  /** Server restart that loses every pending session (durable loop state stays). */
  dropSessions: () => void;
  /** Pre-seed a blob as if an earlier sync had published it. */
  seedBlob: (hash: string, bytes: Buffer) => void;
  /** Hold every subsequent PUT until the returned release runs. */
  holdPuts: () => () => void;
  /** Run once at the START of the next PUT, after its session lookup and
   *  before the committed/TTL checks — the seam for "a competing commit landed
   *  while our PUT was in flight". */
  beforePut?: (session: FakeSessionState) => void;
  /** Run once at the START of the next prepare — the seam for "the tree moved
   *  between the scan and the upload", which is what pre-upload verification
   *  exists to catch. */
  beforePrepare?: () => void;
  /** Run once at the START of the next report — the seam for "the loop's
   *  pointer moved between the client's baseline read and its report". */
  beforeReport?: () => void;
  /** Commit a session out-of-band, exactly like a successful client commit. */
  commitSession: (syncId: string) => void;
  putCount: (hash: string) => number;
  stepCalls: (step: FakeStep) => FakeCall[];
}

export interface FakeArtifactServerOptions {
  machineCredential: string;
  loops?: readonly {
    loopId: string;
    artifactDir: string | null;
    configRevision?: number;
    manifestRevision?: number;
    manifest?: readonly NormalizedManifestEntry[];
  }[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function refuse(status: number, error: string, code?: string): Response {
  return json(status, code === undefined ? { error } : { error, code });
}

function headerValue(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function bodyBuffer(init: RequestInit): Buffer {
  const body = init.body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.alloc(0);
}

export function createFakeArtifactServer(options: FakeArtifactServerOptions): FakeArtifactServer {
  const credential = options.machineCredential;
  const loops = new Map<string, FakeLoopState>();
  for (const loop of options.loops ?? []) {
    loops.set(loop.loopId, {
      artifactDir: loop.artifactDir,
      configRevision: loop.configRevision ?? 1,
      manifestRevision: loop.manifestRevision ?? 0,
      manifest: [...(loop.manifest ?? [])],
      syncError: null,
    });
  }

  const blobs = new Map<string, { bytes: Buffer; size: number }>();
  const sessions = new Map<string, FakeSessionState>();
  const calls: FakeCall[] = [];
  const failures = new Map<FakeStep, FakeFailMode[]>();
  const putFailures = new Map<string, FakeFailMode[]>();
  let idSeq = 0;
  const nextId = (prefix: string): string => `${prefix}-${++idSeq}`;
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  let inFlightPuts = 0;

  const server: FakeArtifactServer = {
    fetchImpl: (input, init) => handle(String(input), init ?? {}),
    calls,
    loops,
    blobs,
    sessions,
    maxConcurrentPuts: 0,
    offline: false,
    failNext(step, mode) {
      const queue = failures.get(step) ?? [];
      queue.push(mode);
      failures.set(step, queue);
    },
    failNextPut(hash, mode) {
      const queue = putFailures.get(hash) ?? [];
      queue.push(mode);
      putFailures.set(hash, queue);
    },
    expireSession(syncId) {
      const session = sessions.get(syncId);
      if (session) session.expired = true;
    },
    dropSessions() {
      sessions.clear();
    },
    seedBlob(hash, bytes) {
      blobs.set(hash, { bytes, size: bytes.length });
    },
    holdPuts() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { promise, release };
      return () => {
        hold = null;
        release();
      };
    },
    commitSession(syncId) {
      const session = sessions.get(syncId);
      if (session === undefined) throw new Error(`no such session: ${syncId}`);
      commitSession(session);
    },
    putCount(hash) {
      return calls.filter((call) => call.step === "put" && call.hash === hash).length;
    },
    stepCalls(step) {
      return calls.filter((call) => call.step === step);
    },
  };

  function sessionForRequest(requestId: string): FakeSessionState | undefined {
    for (const session of sessions.values()) if (session.requestId === requestId) return session;
    return undefined;
  }

  /** Every distinct hash whose blob is absent or whose VERIFIED size differs. */
  function computeNeedHashes(entries: readonly NormalizedManifestEntry[]): string[] {
    const need: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.hash)) continue;
      seen.add(entry.hash);
      const blob = blobs.get(entry.hash);
      if (!blob || blob.size !== entry.size) need.push(entry.hash);
    }
    return need;
  }

  function completeManifest(entries: readonly NormalizedManifestEntry[]): boolean {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.hash)) continue;
      seen.add(entry.hash);
      const blob = blobs.get(entry.hash);
      if (!blob || blob.size !== entry.size) return false;
    }
    return true;
  }

  async function handlePrepare(init: RequestInit): Promise<Response> {
    const parsedJson = JSON.parse(bodyBuffer(init).toString("utf8")) as unknown;
    const parsed = prepareArtifactSyncRequestSchema.safeParse(parsedJson);
    if (!parsed.success) return refuse(400, "manifest invalid", "artifact_validation_failed");
    const request = parsed.data;
    const normalized = normalizeManifestEntries(request.entries);
    if (!normalized.ok) return refuse(400, "manifest invalid", "artifact_validation_failed");
    const loop = loops.get(request.loopId);
    if (!loop) return refuse(404, "not found");
    const fingerprint = preparePayloadFingerprint({
      loopId: request.loopId,
      configRevision: request.configRevision,
      baseManifestRevision: request.baseManifestRevision,
      entries: normalized.entries,
    });
    const existing = sessionForRequest(request.requestId);
    // 决策 9: the committed replay precedes the config/base checks.
    if (existing && existing.fingerprint === fingerprint && existing.receipt !== null) {
      existing.needHashes = [];
      return json(200, { syncId: existing.syncId, needHashes: [], expiresAt: EXPIRES_AT });
    }
    if (loop.artifactDir === null) return refuse(409, "artifact dir unconfigured", "artifact_config_conflict");
    if (request.configRevision !== loop.configRevision) return refuse(409, "config conflict", "artifact_config_conflict");
    if (request.baseManifestRevision !== loop.manifestRevision) {
      return refuse(409, "manifest conflict", "artifact_manifest_conflict");
    }
    if (existing && existing.fingerprint !== fingerprint) {
      return refuse(409, "manifest conflict", "artifact_manifest_conflict");
    }
    let session = existing;
    if (session) {
      // Same key + same payload: renew in place, same syncId (决策 9).
      session.expired = false;
    } else {
      session = {
        syncId: nextId("sync"),
        loopId: request.loopId,
        requestId: request.requestId,
        fingerprint,
        configRevision: request.configRevision,
        baseManifestRevision: request.baseManifestRevision,
        entries: normalized.entries,
        needHashes: [],
        receipt: null,
        expired: false,
      };
      sessions.set(session.syncId, session);
    }
    session.needHashes = computeNeedHashes(session.entries);
    return json(200, { syncId: session.syncId, needHashes: session.needHashes, expiresAt: EXPIRES_AT });
  }

  /** The commit core (one receipt per session, pointer +1, immutable manifest). */
  function commitSession(session: FakeSessionState): { artifactSnapshotId: string; manifestRevision: number } {
    const loop = loops.get(session.loopId);
    if (loop === undefined) throw new Error(`no loop for session ${session.syncId}`);
    const receipt = { artifactSnapshotId: nextId("snap"), manifestRevision: loop.manifestRevision + 1 };
    session.receipt = receipt;
    loop.manifest = [...session.entries];
    loop.manifestRevision = receipt.manifestRevision;
    loop.syncError = null;
    return receipt;
  }

  async function handlePut(call: FakeCall, hash: string, init: RequestInit): Promise<Response> {
    const syncId = headerValue(init, ARTIFACT_SYNC_ID_HEADER);
    if (syncId === undefined || syncId.trim() === "") return refuse(400, "missing sync session header");
    const session = sessions.get(syncId);
    if (!session) return refuse(404, "not found");
    const loop = loops.get(session.loopId);
    if (!loop) return refuse(404, "not found");
    if (server.beforePut !== undefined) {
      const hook = server.beforePut;
      server.beforePut = undefined;
      hook(session);
    }
    if (session.receipt !== null) return refuse(409, "session committed", "artifact_session_committed");
    if (session.expired) return refuse(409, "session expired", "artifact_session_expired");
    if (session.configRevision !== loop.configRevision) return refuse(409, "config conflict", "artifact_config_conflict");
    if (!session.needHashes.includes(hash)) {
      return refuse(409, "hash not negotiated", "artifact_hash_not_negotiated");
    }
    if (hold !== null) {
      inFlightPuts += 1;
      server.maxConcurrentPuts = Math.max(server.maxConcurrentPuts, inFlightPuts);
      const gate = hold.promise;
      await gate;
      inFlightPuts -= 1;
    }
    const bytes = bodyBuffer(init);
    const entry = session.entries.find((candidate) => candidate.hash === hash);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (entry === undefined || digest !== hash || bytes.length !== entry.size) {
      return refuse(400, "content mismatch", "artifact_content_mismatch");
    }
    const existed = blobs.has(hash);
    blobs.set(hash, { bytes, size: bytes.length });
    call.published = !existed;
    return json(200, { ok: true, size: bytes.length, published: !existed });
  }

  /** The per-hash PUT wrapper: the group-scoped failure is injected the same
   *  way the step-level one is — before the handler, or after it applied. */
  async function handlePutWithFailure(call: FakeCall, hash: string, init: RequestInit): Promise<Response> {
    const injected = (putFailures.get(hash) ?? []).shift();
    if (injected?.kind === "network_error") throw new TypeError("fetch failed");
    if (injected?.kind === "status") return refuse(injected.status, "injected", injected.code);
    const response = await handlePut(call, hash, init);
    if (injected?.kind === "throw_after_apply") throw new TypeError("fetch failed");
    if (injected?.kind === "malformed_2xx") return new Response("{not json", { status: 200 });
    return response;
  }

  async function handleCommit(syncId: string): Promise<Response> {
    const session = sessions.get(syncId);
    if (!session) return refuse(404, "not found");
    const loop = loops.get(session.loopId);
    if (!loop) return refuse(404, "not found");
    if (session.receipt !== null) return json(200, session.receipt);
    if (session.expired) return refuse(409, "session expired", "artifact_session_expired");
    if (session.configRevision !== loop.configRevision) return refuse(409, "config conflict", "artifact_config_conflict");
    if (session.baseManifestRevision !== loop.manifestRevision) {
      return refuse(409, "manifest conflict", "artifact_manifest_conflict");
    }
    if (loop.manifestRevision >= REVISION_INT32_MAX) {
      return refuse(409, "revision exhausted", "artifact_revision_exhausted");
    }
    if (!completeManifest(session.entries)) return refuse(409, "blob missing", "artifact_blob_missing");
    return json(200, commitSession(session));
  }

  function handleRead(loopId: string): Response {
    const loop = loops.get(loopId);
    if (!loop) return refuse(404, "not found");
    if (loop.artifactDir === null) return refuse(409, "artifact dir unconfigured", "artifact_config_conflict");
    return json(200, {
      loopId,
      artifactDir: loop.artifactDir,
      configRevision: loop.configRevision,
      manifestRevision: loop.manifestRevision,
    });
  }

  async function handleReport(loopId: string, init: RequestInit): Promise<Response> {
    const parsedJson = JSON.parse(bodyBuffer(init).toString("utf8")) as unknown;
    const parsed = artifactSyncErrorReportRequestSchema.safeParse(parsedJson);
    if (!parsed.success) return refuse(400, "invalid request");
    const loop = loops.get(loopId);
    if (!loop) return refuse(404, "not found");
    if (loop.artifactDir === null) return json(200, { ok: true, recorded: false });
    if (
      parsed.data.configRevision !== loop.configRevision ||
      parsed.data.baseManifestRevision !== loop.manifestRevision
    ) {
      return json(200, { ok: true, recorded: false });
    }
    loop.syncError = {
      failure: parsed.data.failure,
      configRevision: parsed.data.configRevision,
      baseManifestRevision: parsed.data.baseManifestRevision,
    };
    return json(200, { ok: true, recorded: true });
  }

  function takeFailure(step: FakeStep): FakeFailMode | undefined {
    return failures.get(step)?.shift();
  }

  async function handle(rawUrl: string, init: RequestInit): Promise<Response> {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init.method ?? "GET";
    const step: FakeStep = path.endsWith("/artifact-sync-error")
      ? "report"
      : path === "/api/machine/sync"
        ? "prepare"
        : path.startsWith("/api/machine/blob/")
          ? "put"
          : path.endsWith("/commit")
            ? "commit"
            : "read";
    const body = bodyBuffer(init);
    const call: FakeCall = {
      step,
      method,
      path,
      authorization: headerValue(init, "authorization"),
      syncId:
        headerValue(init, ARTIFACT_SYNC_ID_HEADER) ??
        (step === "commit" ? path.slice("/api/machine/sync/".length, -"/commit".length) : undefined),
      requestId: undefined,
      hash: step === "put" ? decodeURIComponent(path.slice("/api/machine/blob/".length)) : undefined,
      bodyBytes: body.length,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
    };
    calls.push(call);
    if (step === "prepare" || step === "report") {
      try {
        const parsedBody = JSON.parse(body.toString("utf8")) as { requestId?: string; baseManifestRevision?: number };
        call.requestId = parsedBody.requestId;
        call.baseManifestRevision = parsedBody.baseManifestRevision;
      } catch {
        call.requestId = undefined;
      }
    }
    if (server.offline) throw new TypeError("fetch failed");
    const failure = takeFailure(step);
    if (failure?.kind === "network_error") throw new TypeError("fetch failed");
    if (failure?.kind === "status") return refuse(failure.status, "injected", failure.code);
    if (call.authorization !== `Bearer ${credential}`) return refuse(401, "invalid machine credential");

    let response: Response;
    if (step === "prepare") {
      if (server.beforePrepare !== undefined) {
        const hook = server.beforePrepare;
        server.beforePrepare = undefined;
        hook();
      }
      response = await handlePrepare(init);
    } else if (step === "put") {
      response = await handlePutWithFailure(call, call.hash!, init);
    } else if (step === "commit") {
      response = await handleCommit(path.slice("/api/machine/sync/".length, -"/commit".length));
    } else if (step === "report") {
      if (server.beforeReport !== undefined) {
        const hook = server.beforeReport;
        server.beforeReport = undefined;
        hook();
      }
      response = await handleReport(path.split("/")[4]!, init);
    } else {
      response = handleRead(path.split("/")[4]!);
    }
    if (failure?.kind === "throw_after_apply") throw new TypeError("fetch failed");
    if (failure?.kind === "malformed_2xx") return new Response("{not json", { status: 200 });
    return response;
  }

  return server;
}
