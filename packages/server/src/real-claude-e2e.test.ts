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
 *  - a sticky streaming observer scans the complete stdout/stderr lifecycle
 *    for the machine credential; failure diagnostics retain at most 64 KiB;
 *  - the daemon's production probe provenance matches an operator-approved
 *    SHA-256 before the test can trigger a real Run.
 *
 * Bounded waits: registration ≤30s, agent ≤10min, whole test ≤12min.
 * Cleanup order (finally): daemon → HTTP listener → DB → temp dirs.
 *
 * Enable with LOOPZHB_REAL_CLAUDE_E2E=1 and
 * LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved hash>. Skipped by default to avoid
 * CI dependency on auth, cost, and model stability.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { collectSecretValues, resolveClaudeProviderEnv } from "@loopzhb/daemon";
import { createLoopResponseSchema, runListResponseSchema, triggerRunResponseSchema } from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { runLeases } from "./db/schema.js";
import { DaemonControlObserver, DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";
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
const daemons: DetachedProcessSupervisor[] = [];
const tempDirs: string[] = [];

const MAX_LOG_BYTES = 64 * 1024; // 64 KiB byte-bounded log buffer

afterEach(async () => {
  // Cleanup order: daemon → HTTP listener → DB → temp dirs
  for (const daemon of daemons.splice(0)) {
    await daemon.terminate({ graceMs: 5000, killWaitMs: 2000 });
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(handles.splice(0).map((h) => closeDb(h)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, 15_000);

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
      const expectedClaudeSha256 = process.env.LOOPZHB_EXPECTED_CLAUDE_SHA256;
      if (expectedClaudeSha256 === undefined || !/^[0-9a-f]{64}$/i.test(expectedClaudeSha256)) {
        throw new Error(
          "real Claude E2E requires LOOPZHB_EXPECTED_CLAUDE_SHA256 as an explicit 64-hex binary approval",
        );
      }

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

      // 3. Start the production daemon CLI. Its own production probe reports
      // the exact realpath/version/hash it pinned; no test-side shell or
      // second resolution is allowed to stand in for that identity.
      const claudeBin = process.env.LOOPZHB_CLAUDE_BIN?.trim() || "claude";
      const daemonCliPath = path.join(__dirname, "../../daemon/dist/cli.js");
      const daemonEnv = {
        ...process.env,
        LOOPZHB_SERVER_URL: baseUrl,
        LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
        LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
        LOOPZHB_CLAUDE_BIN: claudeBin,
        LOOPZHB_REAL_CLAUDE_E2E: "1",
        NODE_ENV: "production",
      };

      const daemon = spawn(process.execPath, [daemonCliPath], {
        env: daemonEnv,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const supervisor = new DetachedProcessSupervisor(daemon);
      // Scan for every credential the daemon could hold: the machine
      // credential plus the COMPLETE provider secret set its own startup
      // bootstrap converges (explicit env + the user-level Claude settings).
      // The values are never logged here — the observer only reports whether
      // any needle was seen.
      const logs = new DaemonLogObserver(
        [TOKEN, ...collectSecretValues(resolveClaudeProviderEnv(process.env))],
        MAX_LOG_BYTES,
      );
      const control = new DaemonControlObserver((event) => {
        if (event.kind === "started") supervisor.trackProcessGroup(event.pgid);
        else supervisor.releaseProcessGroup(event.pgid);
      });
      daemons.push(supervisor);

      daemon.stdout?.on("data", (chunk: Buffer) => {
        logs.append("stdout", chunk);
        control.append(chunk);
      });
      daemon.stderr?.on("data", (chunk: Buffer) => {
        logs.append("stderr", chunk);
      });

      try {
        // 4. Require provenance from the daemon's actual production probe and
        // compare it with an explicit operator-approved hash.
        let provenance = control.approvedProvenance(expectedClaudeSha256);
        await waitFor(
          async () => {
            provenance = control.approvedProvenance(expectedClaudeSha256);
            return provenance !== null;
          },
          REGISTER_TIMEOUT_MS,
          50,
        );
        if (provenance === null) throw new Error("production daemon did not report Claude provenance");
        console.log(`[e2e] Claude resolved path: ${provenance.resolvedPath}`);
        console.log(`[e2e] Claude version: ${provenance.version}`);
        console.log(`[e2e] Claude sha256: ${provenance.sha256}`);

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

        const leases = await booted.handle.db.select().from(runLeases);
        expect(leases).toHaveLength(0);

        const loopsRes = await fetch(`${baseUrl}/api/loops`);
        const loopBody = (await loopsRes.json()) as { loops: Array<{ id: string; lastRun: any }> };
        const updatedLoop = loopBody.loops.find((l) => l.id === loop.id);
        expect(updatedLoop?.lastRun).toMatchObject({ id: runId, phase: "done", outcome: "exec" });

        // 10. Assertions: proof file content (trim trailing whitespace/newline)
        const proofContent = await readFile(proofFile, "utf-8");
        expect(proofContent.trim()).toBe(SUCCESS_MARKER);

        // 11. Daemon and every observed descendant process group close;
        // ChildProcess close also proves stdout/stderr have drained.
        const closed = await supervisor.terminate({ graceMs: 5000, killWaitMs: 2000 });
        expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
        control.assertHealthy();
        const daemonIndex = daemons.indexOf(supervisor);
        if (daemonIndex !== -1) daemons.splice(daemonIndex, 1);

        // 12. Sticky streaming scan covers the complete lifecycle, including
        // shutdown output received before close.
        expect(logs.secretSeen).toBe(false);
      } catch (err) {
        const tail = logs.secretSeen ? "[suppressed because a credential was detected]" : logs.diagnosticTail();
        console.error(`[e2e] bounded redacted daemon log tail (max ${MAX_LOG_BYTES} bytes):\n${tail}`);
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
