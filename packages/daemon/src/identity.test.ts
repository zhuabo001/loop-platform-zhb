/**
 * AD4 daemon half, REWRITTEN for slice 5 (ADR-010 决策 16/25): the daemon now
 * declares `artifact-sync-v1` in production — that IS the deliberate
 * enablement of continuous artifact sync, and the WatchManager ships with it.
 * What the guard keeps asserting after the rewrite:
 *
 *  - the identity's shape (five static keys, no artifact FIELD on the identity
 *    object itself);
 *  - a runtime WITHOUT a watch controller still builds the Phase-4-shaped poll
 *    body (no `watchDigest`), and the runtime → wire-client path sends only
 *    the two Phase-1 machine routes with no direct `fetch`;
 *  - a runtime WITH a controller echoes the digest only AFTER a watch set was
 *    applied, and still sends nothing artifact-shaped until then.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_SYNC_V1_CAPABILITY,
  TERMINAL_JOURNAL_V1_CAPABILITY,
  type ArtifactWatchItem,
  type Delivery,
} from "@loopzhb/protocol";

import { createMachineClient } from "./client.js";
import { machineIdentity } from "./identity.js";
import { createDaemonRuntime } from "./runtime.js";

function stubWatch(digest?: string, applied: ArtifactWatchItem[][] = []): {
  start: () => void;
  apply: (items: readonly ArtifactWatchItem[], next?: string) => void;
  currentDigest: () => string | undefined;
  drain: () => Promise<{ settled: boolean }>;
  settled: () => Promise<void>;
  watchedLoopIds: () => string[];
} {
  let current = digest;
  return {
    start: () => {},
    apply: (items, next) => {
      applied.push([...items]);
      if (next !== undefined) current = next;
    },
    currentDigest: () => current,
    drain: () => Promise.resolve({ settled: true }),
    settled: () => Promise.resolve(),
    watchedLoopIds: () => [],
  };
}

const delivery: Delivery = {
  runId: "run-ad4",
  runToken: "rk_ad4_guard",
  role: "exec",
  loop: { id: "loop-1", name: "Loop", workdir: null, taskFile: null, workflow: null, model: null, allowControl: false },
  prevState: null,
  roots: [],
  systemPrompt: "",
  task: "AD4 guard",
};

function wireClientWith(
  calls: Array<{ url: string; body: Record<string, unknown> }>,
  pollResponses: Array<Record<string, unknown>> = [],
): ReturnType<typeof createMachineClient> {
  let pollIndex = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const scripted = pollResponses[pollIndex];
    const body = url.endsWith("/poll") ? (pollIndex++, scripted ?? { deliveries: [delivery] }) : { ok: true };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return createMachineClient({ baseUrl: "http://server.test", machineCredential: "dk_ad4_guard", fetchImpl });
}

describe("machineIdentity (AD4, slice-5 rewrite)", () => {
  it("declares both terminal-journal-v1 and artifact-sync-v1 — the slice-5 enablement pin", () => {
    expect(machineIdentity().capabilities).toEqual([TERMINAL_JOURNAL_V1_CAPABILITY, ARTIFACT_SYNC_V1_CAPABILITY]);
  });

  it("carries no artifact field — exactly the five static identity keys", () => {
    expect(Object.keys(machineIdentity()).sort()).toEqual(["arch", "capabilities", "host", "platform", "version"]);
  });

  it("sends ZERO direct artifact traffic through the runtime → wire-client poll/report path (#76)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const rt = createDaemonRuntime({
      client: wireClientWith(calls),
      runner: { run: () => Promise.resolve({ ok: true, outcome: "exec", message: "done", durationMs: 0 }) },
      identity: machineIdentity(),
      pollMs: 0,
      machineCredential: "dk_ad4_guard",
    });
    // A future runtime-side direct fetch would bypass the injected wire
    // client; pin that alternate outbound path too.
    const directFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.reject(new Error("AD4: unexpected direct outbound request")),
    );
    try {
      await rt.pollOnce();
      await rt.executionSettled();
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      directFetch.mockRestore();
    }
    expect(calls.map((call) => call.url)).toEqual([
      "http://server.test/api/machine/poll",
      "http://server.test/api/machine/report",
    ]);
    expect(Object.keys(calls[0]!.body).sort()).toEqual([
      "arch", "availableSlots", "capabilities", "host", "platform", "version",
    ]);
    // No controller ⇒ the Phase-4-shaped body, verbatim.
    expect(calls[0]!.body).not.toHaveProperty("watchDigest");
    expect(calls[1]!.body).toMatchObject({ runId: "run-ad4", ok: true });
  });

  it("applies the poll's watch verbatim and echoes the digest from then on", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const applied: ArtifactWatchItem[][] = [];
    const watchItem: ArtifactWatchItem = {
      loopId: "loop-1",
      artifactDir: "/srv/proj",
      workdir: null,
      roots: [],
      configRevision: 3,
    };
    const rt = createDaemonRuntime({
      // Poll 1 carries no watch; poll 2 carries the set and its digest; poll 3
      // (the echo check) carries neither.
      client: wireClientWith(calls, [
        { deliveries: [] },
        { deliveries: [], watch: [watchItem], watchDigest: "digest-1" },
        { deliveries: [] },
      ]),
      runner: { run: () => Promise.resolve({ ok: true, outcome: "exec", message: "done", durationMs: 0 }) },
      identity: machineIdentity(),
      pollMs: 0,
      machineCredential: "dk_ad4_guard",
      watch: stubWatch(undefined, applied),
    });

    const pollBodies = (): Array<Record<string, unknown>> =>
      calls.filter((call) => call.url.endsWith("/poll")).map((call) => call.body);

    await rt.pollOnce();
    expect(pollBodies()[0]).not.toHaveProperty("watchDigest");
    expect(applied).toEqual([]);

    await rt.pollOnce();
    // The runtime handed the watch set to the manager VERBATIM, and the stub
    // stored its digest (the real manager stores it on apply too).
    expect(applied).toEqual([[watchItem]]);

    await rt.pollOnce();
    expect(pollBodies().at(-1)!.watchDigest).toBe("digest-1");
  });
});
