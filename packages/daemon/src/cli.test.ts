import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Delivery } from "@loopzhb/protocol";
import { describe, expect, it } from "vitest";

import {
  createStartupJail,
  prepareDaemon,
  productionRunnerFactory,
  registerShutdownSignals,
  type ShutdownSignalEvents,
} from "./cli.js";
import { JailError, type WorkdirJail } from "./jail.js";
import { ClaudeProbeError } from "./probe-claude.js";
import { createFakeRunner } from "./runner.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/fake-claude.mjs", import.meta.url));

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

describe("production Runner seam (I6, inverted in batch 3)", () => {
  it("is NO LONGER the Fake Runner — the factory builds the Claude adapter", async () => {
    expect(productionRunnerFactory).not.toBe(createFakeRunner);

    // The seam is the Claude adapter: an unsupported agent fails WITHOUT
    // touching the jail (a stub that throws on any use proves it).
    const jail: WorkdirJail = {
      daemonRoots: ["/"],
      scratchRoot: "/tmp/unused-test-scratch",
      resolve: () => Promise.reject(new Error("jail must not be used for an unsupported agent")),
      revalidate: () => Promise.reject(new Error("jail must not be used for an unsupported agent")),
      release: () => Promise.reject(new Error("jail must not be used for an unsupported agent")),
      dispose: () => Promise.resolve(),
    };
    const runner = productionRunnerFactory({ jail, claudeBin: "claude", timeoutMs: 1000, envSource: {} });
    const delivery = {
      runId: "run-1",
      runToken: "rt_x",
      role: "exec",
      loop: {
        id: "loop-1",
        name: "loop",
        workdir: null,
        taskFile: null,
        workflow: null,
        model: null,
        allowControl: false,
        agent: "codex",
      },
      prevState: null,
      roots: [],
      systemPrompt: "",
      task: "do nothing",
    } as unknown as Delivery;
    const report = await runner.run(delivery, { signal: new AbortController().signal, onProgress: () => {} });
    expect(report).toEqual({ ok: false, error: "unsupported agent: codex" });
  });
});

describe("prepareDaemon — the batch-3 composition root", () => {
  const baseConfig = {
    serverUrl: "http://127.0.0.1:3000",
    machineCredential: "dk_secret_cli_credential",
    pollMs: 3000,
    claudeBin: "claude",
    agentTimeoutMs: 1800000,
  };

  it("a probe failure rejects BEFORE any client or poll exists", async () => {
    await expect(
      prepareDaemon(
        { ...baseConfig, allowedRoots: [realpathSync(tmpdir())], claudeBin: path.join(tmpdir(), "no-such-claude") },
        {},
      ),
    ).rejects.toThrow(ClaudeProbeError);
  });

  it("a startup failure releases the minted control root (review STD-4)", async () => {
    let minted: string | null = null;
    let scratchRoot: string | null = null;
    await expect(
      prepareDaemon(
        { ...baseConfig, allowedRoots: [realpathSync(tmpdir())], claudeBin: path.join(tmpdir(), "no-such-claude") },
        {},
        {
          onControlRoot: (root) => {
            minted = root.rootDir;
          },
          onJail: (jail) => {
            scratchRoot = jail.scratchRoot;
          },
        },
      ),
    ).rejects.toThrow(ClaudeProbeError);
    expect(minted).not.toBeNull();
    expect(existsSync(minted!)).toBe(false); // no loopzhb-control-* residue
    expect(scratchRoot).not.toBeNull();
    expect(existsSync(scratchRoot!)).toBe(false); // no loopzhb-runs-* residue
  });

  it("an observer throw releases both per-start roots", async () => {
    let controlRoot: string | null = null;
    let scratchRoot: string | null = null;
    await expect(
      prepareDaemon(
        { ...baseConfig, allowedRoots: [realpathSync(tmpdir())], claudeBin: FIXTURE },
        { PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        {
          onJail: (jail) => {
            scratchRoot = jail.scratchRoot;
          },
          onControlRoot: (root) => {
            controlRoot = root.rootDir;
            throw new Error("observer failed");
          },
        },
      ),
    ).rejects.toThrow("observer failed");
    expect(controlRoot).not.toBeNull();
    expect(scratchRoot).not.toBeNull();
    expect(existsSync(controlRoot!)).toBe(false);
    expect(existsSync(scratchRoot!)).toBe(false);
  });

  it("bad isolation roots still reject before the probe (fail-closed ordering)", async () => {
    await expect(
      prepareDaemon({ ...baseConfig, allowedRoots: ["/nonexistent/loopzhb-cli-root"], claudeBin: FIXTURE }, {}),
    ).rejects.toThrow(JailError);
  });

  it("a healthy probe assembles the runtime (jail → probe → client → Claude runner)", async () => {
    const runtime = await prepareDaemon(
      { ...baseConfig, allowedRoots: [realpathSync(tmpdir())], claudeBin: FIXTURE },
      { PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    );
    expect(runtime.pollOnce).toBeInstanceOf(Function);
    expect(runtime.inFlightCount()).toBe(0);
  });

  it("exposes the exact production probe result to the opt-in provenance observer", async () => {
    let observed: { version: string; binary: { resolvedPath: string; sha256: string } } | null = null;
    await prepareDaemon(
      { ...baseConfig, allowedRoots: [realpathSync(tmpdir())], claudeBin: FIXTURE },
      { PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
      {
        onClaudeProbe: (probe) => {
          observed = probe;
        },
      },
    );

    expect(observed).not.toBeNull();
    expect(observed!.version).toBe("2.1.227");
    expect(observed!.binary.resolvedPath).toBe(realpathSync(FIXTURE));
    expect(observed!.binary.sha256).toBe(createHash("sha256").update(readFileSync(FIXTURE)).digest("hex"));
  });
});
