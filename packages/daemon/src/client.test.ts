/**
 * Transport pins (goal doc test list 1/2/3): exact URL/Bearer/JSON body, poll
 * never sends `wait`, and the full classification table — including the
 * asymmetric malformed-2xx rule (poll fatal, report retry) and the coded-401
 * terminal confirmation. No credential ever appears in a failure reason.
 */
import { describe, expect, it } from "vitest";

import type { Delivery } from "@loopzhb/protocol";

import { createMachineClient, type MachineClient } from "./client.js";

const BASE = "http://server.test";
const MACHINE_CRED = "dk_test_machine";

interface FetchCall {
  url: string;
  init: RequestInit;
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

function makeClient(handler: FetchHandler, timeoutMs?: number): { client: MachineClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return { client: createMachineClient({ baseUrl: BASE, machineCredential: MACHINE_CRED, fetchImpl, timeoutMs }), calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function delivery(runId: string): Delivery {
  return {
    runId,
    runToken: `rk_tok_${runId}`,
    role: "exec",
    loop: {
      id: "loop-1",
      name: "Loop",
      workdir: null,
      taskFile: null,
      workflow: null,
      model: null,
      allowControl: false,
    },
    prevState: null,
    roots: [],
    systemPrompt: "",
    task: "do it",
  };
}

const IDENTITY = { host: "h", platform: "linux", arch: "x64", version: "0.1.0" };
const REPORT_BODY = { runId: "run-1", ok: true, outcome: "exec" as const, message: "m", durationMs: 0 };

describe("poll transport", () => {
  it("sends the exact URL, Bearer and flat identity body — never `wait`", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(json({ deliveries: [] })));
    const outcome = await client.poll(IDENTITY);
    expect(outcome).toEqual({ kind: "ok", deliveries: [] });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("http://server.test/api/machine/poll");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${MACHINE_CRED}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual(IDENTITY);
    expect(body).not.toHaveProperty("wait");
  });

  it("parses a valid 2xx into deliveries (tolerant reader strips unknown keys)", async () => {
    const wire = { deliveries: [{ ...delivery("run-1"), futureField: 1 }], futureTop: true };
    const { client } = makeClient(() => Promise.resolve(json(wire)));
    const outcome = await client.poll(IDENTITY);
    expect(outcome).toEqual({ kind: "ok", deliveries: [delivery("run-1")] });
  });

  it("malformed 2xx is FATAL (claim may already have happened)", async () => {
    for (const bad of [{ deliveries: "nope" }, { nope: true }]) {
      const { client } = makeClient(() => Promise.resolve(json(bad)));
      expect((await client.poll(IDENTITY)).kind).toBe("fatal");
    }
    const { client } = makeClient(() => Promise.resolve(new Response("not json", { status: 200 })));
    expect((await client.poll(IDENTITY)).kind).toBe("fatal");
  });

  it("401 is fatal (bad machine credential); other 4xx are fatal too", async () => {
    for (const status of [400, 401, 403, 404]) {
      const { client } = makeClient(() => Promise.resolve(json({ error: "x" }, status)));
      expect((await client.poll(IDENTITY)).kind, String(status)).toBe("fatal");
    }
  });

  it("408/429/5xx are transient", async () => {
    for (const status of [408, 429, 500, 503]) {
      const { client } = makeClient(() => Promise.resolve(json({ error: "x" }, status)));
      const outcome = await client.poll(IDENTITY);
      expect(outcome.kind, String(status)).toBe("transient");
    }
  });

  it("network failure and timeout are transient; reasons never carry the credential", async () => {
    const { client } = makeClient(() => Promise.reject(new TypeError("fetch failed")));
    const net = await client.poll(IDENTITY);
    expect(net.kind).toBe("transient");
    expect(JSON.stringify(net)).not.toContain(MACHINE_CRED);

    // A fetch that never settles on its own but HONORS the abort signal
    // (what undici does) → the client's 10s timeout classifies it transient.
    const slow = makeClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init.signal;
          sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
        }),
      20,
    );
    const timeout = await slow.client.poll(IDENTITY);
    expect(timeout.kind).toBe("transient");
    if (timeout.kind === "transient") expect(timeout.reason).toContain("timeout");
  });

  it("a daemon-initiated abort classifies as transient, not fatal", async () => {
    const ctl = new AbortController();
    const { client } = makeClient((_url, init) => {
      ctl.abort();
      return Promise.reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
    });
    const outcome = await client.poll(IDENTITY, ctl.signal);
    expect(outcome.kind).toBe("transient");
  });
});

describe("report transport", () => {
  const RUN_CRED = "rk_run_cred_1";

  it("sends the exact URL, the opaque run credential as Bearer, and the immutable body", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(json({ ok: true })));
    const outcome = await client.report(RUN_CRED, REPORT_BODY);
    expect(outcome).toEqual({ kind: "confirmed" });
    const { url, init } = calls[0]!;
    expect(url).toBe("http://server.test/api/machine/report");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${RUN_CRED}`);
    expect(JSON.parse(String(init.body))).toEqual(REPORT_BODY);
  });

  it("a 2xx carrying `reconciled` is confirmed and otherwise ignored (Day-5 reader duty)", async () => {
    const { client } = makeClient(() => Promise.resolve(json({ ok: true, reconciled: true })));
    expect(await client.report(RUN_CRED, REPORT_BODY)).toEqual({ kind: "confirmed" });
  });

  it("malformed 2xx is RETRY (server may have consumed the lease; re-report reaches coded 401)", async () => {
    const { client } = makeClient(() => Promise.resolve(json({ nope: true })));
    expect((await client.report(RUN_CRED, REPORT_BODY)).kind).toBe("retry");
    const notJson = makeClient(() => Promise.resolve(new Response("garbage", { status: 200 })));
    expect((await notJson.client.report(RUN_CRED, REPORT_BODY)).kind).toBe("retry");
  });

  it("401 + run_capability_invalid is the TERMINAL confirmation", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(json({ error: "invalid or expired run capability", code: "run_capability_invalid" }, 401)),
    );
    expect(await client.report(RUN_CRED, REPORT_BODY)).toEqual({ kind: "confirmed" });
  });

  it("401 without the code (or unparseable) is FATAL", async () => {
    const noCode = makeClient(() => Promise.resolve(json({ error: "nope" }, 401)));
    expect((await noCode.client.report(RUN_CRED, REPORT_BODY)).kind).toBe("fatal");
    const wrongCode = makeClient(() => Promise.resolve(json({ error: "nope", code: "other" }, 401)));
    expect((await wrongCode.client.report(RUN_CRED, REPORT_BODY)).kind).toBe("fatal");
    const garbage = makeClient(() => Promise.resolve(new Response("garbage", { status: 401 })));
    expect((await garbage.client.report(RUN_CRED, REPORT_BODY)).kind).toBe("fatal");
  });

  it("408/429/5xx retry; other 4xx are fatal; reasons never carry the credential", async () => {
    for (const status of [408, 429, 500, 502]) {
      const { client } = makeClient(() => Promise.resolve(json({ error: "x" }, status)));
      expect((await client.report(RUN_CRED, REPORT_BODY)).kind, String(status)).toBe("retry");
    }
    for (const status of [400, 403, 404]) {
      const { client } = makeClient(() => Promise.resolve(json({ error: "x" }, status)));
      const outcome = await client.report(RUN_CRED, REPORT_BODY);
      expect(outcome.kind, String(status)).toBe("fatal");
      expect(JSON.stringify(outcome)).not.toContain(RUN_CRED);
    }
  });

  it("network failure and timeout are retry", async () => {
    const { client } = makeClient(() => Promise.reject(new TypeError("fetch failed")));
    expect((await client.report(RUN_CRED, REPORT_BODY)).kind).toBe("retry");
    const slow = makeClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init.signal;
          sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
        }),
      20,
    );
    expect((await slow.client.report(RUN_CRED, REPORT_BODY)).kind).toBe("retry");
  });
});
