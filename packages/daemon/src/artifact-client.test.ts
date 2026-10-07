/**
 * Transport pins for the artifact sync client (plan §A, test item ⑫): the
 * exact URL/method/headers/body of all five routes, one window per request
 * class, and the full classification table — including the inversion that a
 * malformed 2xx is `unreachable` (every operation is idempotent under a frozen
 * requestId/syncId) where client.ts's poll calls it fatal. No credential ever
 * appears in a reason, and neither does a response body's text.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SYNC_ID_HEADER,
  type ArtifactErrorCode,
  type ArtifactSyncErrorReportRequest,
  type PrepareArtifactSyncRequest,
} from "@loopzhb/protocol";

import {
  ARTIFACT_REQUEST_TIMEOUT_MS,
  ARTIFACT_UPLOAD_TIMEOUT_MS,
  createArtifactTransport,
  type ArtifactHttpOutcome,
  type ArtifactTransport,
} from "./artifact-client.js";

const BASE = "http://server.test";
const MACHINE_CRED = "dk_test_machine";

interface FetchCall {
  url: string;
  init: RequestInit;
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

function makeTransport(
  handler: FetchHandler,
  timeouts: { timeoutMs?: number; uploadTimeoutMs?: number } = {},
): { transport: ArtifactTransport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return {
    transport: createArtifactTransport({ baseUrl: BASE, machineCredential: MACHINE_CRED, fetchImpl, ...timeouts }),
    calls,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that never settles on its own but HONORS the abort signal (what
 *  undici does), so an injected short timeout classifies as a timeout. */
const hanging: FetchHandler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const sig = init.signal;
    sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
  });

const headers = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

const LOOP = "loop-1";
const SYNC = "sync-1";
const HASH = "a".repeat(64);
const BYTES = Buffer.from([0x00, 0x01, 0xfe, 0xff]);

const LOOP_WIRE = { loopId: LOOP, artifactDir: "/srv/artifacts/loop-1", configRevision: 3, manifestRevision: 7 };
const PREPARE_WIRE = { syncId: SYNC, needHashes: [HASH], expiresAt: "2026-10-05T00:00:00.000Z" };
const PUT_WIRE = { ok: true, size: BYTES.byteLength, published: true };
const COMMIT_WIRE = { artifactSnapshotId: "snap-1", manifestRevision: 8 };
const REPORT_WIRE = { ok: true, recorded: true };

const PREPARE_BODY: PrepareArtifactSyncRequest = {
  requestId: "req-1",
  loopId: LOOP,
  configRevision: 3,
  baseManifestRevision: 7,
  entries: [{ path: "notes/a.md", hash: HASH, size: BYTES.byteLength }],
};
const ERROR_BODY: ArtifactSyncErrorReportRequest = {
  failure: "unreadable",
  configRevision: 3,
  baseManifestRevision: 7,
  message: "boom",
};

/** Routes each fixture by URL, so one transport can serve all five calls. */
const servingAll: FetchHandler = (url) => {
  if (url.includes("/artifacts")) return Promise.resolve(json(LOOP_WIRE));
  if (url.includes("/blob/")) return Promise.resolve(json(PUT_WIRE));
  if (url.endsWith("/commit")) return Promise.resolve(json(COMMIT_WIRE));
  if (url.includes("/artifact-sync-error")) return Promise.resolve(json(REPORT_WIRE));
  return Promise.resolve(json(PREPARE_WIRE));
};

/** The five calls, in route order — each typed to the transport's own
 *  signature so a URL or verb change is a compile error, not just a red test. */
const ALL_CALLS: Array<{ label: string; call: (t: ArtifactTransport) => Promise<ArtifactHttpOutcome<unknown>> }> = [
  { label: "readLoop", call: (t) => t.readLoop(LOOP) },
  { label: "prepare", call: (t) => t.prepare(PREPARE_BODY) },
  { label: "putBlob", call: (t) => t.putBlob(HASH, SYNC, BYTES) },
  { label: "commit", call: (t) => t.commit(SYNC) },
  { label: "reportSyncError", call: (t) => t.reportSyncError(LOOP, ERROR_BODY) },
];

describe("timeout pins", () => {
  it("pins the two windows (ADR-010 决策 24: JSON 10s, upload 60s)", () => {
    expect(ARTIFACT_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(ARTIFACT_UPLOAD_TIMEOUT_MS).toBe(60_000);
  });
});

describe("request shape", () => {
  it("sends the exact URL and method for all five routes, with the Bearer on every call", async () => {
    const { transport, calls } = makeTransport(servingAll);
    for (const { call } of ALL_CALLS) await call(transport);

    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      [`${BASE}/api/machine/loops/${LOOP}/artifacts`, "GET"],
      [`${BASE}/api/machine/sync`, "POST"],
      [`${BASE}/api/machine/blob/${HASH}`, "PUT"],
      [`${BASE}/api/machine/sync/${SYNC}/commit`, "POST"],
      [`${BASE}/api/machine/loops/${LOOP}/artifact-sync-error`, "POST"],
    ]);
    for (const { init } of calls) expect(headers(init).authorization).toBe(`Bearer ${MACHINE_CRED}`);
  });

  it("serializes the JSON bodies and gives the blob PUT the sync-id header, the bytes verbatim and no body elsewhere", async () => {
    const { transport, calls } = makeTransport(servingAll);
    await transport.prepare(PREPARE_BODY);
    await transport.putBlob(HASH, SYNC, BYTES);
    await transport.commit(SYNC);
    await transport.reportSyncError(LOOP, ERROR_BODY);

    const [prepare, put, commit, report] = calls.map((c) => c.init);
    expect(headers(prepare!).authorization).toBe(`Bearer ${MACHINE_CRED}`);
    expect(headers(prepare!)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(prepare!.body))).toEqual(PREPARE_BODY);

    expect(headers(put!)[ARTIFACT_SYNC_ID_HEADER]).toBe(SYNC);
    expect(headers(put!)["content-type"]).toBeUndefined();
    expect(Buffer.from(put!.body as Uint8Array).equals(BYTES)).toBe(true);

    expect(commit!.body).toBeUndefined();

    expect(headers(report!)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(report!.body))).toEqual(ERROR_BODY);
  });

  it("gives the PUT the upload window and every JSON route the request window", async () => {
    const { transport } = makeTransport(hanging, { timeoutMs: 20, uploadTimeoutMs: 60 });
    const put = await transport.putBlob(HASH, SYNC, BYTES);
    expect(put.kind).toBe("unreachable");
    if (put.kind === "unreachable") {
      expect(put.reason).toContain("timeout");
      expect(put.reason).toContain("60ms"); // the upload window, not the 20ms request window
    }
    const commit = await transport.commit(SYNC);
    expect(commit.kind).toBe("unreachable");
    if (commit.kind === "unreachable") expect(commit.reason).toContain("20ms");
  });
});

describe("2xx parsing", () => {
  it("parses the loop read, tolerantly stripping future keys", async () => {
    const { transport } = makeTransport(() => Promise.resolve(json({ ...LOOP_WIRE, futureTop: true })));
    expect(await transport.readLoop(LOOP)).toEqual({ kind: "ok", value: LOOP_WIRE });
  });

  it("parses prepare", async () => {
    const { transport } = makeTransport(() => Promise.resolve(json(PREPARE_WIRE)));
    expect(await transport.prepare(PREPARE_BODY)).toEqual({ kind: "ok", value: PREPARE_WIRE });
  });

  it("parses the blob PUT (size is the verified byte count, published the dedupe flag)", async () => {
    for (const published of [true, false]) {
      const { transport } = makeTransport(() => Promise.resolve(json({ ...PUT_WIRE, published })));
      expect(await transport.putBlob(HASH, SYNC, BYTES)).toEqual({ kind: "ok", value: { ...PUT_WIRE, published } });
    }
  });

  it("parses the commit receipt", async () => {
    const { transport } = makeTransport(() => Promise.resolve(json(COMMIT_WIRE)));
    expect(await transport.commit(SYNC)).toEqual({ kind: "ok", value: COMMIT_WIRE });
  });

  it("parses the sync-error report", async () => {
    for (const recorded of [true, false]) {
      const { transport } = makeTransport(() => Promise.resolve(json({ ok: true, recorded })));
      expect(await transport.reportSyncError(LOOP, ERROR_BODY)).toEqual({ kind: "ok", value: { ok: true, recorded } });
    }
  });

  it("a 2xx that fails its schema — or isn't JSON — is `unreachable` on every route", async () => {
    for (const { label, call } of ALL_CALLS) {
      const { transport } = makeTransport(() => Promise.resolve(json({ nope: true })));
      expect((await call(transport)).kind, label).toBe("unreachable");

      const notJson = makeTransport(() => Promise.resolve(new Response("garbage", { status: 200 })));
      expect((await call(notJson.transport)).kind, label).toBe("unreachable");
    }
    // The partial payload is also a lost response, never a silent default.
    const dropped = makeTransport(() => Promise.resolve(json({ manifestRevision: 8 })));
    const outcome = await dropped.transport.commit(SYNC);
    expect(outcome.kind).toBe("unreachable");
  });
});

describe("non-2xx classification", () => {
  it("keeps a whitelisted code and never copies the body text into the reason", async () => {
    const { transport } = makeTransport(() =>
      Promise.resolve(json({ error: "SECRET-BODY-TEXT", code: "artifact_session_expired" }, 409)),
    );
    const outcome = await transport.commit(SYNC);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe("artifact_session_expired");
    expect(outcome.reason).toContain("409");
    expect(outcome.reason).not.toContain("SECRET-BODY-TEXT");
  });

  it("degrades an unknown, foreign or absent code to `code: undefined`", async () => {
    for (const body of [
      { error: "x", code: "not_an_artifact_code" },
      { error: "x", code: "run_capability_invalid" }, // real code, not an artifact one
      { error: "x" },
      { nope: true }, // not even an apiError body
    ]) {
      const { transport } = makeTransport(() => Promise.resolve(json(body, 409)));
      const outcome = await transport.commit(SYNC);
      expect(outcome.kind, JSON.stringify(body)).toBe("refused");
      if (outcome.kind !== "refused") continue;
      expect(outcome.status, JSON.stringify(body)).toBe(409);
      expect(outcome.code, JSON.stringify(body)).toBeUndefined();
    }
  });

  it("pins the 401/403/404/413/409 refusal shapes", async () => {
    const table: Array<[number, string | undefined, ArtifactErrorCode | undefined]> = [
      [401, undefined, undefined], // the server's flat credential 401 carries no code
      [401, "run_capability_invalid", undefined], // a non-artifact code never leaks through
      [403, "artifact_attribution_missing", "artifact_attribution_missing"],
      [404, undefined, undefined], // an unknown session is a flat 404 (the caller decides)
      [413, undefined, undefined], // prepare body over the cap
      [409, "artifact_revision_exhausted", "artifact_revision_exhausted"],
    ];
    for (const [status, sentCode, expected] of table) {
      const { transport } = makeTransport(() =>
        Promise.resolve(json({ error: "x", ...(sentCode === undefined ? {} : { code: sentCode }) }, status)),
      );
      const outcome = await transport.readLoop(LOOP);
      expect(outcome.kind, String(status)).toBe("refused");
      if (outcome.kind !== "refused") continue;
      expect(outcome.status, String(status)).toBe(status);
      expect(outcome.code, String(status)).toBe(expected);
    }
  });

  it("refuses 408/429/5xx without classifying them — that is the caller's retry policy", async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      const { transport } = makeTransport(() =>
        Promise.resolve(json({ error: "x", code: "artifact_storage_error" }, status)),
      );
      const outcome = await transport.putBlob(HASH, SYNC, BYTES);
      expect(outcome.kind, String(status)).toBe("refused");
      expect(outcome).toMatchObject({ kind: "refused", status, code: "artifact_storage_error" });
    }
  });
});

describe("no response", () => {
  it("a fetch rejection is `unreachable` \"network error\"", async () => {
    const { transport } = makeTransport(() => Promise.reject(new TypeError("fetch failed")));
    expect(await transport.commit(SYNC)).toEqual({ kind: "unreachable", reason: "network error" });
  });

  it("a caller abort is `unreachable` and named as an abort", async () => {
    const ctl = new AbortController();
    const { transport } = makeTransport((_url, init) => {
      ctl.abort();
      return Promise.reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
    });
    const outcome = await transport.putBlob(HASH, SYNC, BYTES, ctl.signal);
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind === "unreachable") expect(outcome.reason).toContain("aborted");
  });

  it("a timeout is `unreachable` and names the window it exceeded", async () => {
    const { transport } = makeTransport(hanging, { timeoutMs: 20 });
    const outcome = await transport.prepare(PREPARE_BODY);
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind === "unreachable") {
      expect(outcome.reason).toContain("timeout");
      expect(outcome.reason).toContain("20ms");
    }
  });

  it("never leaks the machine credential into a failure reason (scan over every failure mode)", async () => {
    const ctl = new AbortController();
    const cases: Array<{
      handler: FetchHandler;
      timeouts?: { timeoutMs?: number };
      signal?: AbortSignal;
      call: (t: ArtifactTransport, signal?: AbortSignal) => Promise<ArtifactHttpOutcome<unknown>>;
    }> = [
      { handler: () => Promise.reject(new TypeError("fetch failed")), call: (t) => t.prepare(PREPARE_BODY) },
      {
        handler: () => Promise.resolve(json({ error: "e", code: "artifact_storage_error" }, 503)),
        call: (t) => t.putBlob(HASH, SYNC, BYTES),
      },
      { handler: () => Promise.resolve(json({ error: "e" }, 401)), call: (t) => t.readLoop(LOOP) },
      { handler: () => Promise.resolve(new Response("garbage", { status: 200 })), call: (t) => t.commit(SYNC) },
      { handler: hanging, timeouts: { timeoutMs: 20 }, call: (t) => t.commit(SYNC) },
      {
        handler: (_url, init) => {
          ctl.abort();
          return Promise.reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
        },
        signal: ctl.signal,
        call: (t, signal) => t.readLoop(LOOP, signal),
      },
    ];

    const reasons: string[] = [];
    for (const { handler, timeouts, signal, call } of cases) {
      const { transport, calls } = makeTransport(handler, timeouts ?? {});
      const outcome = await call(transport, signal);
      expect(outcome.kind).not.toBe("ok");
      if (outcome.kind !== "ok") reasons.push(outcome.reason);
      // Non-vacuity: the credential really was on the wire for this case.
      expect(headers(calls[0]!.init).authorization).toBe(`Bearer ${MACHINE_CRED}`);
    }

    expect(reasons).toHaveLength(cases.length);
    for (const reason of reasons) expect(reason).not.toContain(MACHINE_CRED);
  });
});
