/**
 * Phase 4 Batch 2: REAL Claude full-chain E2E acceptance test (opt-in).
 *
 * Validates the COMPLETE terminal-protocol v1 chain with a real Claude Code
 * runner against the production daemon:
 *   production bootstrapServer → file-backed PGlite → real HTTP listener →
 *   built daemon CLI (child process) → real Claude Code (probe-pinned,
 *   operator-approved sha256) → loopzhb wrapper journal → Report → DB.
 *
 * The two-run state→finish flow (plan §4.2):
 *   Run 1 reads the Task File and prev-state.json (`null`), then records
 *     progress with EXACTLY ONE `loopzhb report --status new --state …`.
 *     The state promotes to loop.state and the task-file content syncs.
 *   Run 2 reads prev-state.json (now carrying Run 1's state) and — with the
 *     Goal's evidence satisfied — ends with `loopzhb finish --reason …`.
 *     The Loop completes atomically: completion + schedule disable + lease
 *     consumption.
 *
 * Acceptance:
 *  - the production probe's Claude provenance matches the operator-approved
 *    LOOPZHB_EXPECTED_CLAUDE_SHA256 before any real Run is triggered;
 *  - Run 1 = done/exec with the state promoted; Run 2 = done/exec and the
 *    Loop is Completed (completionReason set, schedule disabled);
 *  - Completed guards: Run Now and schedule re-enable both meet the coded
 *    409 `loop_completed`;
 *  - RunLease consumed; a sticky streaming observer scans the daemon's
 *    complete stdout/stderr lifecycle for the machine credential and EVERY
 *    provider secret the daemon's startup bootstrap converges (explicit env
 *    plus the user-level Claude settings);
 *  - the daemon and every observed Claude process group close on SIGTERM
 *    (exit 0, SIGKILL fallback).
 *
 * Bounded waits: registration ≤30s, each real Run ≤10min, whole test ≤25min.
 * Cleanup order (finally): daemon → HTTP listener → DB → temp dirs.
 *
 * Enable with LOOPZHB_REAL_CLAUDE_E2E=1 and
 * LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved hash> (the
 * `pnpm test:phase4:batch2:e2e` script wires the first). Skipped by default:
 * it requires Claude auth, incurs model cost, and listens on 127.0.0.1.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { collectSecretValues, resolveClaudeProviderEnv } from "@loopzhb/daemon";
import {
  createLoopResponseSchema,
  LOOP_COMPLETED_CODE,
  runListResponseSchema,
  triggerRunResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { loops, runLeases } from "./db/schema.js";
import { DaemonControlObserver, DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";
import { bootstrapServer, waitForListening } from "./start.js";

const ENABLED = process.env.LOOPZHB_REAL_CLAUDE_E2E === "1";
const TOKEN = "dk_e2e_batch2_real_claude";
const GOAL = "Record the step-1 state, then on a later run finish the loop";
const CRON_FAR_FUTURE = "0 0 1 1 *";
const TASK_CONTENT = [
  "# Two-step loop task",
  "",
  "## Spec",
  "Step 1 — when prev-state.json is `null` (nothing recorded yet), record",
  "progress with exactly this command:",
  "",
  '    loopzhb report --status new --message "step 1 recorded the task file" --state \'{"step":1}\'',
  "",
  "Step 2 — when prev-state.json shows step 1 already recorded, complete",
  "the loop with exactly this command:",
  "",
  '    loopzhb finish --reason "both steps recorded"',
  "",
  "## Current understanding",
  "Step 1 has not been recorded yet.",
  "",
  "## Timeline",
  "(empty)",
  "",
].join("\n");

const REGISTER_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 25 * 60_000;
const MAX_LOG_BYTES = 64 * 1024;

const handles: DbHandle[] = [];
const servers: ServerType[] = [];
const daemons: DetachedProcessSupervisor[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
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
  await Promise.all(handles.splice(0).map((h) => closeDb(h).catch(() => {})));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, 20_000);

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe.skipIf(!ENABLED)("Phase 4 Batch 2 real Claude E2E (opt-in)", () => {
  it(
    "run 1 reports state from the Task File → run 2 reads prev-state.json and finishes → Completed with all guards",
    async () => {
      const expectedClaudeSha256 = process.env.LOOPZHB_EXPECTED_CLAUDE_SHA256;
      if (expectedClaudeSha256 === undefined || !/^[0-9a-f]{64}$/i.test(expectedClaudeSha256)) {
        throw new Error(
          "Batch 2 real Claude E2E requires LOOPZHB_EXPECTED_CLAUDE_SHA256 as an explicit 64-hex binary approval",
        );
      }

      // 1. Allowed root with the workdir + Task File.
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-b2real-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      await mkdir(workdir, { recursive: true });
      await writeFile(path.join(workdir, "TASK.md"), TASK_CONTENT, "utf-8");

      // 2. Production server: file PGlite + real HTTP listener.
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b2real-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir });
      handles.push(booted.handle);
      const server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
      servers.push(server);
      await waitForListening(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to get server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 3. The production daemon CLI against the REAL claude binary; the
      //    daemon's own probe reports the provenance this test approves.
      const claudeBin = process.env.LOOPZHB_CLAUDE_BIN?.trim() || "claude";
      // Scan for every credential the daemon could hold: the machine
      // credential plus the COMPLETE provider secret set its own startup
      // bootstrap converges (explicit env + the user-level Claude settings).
      // The values are never logged here — the observer only reports whether
      // any needle was seen.
      const secrets = [TOKEN, ...collectSecretValues(resolveClaudeProviderEnv(process.env))];
      const daemon = spawn(process.execPath, [path.join(__dirname, "../../daemon/dist/cli.js")], {
        env: {
          ...process.env,
          LOOPZHB_SERVER_URL: baseUrl,
          LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
          LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
          LOOPZHB_CLAUDE_BIN: claudeBin,
          LOOPZHB_REAL_CLAUDE_E2E: "1",
          NODE_ENV: "production",
        },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const supervisor = new DetachedProcessSupervisor(daemon);
      const logs = new DaemonLogObserver(secrets, MAX_LOG_BYTES);
      const control = new DaemonControlObserver((event) => {
        if (event.kind === "started") supervisor.trackProcessGroup(event.pgid);
        else supervisor.releaseProcessGroup(event.pgid);
      });
      daemons.push(supervisor);
      daemon.stdout?.on("data", (chunk: Buffer) => {
        logs.append("stdout", chunk);
        control.append(chunk);
      });
      daemon.stderr?.on("data", (chunk: Buffer) => logs.append("stderr", chunk));

      try {
        // 4. Operator-approved provenance gate (plan §4.2).
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
        console.log(`[b2-real] Claude resolved path: ${provenance.resolvedPath}`);
        console.log(`[b2-real] Claude version: ${provenance.version}`);
        console.log(`[b2-real] Claude sha256: ${provenance.sha256}`);

        // 5. Machine registration.
        const machineId = machineIdFromToken(TOKEN);
        await waitFor(async () => {
          const res = await fetch(`${baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        }, REGISTER_TIMEOUT_MS);

        // 6. The Closed Loop (goal + far-future cron to prove the finish
        //    disables an ENABLED schedule).
        const createRes = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            machineId,
            name: "b2-real-claude",
            workdir,
            taskFile: path.join(workdir, "TASK.md"),
            goal: GOAL,
            cron: CRON_FAR_FUTURE,
          }),
        });
        expect(createRes.status).toBe(201);
        const { loop } = createLoopResponseSchema.parse(await createRes.json());

        const waitRunTerminal = async (runId: string) => {
          await waitFor(async () => {
            const res = await fetch(`${baseUrl}/api/loops/${loop.id}/runs`);
            if (!res.ok) return false;
            const body = runListResponseSchema.parse(await res.json());
            const run = body.runs.find((r) => r.id === runId);
            return run !== undefined && (run.phase === "done" || run.phase === "error");
          }, AGENT_TIMEOUT_MS);
          const res = await fetch(`${baseUrl}/api/loops/${loop.id}/runs`);
          const run = runListResponseSchema.parse(await res.json()).runs.find((r) => r.id === runId);
          if (run === undefined) throw new Error(`run ${runId} missing`);
          return run;
        };

        // ---- RUN 1: report the step-1 state ----
        const trigger1 = triggerRunResponseSchema.parse(
          await (await fetch(`${baseUrl}/api/loops/${loop.id}/run`, { method: "POST" })).json(),
        );
        if (!trigger1.enqueued) throw new Error("expected run 1 to enqueue");
        const run1 = await waitRunTerminal(trigger1.runId);
        expect(run1).toMatchObject({ phase: "done", outcome: "exec", status: "new", error: null });
        expect(run1.message).toContain("step 1 recorded");

        const rows1 = await booted.handle.db.select().from(loops).where(eq(loops.id, loop.id));
        expect(rows1[0]).toMatchObject({
          state: { step: 1 },
          taskFileContent: TASK_CONTENT,
          taskFileSyncError: null,
          completedAt: null,
        });

        // ---- RUN 2: observe prev-state and finish ----
        const trigger2 = triggerRunResponseSchema.parse(
          await (await fetch(`${baseUrl}/api/loops/${loop.id}/run`, { method: "POST" })).json(),
        );
        if (!trigger2.enqueued) throw new Error("expected run 2 to enqueue");
        const run2 = await waitRunTerminal(trigger2.runId);
        expect(run2).toMatchObject({ phase: "done", outcome: "exec", status: "resolved", error: null });
        expect(run2.message).toContain("recorded");

        // Completed atomically: completion + schedule disable + state kept.
        const rows2 = await booted.handle.db.select().from(loops).where(eq(loops.id, loop.id));
        expect(rows2[0]!.completedAt).not.toBeNull();
        expect(rows2[0]!.completionReason).toContain("recorded");
        expect(rows2[0]!.enabled).toBe(false);
        expect(rows2[0]!.state).toEqual({ step: 1 });
        expect(await booted.handle.db.select().from(runLeases)).toHaveLength(0);

        // Completed guards: Run Now and schedule re-enable are both the
        // coded 409 — the far-future cron stays disarmed until a Reopen.
        const runNow = await fetch(`${baseUrl}/api/loops/${loop.id}/run`, { method: "POST" });
        expect(runNow.status).toBe(409);
        expect(((await runNow.json()) as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);
        const enableSchedule = await fetch(`${baseUrl}/api/loops/${loop.id}/schedule`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        expect(enableSchedule.status).toBe(409);
        expect(((await enableSchedule.json()) as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);

        // 7. Graceful shutdown with every Claude process group closed.
        const closed = await supervisor.terminate({ graceMs: 5000, killWaitMs: 2000 });
        expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
        control.assertHealthy();
        const daemonIndex = daemons.indexOf(supervisor);
        if (daemonIndex !== -1) daemons.splice(daemonIndex, 1);

        // 8. The daemon's complete stdout/stderr lifecycle is credential-free.
        expect(logs.secretSeen).toBe(false);
      } catch (err) {
        const tail = logs.secretSeen ? "[suppressed because a credential was detected]" : logs.diagnosticTail();
        console.error(`[b2-real] bounded redacted daemon log tail (max ${MAX_LOG_BYTES} bytes):\n${tail}`);
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
