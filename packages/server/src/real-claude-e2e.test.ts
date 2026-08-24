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
 *  - daemon exits gracefully on SIGTERM;
 *  - captured logs do NOT contain machine credential.
 *
 * Bounded waits: registration ≤30s, agent ≤10min, whole test ≤12min.
 * Cleanup order (finally): daemon → HTTP listener → DB → temp dirs.
 *
 * Enable with LOOPZHB_REAL_CLAUDE_E2E=1. Skipped by default to avoid CI
 * dependency on auth, cost, and model stability.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopResponseSchema, runListResponseSchema, triggerRunResponseSchema } from "@loopzhb/protocol";

import { closeDb, type DbHandle } from "./db/index.js";
import { runLeases } from "./db/schema.js";
import { bootstrapServer, waitForListening, type BootedServer } from "./start.js";

const ENABLED = process.env.LOOPZHB_REAL_CLAUDE_E2E === "1";
const SUCCESS_MARKER = "PHASE2_BATCH4_E2E_OK";
const TOKEN = "dk_e2e_real_claude";

// Timeouts (plan §2.1)
const REGISTER_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 12 * 60_000;

const handles: DbHandle[] = [];
const servers: ServerType[] = [];
const bootedServers: BootedServer[] = [];
const daemons: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  // Cleanup order: daemon → HTTP listener → DB → temp dirs
  await Promise.all(
    daemons.splice(0).map(
      (proc) =>
        new Promise<void>((resolve) => {
          if (proc.killed) return resolve();
          proc.once("exit", () => resolve());
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
            resolve();
          }, 5000);
        }),
    ),
  );
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

describe.skipIf(!ENABLED)("real Claude E2E (opt-in)", () => {
  it(
    "full chain: machine register → create loop → trigger → real Claude → report → DB",
    async () => {
      // 1. Setup temp allowed root with task file and proof file paths
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-e2e-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      const taskFile = path.join(workdir, "TASK.md");
      const proofFile = path.join(workdir, "proof.txt");

      await writeFile(taskFile, `Write "${SUCCESS_MARKER}" to proof.txt`, "utf-8");

      // 2. Start production server with real HTTP listener on random port
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-e2e-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir });
      bootedServers.push(booted);
      handles.push(booted.handle);

      const server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
      servers.push(server);
      await waitForListening(server);

      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to get server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 3. Start daemon CLI as child process
      const daemonCliPath = path.join(__dirname, "../../daemon/dist/cli.js");
      const daemonEnv = {
        ...process.env,
        LOOPZHB_SERVER: baseUrl,
        LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
        LOOPZHB_ALLOWED_ROOTS: allowedRoot,
        LOOPZHB_CLAUDE_BIN: process.env.LOOPZHB_CLAUDE_BIN || "claude",
        NODE_ENV: "production",
      };

      const daemonLogs: string[] = [];
      const daemon = spawn("node", [daemonCliPath], {
        env: daemonEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemons.push(daemon);

      daemon.stdout?.on("data", (chunk) => {
        const line = chunk.toString();
        daemonLogs.push(line);
        console.log(`[daemon stdout] ${line.trim()}`);
      });
      daemon.stderr?.on("data", (chunk) => {
        const line = chunk.toString();
        daemonLogs.push(line);
        console.error(`[daemon stderr] ${line.trim()}`);
      });

      // 4. Wait for machine registration (daemon polls and self-registers)
      const machineId = `machine-${TOKEN.slice(3, 11)}`; // deterministic from token
      await waitFor(
        async () => {
          const res = await fetch(`${baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        },
        REGISTER_TIMEOUT_MS,
      );

      // 5. Create loop via HTTP
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

      // 6. Trigger run via HTTP
      const triggerRes = await fetch(`${baseUrl}/api/loops/${loop.id}/run`, { method: "POST" });
      expect(triggerRes.status).toBe(202);
      const trigger = triggerRunResponseSchema.parse(await triggerRes.json());
      if (!trigger.enqueued) throw new Error("expected the trigger to enqueue");
      const runId = trigger.runId;

      // 7. Wait for Run to reach terminal state (agent execution)
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

      // 8. Assertions: DB state
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

      // 9. Assertions: proof file content
      const proofContent = await readFile(proofFile, "utf-8");
      expect(proofContent).toBe(SUCCESS_MARKER);

      // 10. Assertions: daemon logs do NOT contain machine credential
      const allLogs = daemonLogs.join("\n");
      expect(allLogs).not.toContain(TOKEN);
      expect(allLogs).not.toContain("dk_e2e_real_claude");

      // 11. Daemon exits gracefully on SIGTERM
      const exitPromise = new Promise<number | null>((resolve) => {
        daemon.once("exit", (code) => resolve(code));
      });
      daemon.kill("SIGTERM");
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      expect(exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
