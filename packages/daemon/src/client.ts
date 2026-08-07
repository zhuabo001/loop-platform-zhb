/**
 * The Machine HTTP client — the daemon's ONLY wire surface (plan §2). Both
 * routes share one timeout and one error taxonomy; the classification is
 * returned as DATA (never thrown) so the runtime's retry/fail-fast policy is
 * exhaustive over a closed union:
 *
 *  poll:    ok | transient (408/429/5xx/timeout/network → next poll)
 *                 | fatal (401 bad credential, other 4xx, malformed 2xx)
 *  report:  confirmed (valid 2xx, OR 401 + code run_capability_invalid — the
 *                 terminal confirmation that the lease is already consumed)
 *                 | retry (408/429/5xx/timeout/network AND malformed 2xx —
 *                 the server may have consumed the lease while the response
 *                 was lost, so re-reporting rides to the coded-401 terminal
 *                 confirmation; never a violation of at-most-once)
 *                 | fatal (other 4xx, unparseable 401 → stop the daemon)
 *
 * A malformed POLL 2xx is fatal, not retryable: the poll may already have
 * completed the claim, and the daemon cannot recover the Delivery from a
 * corrupted response — retrying cannot safely redeliver (ADR-001).
 *
 * Secret hygiene: `reason` strings are built from status codes and fixed
 * labels only — a credential (machine or run) never enters them.
 */
import {
  pollResponseSchema,
  reportResponseSchema,
  apiErrorSchema,
  RUN_CAPABILITY_INVALID_CODE,
  type Delivery,
  type PollRequest,
  type ReportRequest,
} from "@loopzhb/protocol";

export const REQUEST_TIMEOUT_MS = 10_000;

export type PollOutcome =
  | { kind: "ok"; deliveries: Delivery[] }
  | { kind: "transient"; reason: string }
  | { kind: "fatal"; reason: string };

export type ReportOutcome =
  | { kind: "confirmed" }
  | { kind: "retry"; reason: string }
  | { kind: "fatal"; reason: string };

/** A ReportRequest captured once at the runtime/client boundary. Retries reuse
 *  this exact string, so later mutations of Runner-owned references cannot
 *  change the wire body. */
export interface SerializedReportRequest {
  readonly json: string;
}

export function serializeReportRequest(body: ReportRequest): SerializedReportRequest {
  return Object.freeze({ json: JSON.stringify(body) });
}

export interface MachineClient {
  poll(body: PollRequest, signal?: AbortSignal): Promise<PollOutcome>;
  /** `credential` is the Delivery's OPAQUE runToken — echoed as-is, never
   *  shape-checked or logged (ADR-002 reader-side opacity). */
  report(credential: string, body: SerializedReportRequest, signal?: AbortSignal): Promise<ReportOutcome>;
}

export interface MachineClientDeps {
  baseUrl: string;
  machineCredential: string;
  /** Injectable transport — tests (and the server's cross-package E2E) never
   *  touch a real socket. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Statuses the NEXT attempt can fix: the server asked us to slow down or is
 *  itself transiently broken. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 2xx body that fails the wire schema (or isn't JSON at all). */
const MALFORMED = Symbol("malformed");

async function tryParseJsonResponse(res: Response): Promise<unknown | typeof MALFORMED> {
  try {
    return await res.json();
  } catch {
    return MALFORMED;
  }
}

export function createMachineClient(deps: MachineClientDeps): MachineClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** One POST with the shared timeout composed with the caller's shutdown
   *  signal. Resolves with the Response, or a credential-free failure reason. */
  async function post(
    path: string,
    credential: string,
    bodyJson: string,
    outer: AbortSignal | undefined,
  ): Promise<{ ok: true; res: Response } | { ok: false; reason: string }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    try {
      const res = await fetchImpl(`${deps.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: bodyJson,
        signal,
      });
      return { ok: true, res };
    } catch {
      if (outer?.aborted) return { ok: false, reason: "request aborted (daemon shutting down)" };
      if (timeout.aborted) return { ok: false, reason: `request timeout after ${timeoutMs}ms` };
      return { ok: false, reason: "network error" };
    }
  }

  return {
    async poll(body, signal) {
      const r = await post("/api/machine/poll", deps.machineCredential, JSON.stringify(body), signal);
      if (!r.ok) return { kind: "transient", reason: r.reason };
      const res = r.res;
      if (res.ok) {
        const raw = await tryParseJsonResponse(res);
        const parsed = raw === MALFORMED ? undefined : pollResponseSchema.safeParse(raw);
        if (!parsed?.success) {
          return { kind: "fatal", reason: "malformed poll 2xx (a claim may already have happened; cannot recover)" };
        }
        return { kind: "ok", deliveries: parsed.data.deliveries };
      }
      if (res.status === 401) return { kind: "fatal", reason: "machine credential rejected (401)" };
      if (isTransientStatus(res.status)) return { kind: "transient", reason: `poll HTTP ${res.status}` };
      return { kind: "fatal", reason: `poll HTTP ${res.status}` };
    },

    async report(credential, body, signal) {
      const r = await post("/api/machine/report", credential, body.json, signal);
      if (!r.ok) return { kind: "retry", reason: r.reason };
      const res = r.res;
      if (res.ok) {
        const raw = await tryParseJsonResponse(res);
        const parsed = raw === MALFORMED ? undefined : reportResponseSchema.safeParse(raw);
        if (!parsed?.success) {
          return {
            kind: "retry",
            reason: "malformed report 2xx (server may have consumed the lease; re-report reaches coded 401)",
          };
        }
        // `reconciled` is parsed (tolerant reader) but carries NO Day-5
        // behavior — its semantics are T5's, verified in Day 8–10.
        return { kind: "confirmed" };
      }
      if (res.status === 401) {
        const raw = await tryParseJsonResponse(res);
        const parsed = raw === MALFORMED ? undefined : apiErrorSchema.safeParse(raw);
        if (parsed?.success && parsed.data.code === RUN_CAPABILITY_INVALID_CODE) return { kind: "confirmed" };
        return { kind: "fatal", reason: "report 401 without run_capability_invalid code (protocol error)" };
      }
      if (isTransientStatus(res.status)) return { kind: "retry", reason: `report HTTP ${res.status}` };
      return { kind: "fatal", reason: `report HTTP ${res.status}` };
    },
  };
}
