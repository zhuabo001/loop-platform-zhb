/**
 * The artifact-sync HTTP transport (ADR-010 决策 24): the five machine routes of the
 * prepare → PUT → commit handshake, the restart baseline read and the
 * local-failure report, as PURE PER-REQUEST CLASSIFICATION. There is no retry,
 * no backoff, no queue and no session state here — artifact-sync.ts owns the
 * state machine; this module only answers "what did the server say" as data.
 *
 * Classification contract (mirrors client.ts, with one deliberate inversion):
 *  - 2xx: parsed with the endpoint's REAL protocol schema. A malformed or
 *    non-JSON 2xx is `unreachable`, NOT fatal — the OPPOSITE of client.ts's
 *    poll, and deliberately so: every artifact operation is idempotent under a
 *    frozen requestId/syncId (ADR-010 决策 9), so a lost response is simply
 *    retried to convergence. A malformed POLL 2xx, by contrast, may already
 *    have claimed a Delivery that no retry can recover (ADR-001).
 *  - non-2xx: `refused`, carrying the status and the `code` of an
 *    apiErrorSchema body ONLY when that code is a member of
 *    ARTIFACT_ERROR_CODES (unknown or absent ⇒ `code: undefined`). The status
 *    itself is not classified here — transient vs terminal is the caller's
 *    retry policy, which also falls back to client.ts's shared
 *    `isTransientStatus` when the server sent no known code.
 *  - fetch rejection: `unreachable` — "request aborted" when the caller's
 *    signal fired, the timeout in ms when ours did, "network error" otherwise.
 *
 * Timeouts (ADR-010 决策 24): JSON requests share client.ts's 10s window; the blob
 * PUT gets its own 60s one (one file is ≤10 MiB, but it is the only request
 * that moves that many bytes). Both are injectable.
 *
 * Secret hygiene: `reason` strings are built from fixed labels, statuses and
 * timeout values only — the machine credential never enters one, and neither
 * does the response body text (only the whitelisted `code` is read).
 */
import {
  ARTIFACT_ERROR_CODES,
  ARTIFACT_SYNC_ID_HEADER,
  apiErrorSchema,
  artifactSyncErrorReportResponseSchema,
  commitArtifactSyncResponseSchema,
  machineLoopArtifactsResponseSchema,
  prepareArtifactSyncResponseSchema,
  putArtifactBlobResponseSchema,
  type ArtifactErrorCode,
  type ArtifactSyncErrorReportRequest,
  type ArtifactSyncErrorReportResponse,
  type CommitArtifactSyncResponse,
  type MachineLoopArtifactsResponse,
  type PrepareArtifactSyncRequest,
  type PrepareArtifactSyncResponse,
  type PutArtifactBlobResponse,
} from "@loopzhb/protocol";

/** The per-request window for every JSON call (GET baseline, prepare, commit,
 *  sync-error report) — the same 10s client.ts uses. */
export const ARTIFACT_REQUEST_TIMEOUT_MS = 10_000;

/** The blob PUT's own window: a single file is capped at 10 MiB, so the upload
 *  is the one request that legitimately needs longer than a control-plane
 *  round trip (ADR-010 决策 24). */
export const ARTIFACT_UPLOAD_TIMEOUT_MS = 60_000;

/** The closed per-request outcome. `refused` keeps the server's status (and
 *  its code when the daemon knows it) so the state machine classifies; a
 *  request that never produced a response is `unreachable` — safe to re-issue
 *  because every artifact operation is idempotent under a frozen requestId or
 *  syncId. */
export type ArtifactHttpOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: number; code?: ArtifactErrorCode; reason: string }
  | { kind: "unreachable"; reason: string };

export interface ArtifactTransportDeps {
  baseUrl: string;
  machineCredential: string;
  /** Injectable transport — tests (and the slice-8 real-HTTP E2E) never touch
   *  a real socket. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

export interface ArtifactTransport {
  /** GET the machine-scoped baseline the daemon negotiates from at start,
   *  restart or conflict recovery (no local persistence — ADR-010 决策 24). */
  readLoop(loopId: string, signal?: AbortSignal): Promise<ArtifactHttpOutcome<MachineLoopArtifactsResponse>>;
  /** POST the complete manifest, receiving the session id and the hashes the
   *  server still needs. Carries the caller's frozen requestId, so a retry of
   *  the identical payload is the identical request (ADR-010 决策 6/9). */
  prepare(body: PrepareArtifactSyncRequest, signal?: AbortSignal): Promise<ArtifactHttpOutcome<PrepareArtifactSyncResponse>>;
  /** PUT one blob's already-verified bytes under the session's identity. */
  putBlob(hash: string, syncId: string, bytes: Buffer, signal?: AbortSignal): Promise<ArtifactHttpOutcome<PutArtifactBlobResponse>>;
  /** POST the commit — the receipt is fixed per session, so this doubles as
   *  the replay that recovers a lost commit response (zero further PUTs). */
  commit(syncId: string, signal?: AbortSignal): Promise<ArtifactHttpOutcome<CommitArtifactSyncResponse>>;
  /** POST a LOCAL scan/verification failure (never a network/server failure —
   *  that would add a doomed request to an outage, ADR-010 决策 24). */
  reportSyncError(
    loopId: string,
    body: ArtifactSyncErrorReportRequest,
    signal?: AbortSignal,
  ): Promise<ArtifactHttpOutcome<ArtifactSyncErrorReportResponse>>;
}

/** The slice of a zod schema this transport needs, structurally: the daemon
 *  does not depend on zod, and every endpoint's real protocol schema satisfies
 *  it. */
interface WireSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

interface ArtifactRequest {
  method: "GET" | "POST" | "PUT";
  /** Serialized JSON, or the verified blob bytes — never re-encoded here. */
  body?: string | Buffer;
  headers?: Record<string, string>;
  timeoutMs: number;
}

const ARTIFACT_ERROR_CODE_SET: ReadonlySet<string> = new Set(ARTIFACT_ERROR_CODES);

/** `code` is a wire string, not a contract, until it names a known artifact
 *  code — anything else degrades to "the server refused without a code we can
 *  branch on". */
function asArtifactErrorCode(value: string | undefined): ArtifactErrorCode | undefined {
  return value !== undefined && ARTIFACT_ERROR_CODE_SET.has(value) ? (value as ArtifactErrorCode) : undefined;
}

/** A body that isn't JSON at all — never confused with a parsed value. */
const NOT_JSON = Symbol("not-json");

async function tryParseJsonResponse(res: Response): Promise<unknown | typeof NOT_JSON> {
  try {
    return await res.json();
  } catch {
    return NOT_JSON;
  }
}

export function createArtifactTransport(deps: ArtifactTransportDeps): ArtifactTransport {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ARTIFACT_REQUEST_TIMEOUT_MS;
  const uploadTimeoutMs = deps.uploadTimeoutMs ?? ARTIFACT_UPLOAD_TIMEOUT_MS;

  /** One request with its window composed with the caller's shutdown signal,
   *  classified into the closed outcome. `label` labels the operation in the
   *  reason only — it is never derived from user or server data. */
  async function send<T>(
    label: string,
    path: string,
    schema: WireSchema<T>,
    request: ArtifactRequest,
    outer: AbortSignal | undefined,
  ): Promise<ArtifactHttpOutcome<T>> {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(`${deps.baseUrl}${path}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${deps.machineCredential}`,
          ...request.headers,
        },
        body: request.body,
        signal,
      });
    } catch {
      if (outer?.aborted) return { kind: "unreachable", reason: "request aborted" };
      if (timeout.aborted) return { kind: "unreachable", reason: `${label} timeout after ${request.timeoutMs}ms` };
      return { kind: "unreachable", reason: "network error" };
    }

    if (res.ok) {
      const raw = await tryParseJsonResponse(res);
      const parsed = schema.safeParse(raw === NOT_JSON ? undefined : raw);
      if (!parsed.success) {
        // The request may have been applied while its response was lost, which
        // is exactly why this is retryable: the frozen requestId/syncId make
        // the retry the same operation, not a second one.
        return { kind: "unreachable", reason: `${label} 2xx failed its schema (response lost; retry is idempotent)` };
      }
      return { kind: "ok", value: parsed.data };
    }

    const raw = await tryParseJsonResponse(res);
    const error = raw === NOT_JSON ? undefined : apiErrorSchema.safeParse(raw);
    const code = error?.success ? asArtifactErrorCode(error.data.code) : undefined;
    return { kind: "refused", status: res.status, code, reason: `${label} HTTP ${res.status}` };
  }

  return {
    readLoop(loopId, signal) {
      return send(
        "artifacts read",
        `/api/machine/loops/${loopId}/artifacts`,
        machineLoopArtifactsResponseSchema,
        { method: "GET", timeoutMs },
        signal,
      );
    },

    prepare(body, signal) {
      return send("prepare", "/api/machine/sync", prepareArtifactSyncResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
      }, signal);
    },

    putBlob(hash, syncId, bytes, signal) {
      return send("blob put", `/api/machine/blob/${hash}`, putArtifactBlobResponseSchema, {
        method: "PUT",
        headers: { [ARTIFACT_SYNC_ID_HEADER]: syncId },
        body: bytes,
        timeoutMs: uploadTimeoutMs,
      }, signal);
    },

    commit(syncId, signal) {
      return send("commit", `/api/machine/sync/${syncId}/commit`, commitArtifactSyncResponseSchema, {
        method: "POST",
        timeoutMs,
      }, signal);
    },

    reportSyncError(loopId, body, signal) {
      return send(
        "sync-error report",
        `/api/machine/loops/${loopId}/artifact-sync-error`,
        artifactSyncErrorReportResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          timeoutMs,
        },
        signal,
      );
    },
  };
}
