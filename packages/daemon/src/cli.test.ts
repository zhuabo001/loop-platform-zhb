import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import type { Delivery } from "@loopzhb/protocol";
import { describe, expect, it } from "vitest";

import { createStartupJail, productionRunnerFactory, registerShutdownSignals, type ShutdownSignalEvents } from "./cli.js";
import { JailError } from "./jail.js";
import { createFakeRunner, FAKE_RUNNER_MESSAGE } from "./runner.js";

describe("registerShutdownSignals", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`aborts on ${signal} and unregisters both signal listeners`, () => {
      const events = new EventEmitter() as ShutdownSignalEvents & EventEmitter;
      const ctl = new AbortController();
      const logs: string[] = [];
      const unregister = registerShutdownSignals(ctl, (line) => logs.push(line), events);

      expect(events.listenerCount("SIGINT")).toBe(1);
      expect(events.listenerCount("SIGTERM")).toBe(1);
      events.emit(signal, signal);

      expect(ctl.signal.aborted).toBe(true);
      expect(logs).toEqual([`received ${signal} — stopping poll loop`]);

      unregister();
      expect(events.listenerCount("SIGINT")).toBe(0);
      expect(events.listenerCount("SIGTERM")).toBe(0);
    });
  }
});

describe("createStartupJail — batch-2 startup validation (I5)", () => {
  const baseConfig = {
    serverUrl: "http://127.0.0.1:3000",
    machineCredential: "dk_secret_cli_credential",
    pollMs: 3000,
    claudeBin: "claude",
    agentTimeoutMs: 1800000,
  };

  it("rejects non-existent roots with a JailError that never echoes the credential", async () => {
    try {
      await createStartupJail({ ...baseConfig, allowedRoots: ["/nonexistent/loopzhb-cli-root"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JailError);
      expect((err as Error).message).not.toContain("dk_secret_cli_credential");
    }
  });

  it("canonicalizes valid roots and prepares the daemon-owned scratch parent", async () => {
    const jail = await createStartupJail({ ...baseConfig, allowedRoots: [realpathSync(tmpdir())] });
    expect(jail.daemonRoots).toEqual([realpathSync(tmpdir())]);
  });
});

describe("production Runner seam (I6)", () => {
  it("is STILL the Fake Runner — no Delivery ever spawns a real subprocess in batch 2", async () => {
    expect(productionRunnerFactory).toBe(createFakeRunner);
    const delivery = {
      runId: "run-1",
      runToken: "rt_x",
      role: "run",
      loop: {
        id: "loop-1",
        name: "loop",
        workdir: null,
        taskFile: null,
        workflow: null,
        model: null,
        allowControl: false,
      },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "do nothing",
    } as unknown as Delivery;
    const report = await productionRunnerFactory().run(delivery, {
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    expect(report.message).toBe(FAKE_RUNNER_MESSAGE);
  });
});
