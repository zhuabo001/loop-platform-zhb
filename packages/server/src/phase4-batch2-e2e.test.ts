/**
 * Phase 4 Batch 2 deterministic cross-package E2E (plan §4.2): the FULL
 * production chain with a CONTROLLED Claude — no test-fixture seeding, no
 * in-process shortcuts:
 *
 *   file-backed PGlite (bootstrapServer) → real 127.0.0.1 HTTP listener →
 *   BUILT daemon CLI (child process) → production Claude runner → the
 *   fake-claude fixture as LOOPZHB_CLAUDE_BIN → real OS-level spawn, jail,
 *   control root, journal outbox and wrapper PATH.
 *
 * The two-run state→finish flow (ADR-009; plan §2.1–2.5):
 *
 *   Run 1 (`report-with-state`): journal report/resolved + {"cursor":2}
 *     state → done/exec, state promoted to loop.state, task-file content
 *     synced.
 *   Run 2 (`finish-observe-prev-state`): the fixture reads the run's
 *     prev-state.json (written from the Delivery's prevState) and embeds the
 *     observed bytes in its finish reason → the Loop completes, the schedule
 *     disables, and Run Now / schedule-enable / goal PATCH all meet the
 *     coded 409.
 *
 * Security audit (plan §4.1 安全, E2E level): the per-start control root is
 * 0700 with a 0500 wrapper; the agent sidecar proves NO machine/run
 * credential enters the agent env or prompt; a sticky streaming observer
 * scans the daemon's whole stdout/stderr lifecycle for the machine
 * credential and a planted provider key; every wire body the test observes
 * is scanned for both.
 *
 * Bounded waits: registration ≤30s, each run ≤60s, whole test ≤180s.
 * Cleanup order (finally): daemon → HTTP listener → DB → temp dirs.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLoopResponseSchema,
  LOOP_COMPLETED_CODE,
  loopListResponseSchema,
  runListResponseSchema,
  triggerRunResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { loops, runLeases } from "./db/schema.js";
import { DaemonControlObserver, DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";
import { bootstrapServer, waitForListening } from "./start.js";

const TOKEN = "dk_e2e_batch2_machine";
/** Planted provider secret: the agent env legitimately carries it, so it must
 *  appear in the sidecar — but NEVER in daemon logs, the prompt, or any wire
 *  body (ADR-009 修订 8's two-layer redaction). */
const FAKE_PROVIDER_KEY = "sk-ant-e2e-batch2-planted-secret";
const GOAL = "Report the first cursor state, then finish the loop";
const CRON_FAR_FUTURE = "0 0 1 1 *"; // Jan 1 00:00 — never fires during the test
const TASK_CONTENT = [
  "# Batch 2 E2E Task",
  "",
  "## Spec",
  "Record the cursor, then complete the loop.",
  "",
  "## Current understanding",
  "Nothing recorded yet.",
  "",
  "## Timeline",
  "(empty)",
  "",
].join("\n");

const REGISTER_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;
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

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

function modeOf(p: string): Promise<number> {
  return stat(p).then((s) => s.mode & 0o777);
}

describe("Phase 4 Batch 2 deterministic E2E: production daemon + fake Claude, two runs state→finish", () => {
  it(
    "run 1 reports state + syncs the task file → run 2 observes prev-state.json and finishes → Completed guards + no secret anywhere",
    async () => {
      // 1. The operator's allowed root with the workdir and task file.
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-b2e2e-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      await mkdir(workdir, { recursive: true });
      const taskFile = path.join(workdir, "TASK.md");
      await writeFile(taskFile, TASK_CONTENT, "utf-8");
      const canonicalWorkdir = await realpath(workdir);

      // 2. Production server: file PGlite + real HTTP listener.
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b2e2e-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir });
      handles.push(booted.handle);
      const server = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
      servers.push(server);
      await waitForListening(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to get server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Every wire body the test observes — scanned for secrets at the end.
      const wireBodies: string[] = [];
      const api = async (
        route: string,
        init?: RequestInit,
      ): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`${baseUrl}${route}`, init);
        const text = await res.text();
        wireBodies.push(text);
        return { status: res.status, body: JSON.parse(text) };
      };

      // 3. The production daemon CLI with the fake Claude binary. The
      //    per-start control root is discovered by glob diff (the daemon
      //    mints it inside the inherited TMPDIR before the first poll).
      //    CLAUDE_CONFIG_DIR is pinned to an EMPTY temp fixture: a
      //    deterministic test must never read the developer's real
      //    ~/.claude/settings.json through the daemon's provider bootstrap
      //    (plan `codex-fix-claude-runner-plan` §5.5).
      const controlRootsBefore = new Set(
        readdirSync(tmpdir()).filter((n) => n.startsWith("loopzhb-control-")),
      );
      const scratchRootsBefore = new Set(
        readdirSync(tmpdir()).filter((n) => n.startsWith("loopzhb-runs-")),
      );
      const fakeClaudeConfigDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b2e2e-claude-config-${process.pid}-`));
      tempDirs.push(fakeClaudeConfigDir);
      const fakeClaude = path.join(__dirname, "../../daemon/test-fixtures/fake-claude.mjs");
      const daemon = spawn(process.execPath, [path.join(__dirname, "../../daemon/dist/cli.js")], {
        env: {
          ...process.env,
          LOOPZHB_SERVER_URL: baseUrl,
          LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
          LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
          LOOPZHB_CLAUDE_BIN: fakeClaude,
          LOOPZHB_POLL_MS: "500",
          LOOPZHB_REAL_CLAUDE_E2E: "1",
          ANTHROPIC_API_KEY: FAKE_PROVIDER_KEY,
          CLAUDE_CONFIG_DIR: fakeClaudeConfigDir,
          NODE_ENV: "production",
        },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const supervisor = new DetachedProcessSupervisor(daemon);
      const logs = new DaemonLogObserver([TOKEN, FAKE_PROVIDER_KEY], MAX_LOG_BYTES);
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
        // 4. Machine registration (the daemon self-registers on first poll).
        const machineId = machineIdFromToken(TOKEN);
        await waitFor(async () => {
          const res = await fetch(`${baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        }, REGISTER_TIMEOUT_MS);

        // 5. Control-root audit: exactly one NEW root, 0700, with the static
        //    0500 wrapper and its 0400 ESM marker — and none of the daemon's
        //    secrets inside any file (ADR-009 修订 8).
        const newRoots = readdirSync(tmpdir())
          .filter((n) => n.startsWith("loopzhb-control-") && !controlRootsBefore.has(n))
          .map((n) => path.join(tmpdir(), n));
        expect(newRoots).toHaveLength(1);
        // The daemon realpaths the mkdtemp base (macOS /var → /private/var):
        // compare paths in canonical form.
        const controlRoot = await realpath(newRoots[0]!);
        expect(await modeOf(controlRoot)).toBe(0o700);
        const wrapper = path.join(controlRoot, "bin", "loopzhb");
        expect(await modeOf(path.join(controlRoot, "bin"))).toBe(0o700);
        expect(await modeOf(wrapper)).toBe(0o500);
        expect(await modeOf(path.join(controlRoot, "bin", "package.json"))).toBe(0o400);
        const wrapperSource = await readFile(wrapper, "utf-8");
        expect(wrapperSource).not.toContain(TOKEN);
        expect(wrapperSource).not.toContain(FAKE_PROVIDER_KEY);
        expect(wrapperSource).not.toContain(baseUrl);
        const newScratchRoots = readdirSync(tmpdir())
          .filter((n) => n.startsWith("loopzhb-runs-") && !scratchRootsBefore.has(n))
          .map((n) => path.join(tmpdir(), n));
        expect(newScratchRoots).toHaveLength(1);
        const scratchRoot = await realpath(newScratchRoots[0]!);
        expect(await modeOf(scratchRoot)).toBe(0o700);

        // 6. Create the Closed Loop (goal + far-future cron) over HTTP.
        const createRes = await api("/api/loops", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ machineId, name: "b2-e2e-loop", workdir, taskFile, goal: GOAL, cron: CRON_FAR_FUTURE }),
        });
        expect(createRes.status).toBe(201);
        const { loop } = createLoopResponseSchema.parse(createRes.body);
        expect(loop).toMatchObject({ machineId, goal: GOAL, cron: CRON_FAR_FUTURE, enabled: true, completedAt: null });

        // ---- RUN 1: report-with-state ----
        await writeFile(path.join(workdir, ".fake-claude-v1-scenario"), "report-with-state", "utf-8");
        const trigger1 = await api(`/api/loops/${loop.id}/run`, { method: "POST" });
        expect(trigger1.status).toBe(202);
        const t1 = triggerRunResponseSchema.parse(trigger1.body);
        if (!t1.enqueued) throw new Error("expected run 1 to enqueue");

        await waitFor(async () => {
          const res = await api(`/api/loops/${loop.id}/runs`);
          const runs = runListResponseSchema.parse(res.body).runs;
          const run = runs.find((r) => r.id === t1.runId);
          return run !== undefined && (run.phase === "done" || run.phase === "error");
        }, RUN_TIMEOUT_MS);

        const runs1 = runListResponseSchema.parse((await api(`/api/loops/${loop.id}/runs`)).body).runs;
        expect(runs1).toHaveLength(1);
        expect(runs1[0]).toMatchObject({
          id: t1.runId,
          phase: "done",
          outcome: "exec",
          status: "resolved",
          message: "done",
          error: null,
        });

        // State promoted + task file synced (DB-authoritative: the summary
        // projection deliberately excludes state/content).
        const loopRows1 = await booted.handle.db.select().from(loops).where(eq(loops.id, loop.id));
        expect(loopRows1[0]).toMatchObject({
          state: { cursor: 2 },
          taskFileContent: TASK_CONTENT,
          taskFileSyncError: null,
          completedAt: null,
        });
        expect(loopRows1[0]!.taskFileSyncedAt).not.toBeNull();
        expect(loopRows1[0]!.taskFileSyncAttemptedAt).not.toBeNull();

        // The agent-side audit: the sidecar the fixture wrote into the
        // workdir proves the v1 prompt carries the goal + canonical task
        // path (never the content, never a credential), and the journal env
        // is exactly the wrapper PATH prefix + the outbox location.
        const sidecar = JSON.parse(await readFile(path.join(workdir, ".fake-claude-session.json"), "utf-8")) as {
          argv: string[];
          prompt: string;
          env: Record<string, string | null>;
        };
        expect(sidecar.prompt).toContain(JSON.stringify(path.join(canonicalWorkdir, "TASK.md")));
        expect(sidecar.prompt).toContain(JSON.stringify(GOAL));
        expect(sidecar.prompt).not.toContain(TASK_CONTENT);
        expect(sidecar.prompt).not.toContain(TOKEN);
        expect(sidecar.prompt).not.toContain(FAKE_PROVIDER_KEY);
        expect(sidecar.prompt).not.toContain(baseUrl);
        expect(sidecar.env.LOOPZHB_MACHINE_CREDENTIAL).toBeNull();
        expect(sidecar.env.GITHUB_TOKEN).toBeNull();
        expect(sidecar.env.ANTHROPIC_API_KEY).toBe(FAKE_PROVIDER_KEY);
        expect(sidecar.env.LOOPZHB_JOURNAL_OUTBOX).toMatch(/^\/.*outbox$/);
        expect(sidecar.env.LOOPZHB_JOURNAL_OUTBOX!.startsWith(`${controlRoot}/`)).toBe(true);
        expect(sidecar.env.PATH!.startsWith(`${path.join(controlRoot, "bin")}:`)).toBe(true);

        // ---- RUN 2: finish-observe-prev-state ----
        await writeFile(path.join(workdir, ".fake-claude-v1-scenario"), "finish-observe-prev-state", "utf-8");
        const trigger2 = await api(`/api/loops/${loop.id}/run`, { method: "POST" });
        expect(trigger2.status).toBe(202);
        const t2 = triggerRunResponseSchema.parse(trigger2.body);
        if (!t2.enqueued) throw new Error("expected run 2 to enqueue");

        await waitFor(async () => {
          const res = await api(`/api/loops/${loop.id}/runs`);
          const runs = runListResponseSchema.parse(res.body).runs;
          const run = runs.find((r) => r.id === t2.runId);
          return run !== undefined && (run.phase === "done" || run.phase === "error");
        }, RUN_TIMEOUT_MS);

        const runs2 = runListResponseSchema.parse((await api(`/api/loops/${loop.id}/runs`)).body).runs;
        expect(runs2).toHaveLength(2);
        const run2 = runs2.find((r) => r.id === t2.runId)!;
        // The cross-run state pin: run 2's prev-state.json carried EXACTLY
        // run 1's promoted state (compact JSON), observed by the agent and
        // echoed in the finish reason — black-box proof of the promotion.
        expect(run2).toMatchObject({ phase: "done", outcome: "exec", status: "resolved", error: null });
        expect(run2.message).toBe('goal met; observed prev-state {"cursor":2}');

        // Completed: the finish committed completion + schedule disable +
        // lease consumption atomically; run 1's state survives (the finish
        // carried no state of its own).
        const loopRows2 = await booted.handle.db.select().from(loops).where(eq(loops.id, loop.id));
        expect(loopRows2[0]).toMatchObject({
          completedAt: loopRows2[0]!.completedAt,
          completionReason: 'goal met; observed prev-state {"cursor":2}',
          enabled: false,
          state: { cursor: 2 },
        });
        expect(loopRows2[0]!.completedAt).not.toBeNull();
        expect(await booted.handle.db.select().from(runLeases)).toHaveLength(0);

        const loopList = loopListResponseSchema.parse((await api("/api/loops")).body).loops;
        expect(loopList.find((l) => l.id === loop.id)).toMatchObject({
          enabled: false,
          cron: CRON_FAR_FUTURE,
          completionReason: 'goal met; observed prev-state {"cursor":2}',
        });

        // Completed guards: Run Now / schedule re-enable / goal PATCH all
        // meet the coded 409 — only Reopen could restore operation.
        const runNow = await api(`/api/loops/${loop.id}/run`, { method: "POST" });
        expect(runNow.status).toBe(409);
        expect((runNow.body as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);
        const enableSchedule = await api(`/api/loops/${loop.id}/schedule`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        expect(enableSchedule.status).toBe(409);
        expect((enableSchedule.body as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);
        const goalPatch = await api(`/api/loops/${loop.id}/goal`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "too late" }),
        });
        expect(goalPatch.status).toBe(409);
        expect((goalPatch.body as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);

        // 7. Graceful shutdown: SIGTERM → exit 0; every observed Claude
        //    process group closed (the supervisor's terminate waits for all).
        const closed = await supervisor.terminate({ graceMs: 5000, killWaitMs: 2000 });
        expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
        control.assertHealthy();
        const daemonIndex = daemons.indexOf(supervisor);
        if (daemonIndex !== -1) daemons.splice(daemonIndex, 1);

        // 7b. Per-start resource lifecycle (review STD-4/R2): both owned
        //     roots leave WITH the daemon.
        await expect(stat(controlRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(scratchRoot)).rejects.toMatchObject({ code: "ENOENT" });

        // 8. Secret audit: the daemon's complete stdout/stderr lifecycle and
        //    EVERY observed wire body are clean of the machine credential and
        //    the planted provider key.
        expect(logs.secretSeen).toBe(false);
        for (const body of wireBodies) {
          expect(body).not.toContain(TOKEN);
          expect(body).not.toContain(FAKE_PROVIDER_KEY);
        }
      } catch (err) {
        const tail = logs.secretSeen ? "[suppressed because a credential was detected]" : logs.diagnosticTail();
        console.error(`[b2-e2e] bounded redacted daemon log tail (max ${MAX_LOG_BYTES} bytes):\n${tail}`);
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
