/**
 * AD4 dormancy, daemon half (Phase 5 Batch 1 slice 3, ADR-010 决策 16): the
 * daemon declares ONLY `terminal-journal-v1` — no `artifact-sync-v1` — and
 * the identity merged into every poll carries no artifact field (the
 * identity-level evidence for "daemon sends no sync request"). Slice-3
 * review (#76) extended the pin to the OUTBOUND path itself: the runtime's
 * built poll body carries no artifact key (watchDigest stays unsent), and
 * the wire client's complete endpoint set is the two Phase-1 machine
 * routes. Batch 2 wiring must update these pins deliberately.
 */
import { describe, expect, it } from "vitest";

import { ARTIFACT_SYNC_V1_CAPABILITY, TERMINAL_JOURNAL_V1_CAPABILITY, type PollRequest } from "@loopzhb/protocol";

import { createMachineClient, serializeReportRequest, type MachineClient } from "./client.js";
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

  it("sends ZERO artifact-sync traffic on the outbound path: the poll body has no artifact key and the wire client knows only the two Phase-1 endpoints (#76)", async () => {
    // (a) The poll body the RUNTIME actually builds (machineIdentity + the
    // dynamic availableSlots) carries no artifact field — a future change
    // could add one without touching identity.ts, so the pin sits on the
    // runtime's output, not only on the static identity.
    const polls: PollRequest[] = [];
    const stubClient: MachineClient = {
      poll: (body) => {
        polls.push(body);
        return Promise.resolve({ kind: "ok", deliveries: [] });
      },
      report: () => Promise.resolve({ kind: "confirmed" }),
    };
    const rt = createDaemonRuntime({
      client: stubClient,
      runner: { run: () => Promise.reject(new Error("AD4 pin: an idle poll never dispatches a run")) },
      identity: machineIdentity(),
      pollMs: 0,
      machineCredential: "dk_ad4_guard",
    });
    await rt.pollOnce();
    expect(polls).toHaveLength(1);
    expect(Object.keys(polls[0]!).sort()).toEqual([
      "arch",
      "availableSlots",
      "capabilities",
      "host",
      "platform",
      "version",
    ]);
    // The Phase 5 schema field exists (poll.ts) but Batch 1 never sends it.
    expect(polls[0]!).not.toHaveProperty("watchDigest");

    // (b) Over a full poll+report cycle the wire client POSTs exactly the
    // two Phase-1 machine endpoints — there is NO artifact-sync request in
    // the daemon's outbound surface to send.
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input);
      calls.push(url);
      const body = url.endsWith("/poll") ? { deliveries: [] } : { ok: true };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      );
    };
    const wire = createMachineClient({
      baseUrl: "http://server.test",
      machineCredential: "dk_ad4_guard",
      fetchImpl,
    });
    expect(await wire.poll(machineIdentity())).toEqual({ kind: "ok", deliveries: [] });
    expect(
      await wire.report(
        "rk_ad4_guard",
        serializeReportRequest({ runId: "run-1", ok: true, outcome: "exec", message: "m", durationMs: 0 }),
      ),
    ).toEqual({ kind: "confirmed" });
    expect(calls).toEqual(["http://server.test/api/machine/poll", "http://server.test/api/machine/report"]);
  });
});
