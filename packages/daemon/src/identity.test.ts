/**
 * AD4 dormancy, daemon half (Phase 5 Batch 1 slice 3, ADR-010 决策 16): the
 * daemon declares ONLY `terminal-journal-v1` — no `artifact-sync-v1` — and
 * the identity merged into every poll carries no artifact field (the
 * identity-level evidence for "daemon sends no sync request"). Slice-3
 * review (#76) pins the actual runtime → wire-client outbound path: a full
 * poll/dispatch/report cycle sends only the two Phase-1 machine routes, and
 * the runtime-built poll body carries no artifact key. Batch 2 wiring must
 * update this pin deliberately.
 */
import { describe, expect, it, vi } from "vitest";

import { ARTIFACT_SYNC_V1_CAPABILITY, TERMINAL_JOURNAL_V1_CAPABILITY, type Delivery } from "@loopzhb/protocol";

import { createMachineClient } from "./client.js";
import { machineIdentity } from "./identity.js";
import { createDaemonRuntime } from "./runtime.js";

describe("machineIdentity (AD4)", () => {
  it("declares exactly the terminal-journal-v1 capability — no artifact-sync-v1", () => {
    expect(machineIdentity().capabilities).toEqual([TERMINAL_JOURNAL_V1_CAPABILITY]);
    expect(machineIdentity().capabilities).not.toContain(ARTIFACT_SYNC_V1_CAPABILITY);
  });

  it("carries no artifact field — exactly the five static identity keys", () => {
    expect(Object.keys(machineIdentity()).sort()).toEqual(["arch", "capabilities", "host", "platform", "version"]);
  });

  it("sends ZERO artifact-sync traffic through the runtime → wire-client poll/report path (#76)", async () => {
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
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const body = url.endsWith("/poll") ? { deliveries: [delivery] } : { ok: true };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      );
    };
    const wire = createMachineClient({
      baseUrl: "http://server.test",
      machineCredential: "dk_ad4_guard",
      fetchImpl,
    });
    const rt = createDaemonRuntime({
      client: wire,
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
    expect(calls[0]!.body).not.toHaveProperty("watchDigest");
    expect(calls[1]!.body).toMatchObject({ runId: "run-ad4", ok: true });
  });
});
