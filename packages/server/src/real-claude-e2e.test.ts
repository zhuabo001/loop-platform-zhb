/**
 * Phase 2 Batch 4: Real Claude full-chain E2E acceptance test (opt-in).
 *
 * This test validates the COMPLETE production chain with a real Claude Code
 * runner:
 *   production bootstrapServer → file-backed PGlite → real HTTP listener →
 *   built daemon CLI (child process) → real Claude Code (via prepareDaemon,
 *   probe, native fetch, real runner) → Report → DB persistence.
 *
 * Acceptance:
 *  - proof file content is exact;
 *  - DB contains exactly ONE Run, phase=done, outcome=exec;
 *  - message contains the fixed success marker, error=null, progress=null,
 *    durationMs is valid;
 *  - RunLease is consumed, Loop's lastRun points to the Run;
 *  - daemon exits gracefully on SIGTERM (with SIGKILL fallback and full cleanup);
 *  - captured logs (byte-bounded, no prefix) do NOT contain machine credential.
 *
 * Bounded waits: registration ≤30s, agent ≤10min, whole test ≤12min.
 * Cleanup order (finally): daemon → HTTP listener → DB → temp dirs.
 *
 * Enable with LOOPZHB_REAL_CLAUDE_E2E=1. Skipped by default to avoid CI
 * dependency on auth, cost, and model stability.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopResponseSchema, runListResponseSchema, triggerRunResponseSchema } from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { runLeases } from "./db/schema.js";
import { bootstrapServer, waitForListening } from "./start.js";

const ENABLED = process.env.LOOPZHB_REAL_CLAUDE_E2E === "1";
const SUCCESS_MARKER = "PHASE2_BATCH4_E2E_OK";
const TOKEN = "dk_e2e_real_claude";

// Timeouts (plan §2.1)
const REGISTER_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 12 * 60_000;

const handles: DbHandle[] = [];
const servers: ServerType[] = [];
const daemons: ChildProcess[] = [];
const tempDirs: string[] = [];

const MAX_LOG_BYTES = 64 * 1024; // 64 KiB byte-bounded log buffer

/** Byte-bounded log accumulator (no chunk prefix, preserves cross-chunk sequences). */
class LogBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;

    // Trim oldest chunks until under limit
    while (this.totalBytes > MAX_LOG_BYTES && this.chunks.length > 0) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.length;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }

  contains(needle: string): boolean {
    return this.toString().includes(needle);
  }
}

/** Wait for process exit with proper cleanup. */
async function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      proc.removeAllListeners("exit");
    };

    const onExit = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(code);
    };

    // Register listener BEFORE checking if already exited
    proc.once("exit", onExit);

    // Check if already exited (race condition guard)
    if (proc.exitCode !== null) {
      onExit(proc.exitCode);
      return;
    }

    // Timeout fallback
    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

/** Kill process and wait for actual exit. */
async function killAndWait(proc: ChildProcess): Promise<void> {
  // Try SIGTERM first
  if (proc.exitCode === null && !proc.killed) {
    proc.kill("SIGTERM");
    const exitCode = await waitForProcessExit(proc, 5000);
    if (exitCode !== null) return; // Graceful exit
  }

  // Fallback to SIGKILL
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
    await waitForProcessExit(proc, 2000);
  }
}

afterEach(async () => {
  // Cleanup order: daemon → HTTP listener → DB → temp dirs
  await Promise.all(daemons.splice(0).map((proc) => killAndWait(proc)));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

/** Wait for a condition with timeout. */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

/** Resolve Claude binary and record provenance. */
async function resolveClaudeProvenance(claudeBin: string): Promise<{
  resolvedPath: string;
  version: string;
  sha256: string;
}> {
  // Resolve PATH if not absolute
  let resolvedPath = claudeBin;
  if (!path.isAbsolute(claudeBin)) {
    try {
      resolvedPath = execSync(`which ${claudeBin}`, { encoding: "utf-8" }).trim();
    } catch {
      throw new Error(`Claude binary not found in PATH: ${claudeBin}`);
    }
  }

  // Get version
  const version = execSync(`${resolvedPath} --version`, { encoding: "utf-8" }).trim();

  // Compute SHA256
  const stats = await stat(resolvedPath);
  if (!stats.isFile()) throw new Error(`Claude binary is not a file: ${resolvedPath}`);
  const content = await readFile(resolvedPath);
  const sha256 = createHash("sha256").update(content).digest("hex");

  return { resolvedPath, version, sha256 };
}

describe.skipIf(!ENABLED)("real Claude E2E (opt-in)", () => {
  it(
    "full chain: machine register → create loop → trigger → real Claude → report → DB",
    async () => {
      // 1. Setup temp allowed root with task file and proof file paths
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-e2e-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      await mkdir(workdir, { recursive: true });
      const taskFile = path.join(workdir, "TASK.md");
      const proofFile = path.join(workdir, "proof.txt");

      await writeFile(taskFile, `Write "${SUCCESS_MARKER}" to proof.txt`, "utf-8");

      // 2. Start production server with real HTTP listener on random port
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-e2e-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir });
      handles.push(booted.handle);

      const server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
      servers.push(server);
      await waitForListening(server);

      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to get server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 3. Resolve and record Claude binary provenance
      const claudeBin = process.env.LOOPZHB_CLAUDE_BIN || "claude";
      const provenance = await resolveClaudeProvenance(claudeBin);
      console.log(`[e2e] Claude provenance:`);
      console.log(`  resolvedPath: ${provenance.resolvedPath}`);
      console.log(`  version: ${provenance.version}`);
      console.log(`  sha256: ${provenance.sha256}`);

      // 4. Start daemon CLI as child process
      const daemonCliPath = path.join(__dirname, "../../daemon/dist/cli.js");
      const daemonEnv = {
        ...process.env,
        LOOPZHB_SERVER_URL: baseUrl,
        LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
        LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
        LOOPZHB_CLAUDE_BIN: provenance.resolvedPath, // Use resolved path
        NODE_ENV: "production",
      };

      const logBuffer = new LogBuffer();
      const daemon = spawn("node", [daemonCliPath], {
        env: daemonEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemons.push(daemon);

      daemon.stdout?.on("data", (chunk: Buffer) => {
        logBuffer.append(chunk);
        console.log(`[daemon stdout] ${chunk.toString().trim()}`);
      });
      daemon.stderr?.on("data", (chunk: Buffer) => {
        logBuffer.append(chunk);
        console.error(`[daemon stderr] ${chunk.toString().trim()}`);
      });

      // 5. Wait for machine registration (daemon polls and self-registers)
      const machineId = machineIdFromToken(TOKEN);
      await waitFor(
        async () => {
          const res = await fetch(`${baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        },
        REGISTER_TIMEOUT_MS,
      );

      // 6. Create loop via HTTP
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineId,
          name: "e2e-real-claude",
          workdir,
          taskFile,
        }),
      });
      expect(createRes.status).toBe(201);
      const { loop } = createLoopResponseSchema.parse(await createRes.json());

      // 7. Trigger run via HTTP
      const triggerRes = await fetch(`${baseUrl}/api/loops/${loop.id}/run`, { method: "POST" });
      expect(triggerRes.status).toBe(202);
      const trigger = triggerRunResponseSchema.parse(await triggerRes.json());
      if (!trigger.enqueued) throw new Error("expected the trigger to enqueue");
      const runId = trigger.runId;

      // 8. Wait for Run to reach terminal state (agent execution)
      await waitFor(
        async () => {
          const res = await fetch(`${baseUrl}/api/loops/${loop.id}/runs`);
          if (!res.ok) return false;
          const body = runListResponseSchema.parse(await res.json());
          const run = body.runs.find((r) => r.id === runId);
          return run !== undefined && (run.phase === "done" || run.phase === "error");
        },
        AGENT_TIMEOUT_MS,
      );

      // 9. Assertions: DB state
      const runsRes = await fetch(`${baseUrl}/api/loops/${loop.id}/runs`);
      expect(runsRes.status).toBe(200);
      const runList = runListResponseSchema.parse(await runsRes.json()).runs;
      expect(runList).toHaveLength(1);
      const run = runList[0]!;

      expect(run).toMatchObject({
        id: runId,
        loopId: loop.id,
        machineId,
        phase: "done",
        outcome: "exec",
        error: null,
        progress: null,
      });
      expect(run.message).toContain(SUCCESS_MARKER);
      expect(Number.isInteger(run.durationMs)).toBe(true);
      expect(run.durationMs!).toBeGreaterThan(0);

      // RunLease consumed
      const leases = await booted.handle.db.select().from(runLeases);
      expect(leases).toHaveLength(0);

      // Loop's lastRun points to this run
      const loopsRes = await fetch(`${baseUrl}/api/loops`);
      const loopBody = (await loopsRes.json()) as { loops: Array<{ id: string; lastRun: any }> };
      const updatedLoop = loopBody.loops.find((l) => l.id === loop.id);
      expect(updatedLoop?.lastRun).toMatchObject({ id: runId, phase: "done", outcome: "exec" });

      // 10. Assertions: proof file content (trim trailing whitespace/newline)
      const proofContent = await readFile(proofFile, "utf-8");
      expect(proofContent.trim()).toBe(SUCCESS_MARKER);

      // 11. Daemon exits gracefully on SIGTERM (with SIGKILL fallback)
      await killAndWait(daemon);
      expect(daemon.exitCode).toBe(0);

      // 12. Assertions: daemon logs (byte-bounded, no prefix) do NOT contain machine credential
      expect(logBuffer.contains(TOKEN)).toBe(false);
      expect(logBuffer.contains("dk_e2e_real_claude")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
