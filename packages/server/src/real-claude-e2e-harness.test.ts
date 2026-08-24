import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { DaemonControlObserver, DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";

describe("DaemonLogObserver", () => {
  it("keeps a sticky credential finding even when one oversized chunk is evicted from diagnostics", () => {
    const token = "dk_e2e_sticky_secret";
    const observer = new DaemonLogObserver([token], 64);

    observer.append("stdout", Buffer.from(`${token}${"x".repeat(128)}`));

    expect(observer.secretSeen).toBe(true);
    expect(observer.diagnosticBytes).toBe(64);
    expect(observer.diagnosticTail()).not.toContain(token);
  });

  it("detects a credential split across chunks and never forgets it after later noise", () => {
    const token = "dk_e2e_cross_chunk_secret";
    const observer = new DaemonLogObserver([token], 32);

    observer.append("stderr", Buffer.from("prefix dk_e2e_cross_"));
    observer.append("stderr", Buffer.from("chunk_secret suffix"));
    observer.append("stderr", Buffer.from("x".repeat(128)));

    expect(observer.secretSeen).toBe(true);
    expect(observer.diagnosticBytes).toBe(32);
  });

});

describe("DaemonControlObserver", () => {
  it("parses production provenance and process-group lifecycle records across chunks", () => {
    const events: Array<{ kind: "started" | "closed"; pgid: number }> = [];
    const observer = new DaemonControlObserver((event) => events.push(event));
    const sha256 = "a".repeat(64);
    const output = [
      `loopzhb claude provenance ${JSON.stringify({
        resolvedPath: "/tmp/Claude Code/claude",
        version: "2.1.227",
        sha256,
      })}`,
      `loopzhb claude process-group ${JSON.stringify({ kind: "started", pgid: 43210 })}`,
      `loopzhb claude process-group ${JSON.stringify({ kind: "closed", pgid: 43210 })}`,
      "",
    ].join("\n");

    observer.append(Buffer.from(output.slice(0, 23)));
    observer.append(Buffer.from(output.slice(23)));

    expect(observer.requireApprovedProvenance(sha256)).toEqual({
      resolvedPath: "/tmp/Claude Code/claude",
      version: "2.1.227",
      sha256,
    });
    expect(() => observer.requireApprovedProvenance("b".repeat(64))).toThrow(/does not match the approved sha256/);
    expect(events).toEqual([
      { kind: "started", pgid: 43210 },
      { kind: "closed", pgid: 43210 },
    ]);
  });
});

describe("DetachedProcessSupervisor", () => {
  it("treats a SIGTERM signal exit as closed and preserves unrelated exit listeners", async () => {
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const supervisor = new DetachedProcessSupervisor(child);
    let externalExitCalls = 0;
    child.once("exit", () => {
      externalExitCalls += 1;
    });

    try {
      await withTimeout(new Promise<void>((resolve) => child.stdout!.once("data", () => resolve())), 2000);
      const startedAt = Date.now();
      const closed = await supervisor.terminate({ graceMs: 1000, killWaitMs: 1000 });
      const closedAgain = await supervisor.terminate({ graceMs: 1000, killWaitMs: 1000 });

      expect(closed).toEqual({ kind: "closed", code: null, signal: "SIGTERM" });
      expect(closedAgain).toEqual(closed);
      expect(externalExitCalls).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      }
    }
  });

  it("force-closes a registered detached descendant after its parent has already closed", async () => {
    const descendantScript = [
      'process.on("SIGTERM", () => {});',
      'if (process.send) process.send("ready");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
      'descendant.once("message", () => { process.stdout.write(`DESCENDANT_READY ${descendant.pid}\\n`); process.exit(0); });',
    ].join(" ");
    const child = spawn(process.execPath, ["-e", parentScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const supervisor = new DetachedProcessSupervisor(child);
    const parentClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let descendantPid: number | null = null;
    let stdout = "";

    const ready = new Promise<void>((resolve) => {
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const match = /DESCENDANT_READY (\d+)/.exec(stdout);
        if (match !== null) {
          descendantPid = Number(match[1]);
          resolve();
        }
      });
    });

    try {
      await withTimeout(ready, 2000);
      supervisor.trackProcessGroup(descendantPid!);
      await withTimeout(parentClosed, 2000);
      expect(isGroupAlive(descendantPid!)).toBe(true);

      const closed = await supervisor.terminate({ graceMs: 100, killWaitMs: 1000 });

      expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
      expect(descendantPid).not.toBeNull();
      expect(isGroupAlive(descendantPid!)).toBe(false);
    } finally {
      for (const pid of [descendantPid, child.pid]) {
        if (pid === null || pid === undefined) continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      }
    }
  });
});

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`test readiness timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
