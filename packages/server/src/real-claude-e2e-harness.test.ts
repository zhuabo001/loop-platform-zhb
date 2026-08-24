import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";

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

  it("parses the production daemon provenance across chunks and requires an approved hash", () => {
    const observer = new DaemonLogObserver([], 1024);
    const sha256 = "a".repeat(64);
    const line = `loopzhb claude provenance ${JSON.stringify({
      resolvedPath: "/tmp/Claude Code/claude",
      version: "2.1.227",
      sha256,
    })}\n`;

    observer.append("stdout", Buffer.from(line.slice(0, 23)));
    observer.append("stdout", Buffer.from(line.slice(23)));

    expect(observer.requireApprovedProvenance(sha256)).toEqual({
      resolvedPath: "/tmp/Claude Code/claude",
      version: "2.1.227",
      sha256,
    });
    expect(() => observer.requireApprovedProvenance("b".repeat(64))).toThrow(/does not match the approved sha256/);
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
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      const startedAt = Date.now();
      const closed = await supervisor.terminate({ graceMs: 1000, killWaitMs: 1000 });

      expect(closed).toEqual({ kind: "closed", code: null, signal: "SIGTERM" });
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

  it("waits for inherited stdio and force-closes a detached descendant group", async () => {
    const token = "dk_e2e_late_descendant_secret";
    const descendantScript = [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write(`DESCENDANT_READY ${process.pid}\\n`);',
      `setTimeout(() => process.stdout.write(${JSON.stringify(`${token}\n`)}), 120);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { detached: true, stdio: ["ignore", process.stdout, process.stderr] });`,
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const child = spawn(process.execPath, ["-e", parentScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const supervisor = new DetachedProcessSupervisor(child);
    const observer = new DaemonLogObserver([token], 1024);
    let descendantPid: number | null = null;

    const ready = new Promise<void>((resolve) => {
      child.stdout!.on("data", (chunk: Buffer) => {
        observer.append("stdout", chunk);
        const match = /DESCENDANT_READY (\d+)/.exec(chunk.toString("utf8"));
        if (match !== null) {
          descendantPid = Number(match[1]);
          resolve();
        }
      });
    });

    try {
      await ready;
      const closed = await supervisor.terminate({ graceMs: 250, killWaitMs: 1000 });

      expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
      expect(observer.secretSeen).toBe(true);
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
