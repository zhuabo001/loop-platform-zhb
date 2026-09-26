/**
 * Phase 4 Batch 3 slice 5: REAL Claude full-chain acceptance test (opt-in).
 *
 * The Dashboard's own chain, with a real model on the other end:
 *   production bootstrapServer → file-backed PGlite → real HTTP listener →
 *   production Scheduler → built daemon CLI (child process) → REAL Claude Code
 *   (production probe, operator-approved sha256) → real OS sandbox →
 *   loopzhb wrapper journal → Report → DB → rendered page.
 *
 * Both Runs are triggered the way the operator triggers them — by submitting
 * the page's own Run Now form (`POST /dashboard/loops/:id/run` with the token
 * scraped from `GET /`) — never by the JSON API.
 *
 * Acceptance (slice-5 plan §2.2, batch plan §4 切片五):
 *  - the production probe's Claude provenance matches the operator-approved
 *    LOOPZHB_EXPECTED_CLAUDE_SHA256 BEFORE any real Run is triggered;
 *  - Run 1 reads the Task File, records state and rewrites the Timeline: the
 *    step-1 marker moves out of the file and into `loops.state`, and the
 *    file's new bytes are on disk AND in the loop's sync snapshot;
 *  - Run 2 reads `prev-state.json` plus the updated Timeline and finishes with
 *    BOTH test markers in its reason; the Loop completes atomically (state
 *    kept, schedule disabled, lease consumed);
 *  - the rendered page then shows Completed with the button disabled, while
 *    the JSON API's Run Now answers the coded 409;
 *  - two consecutive restarts over the same data directory add no Run: an
 *    unfinished control loop on the same cron DOES catch up, so the Completed
 *    Loop's "0 new Runs" is measured rather than assumed;
 *  - SIGTERM closes the daemon (exit 0) and every observed Claude process
 *    group; the control root and the scratch root are reclaimed; the daemon's
 *    complete stdout/stderr lifecycle carries no machine or provider secret.
 *
 * The ONLY injected seam is the Clock/CronFactory pair, and only so the
 * restart can cross legal occurrences deterministically (plan §2.2) — the
 * scheduler stays the production implementation and the Claude runner is never
 * replaced. Nothing here retries a real Run: a failure is reported with its
 * stable classification, never re-attempted.
 *
 * Enable with LOOPZHB_REAL_CLAUDE_E2E=1 and
 * LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved 64-hex> (the `pnpm test:phase4:e2e`
 * script wires the first). Skipped by default: it requires Claude auth, incurs
 * model cost, and listens on 127.0.0.1. Credentials are never written into
 * argv, a prompt, a persistent log or the acceptance doc.
 *
 * Bounded waits (plan §2.2): registration ≤30s, each real Run ≤10min, whole
 * test ≤25min. Cleanup order: daemon → scheduler → listener → DB → temp dirs.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
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
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb } from "./db/index.js";
import { loops, runLeases, runs } from "./db/schema.js";
import { DaemonControlObserver, DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";
import { bootstrapServer, waitForListening, type BootedServer } from "./start.js";
import { FakeClock, FakeCronFactory } from "./testkit/index.js";
import { assertBatch3StateSource, buildBatch3AcceptanceTask } from "./phase4-batch3-acceptance-task.js";

const ENABLED = process.env.LOOPZHB_REAL_CLAUDE_E2E === "1";
const TOKEN = "dk_e2e_batch3_real_claude";
const GOAL = "Record the step-1 marker into state, then finish from the updated Timeline";
const CRON_EVERY_MINUTE = "* * * * *";
/** The restart phase jumps this far ahead: ~210 legal minutely occurrences. */
const DOWNTIME_MS = 3.5 * 60 * 60 * 1000;

const REGISTER_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 25 * 60_000;
const MAX_LOG_BYTES = 64 * 1024;
const FORM = "application/x-www-form-urlencoded";

const daemons: DetachedProcessSupervisor[] = [];
const servers: ServerType[] = [];
const bootedServers: BootedServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.terminate({ graceMs: 5000, killWaitMs: 2000 });
  }
  const booted = bootedServers.splice(0);
  for (const lifetime of booted) {
    await lifetime.scheduler.stopAndDrain().catch(() => {});
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(booted.map((lifetime) => closeDb(lifetime.handle).catch(() => {})));
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

/** `waitFor` for a check that PRODUCES the value under test — `null` keeps
 *  waiting, so settling the Run and identifying it stay one read. */
async function waitForValue<T>(
  check: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs: number = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

/** The Run Now action AND its token, scraped from the page a browser loaded. */
function runFormFrom(html: string): { action: string; token: string } {
  const action = /<form class="run-form" method="post" action="([^"]+)">/.exec(html)?.[1];
  const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (action === undefined || token === undefined) throw new Error("no Run Now form in the rendered page");
  return { action, token };
}

describe.skipIf(!ENABLED)("Phase 4 Batch 3 real Claude E2E (opt-in)", () => {
  it(
    "two page-triggered real Runs: state promotion + Task File rewrite, finish with both markers, Completed page and guards, then two restarts add nothing",
    async () => {
      const expectedClaudeSha256 = process.env.LOOPZHB_EXPECTED_CLAUDE_SHA256;
      if (expectedClaudeSha256 === undefined || !/^[0-9a-f]{64}$/i.test(expectedClaudeSha256)) {
        throw new Error(
          "Batch 3 real Claude E2E requires LOOPZHB_EXPECTED_CLAUDE_SHA256 as an explicit 64-hex binary approval",
        );
      }

      const approvedBudget = Number(process.env.LOOPZHB_PHASE4_ACCEPTANCE_BUDGET_USD);
      if (!Number.isFinite(approvedBudget) || approvedBudget <= 0) {
        throw new Error("Batch 3 real gate requires an explicit positive LOOPZHB_PHASE4_ACCEPTANCE_BUDGET_USD");
      }
      // Reserve one third for per-request threshold overshoot. Two Runs only.
      const perRunBudget = approvedBudget / 3;

      // Two markers minted at test time: the model cannot have seen them in
      // any prompt or fixture — it can only report them by READING the files.
      const markerA = `mk-a-${randomBytes(8).toString("hex")}`;
      const markerB = `mk-b-${randomBytes(8).toString("hex")}`;
      const taskContent = buildBatch3AcceptanceTask(markerA, markerB);

      // 1. Allowed root with the workdir + Task File.
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-b3real-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      await mkdir(workdir, { recursive: true });
      const taskFile = path.join(workdir, "TASK.md");
      await writeFile(taskFile, taskContent, "utf-8");

      // 2. Production server: file PGlite + real listener + the PRODUCTION
      //    Scheduler. The injected Clock/CronFactory exist ONLY so the restart
      //    below crosses legal occurrences deterministically.
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b3real-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const clock = new FakeClock(new Date());
      const bootOne = async (): Promise<{ booted: BootedServer; url: string }> => {
        const booted = await bootstrapServer(
          { host: "127.0.0.1", port: 0, dataDir },
          { clock, cronFactory: new FakeCronFactory() },
        );
        bootedServers.push(booted);
        const listener = serve({ fetch: booted.app.fetch, port: 0, hostname: "127.0.0.1" });
        servers.push(listener);
        await waitForListening(listener);
        const bound = listener.address();
        if (!bound || typeof bound === "string") throw new Error("failed to get server address");
        // start.ts main()'s fixed order: listener bound BEFORE the scheduler's
        // startup scan, so nothing schedules behind an unbound port.
        await booted.scheduler.start();
        return { booted, url: `http://127.0.0.1:${bound.port}` };
      };
      const bootClose = async (lifetime: { booted: BootedServer; url: string }): Promise<void> => {
        await lifetime.booted.scheduler.stopAndDrain();
        const index = bootedServers.indexOf(lifetime.booted);
        if (index !== -1) bootedServers.splice(index, 1);
        const port = Number(new URL(lifetime.url).port);
        await Promise.all(
          servers
            .filter((listener) => {
              const bound = listener.address();
              return typeof bound === "object" && bound !== null && bound.port === port;
            })
            .map((listener) => {
              servers.splice(servers.indexOf(listener), 1);
              return new Promise<void>((resolve) => listener.close(() => resolve()));
            }),
        );
        await closeDb(lifetime.booted.handle);
      };

      const first = await bootOne();
      let baseUrl = first.url;

      // 3. The production daemon CLI against the REAL claude binary. Every
      //    credential the daemon could converge is watched for in its logs —
      //    the values are never printed, only the verdict.
      const claudeBin = process.env.LOOPZHB_CLAUDE_BIN?.trim() || "claude";
      const secrets = [TOKEN, ...collectSecretValues(resolveClaudeProviderEnv(process.env))];
      const daemonTmp = await mkdtemp(path.join(tmpdir(), "loopzhb-b3real-daemon-tmp-"));
      tempDirs.push(daemonTmp);
      const controlRootsBefore = new Set(readdirSync(daemonTmp).filter((n) => n.startsWith("loopzhb-control-")));
      const scratchRootsBefore = new Set(readdirSync(daemonTmp).filter((n) => n.startsWith("loopzhb-runs-")));
      const daemon = spawn(process.execPath, [path.join(__dirname, "../../daemon/dist/cli.js")], {
        env: {
          ...process.env,
          TMPDIR: daemonTmp,
          LOOPZHB_SERVER_URL: baseUrl,
          LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
          LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
          LOOPZHB_CLAUDE_BIN: claudeBin,
          LOOPZHB_REAL_CLAUDE_E2E: "1",
          LOOPZHB_CLAUDE_MAX_BUDGET_USD: String(perRunBudget),
          LOOPZHB_AGENT_TIMEOUT_MS: String(AGENT_TIMEOUT_MS),
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

      const runsOf = async (url: string, loopId: string) => {
        const res = await fetch(`${url}/api/loops/${loopId}/runs`);
        expect(res.status).toBe(200);
        return runListResponseSchema.parse(await res.json()).runs;
      };

      try {
        // 4. THE provenance gate — before any real Run is triggered.
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
        console.log(`[b3-real] Claude resolved path: ${provenance.resolvedPath}`);
        console.log(`[b3-real] Claude version: ${provenance.version}`);
        console.log(`[b3-real] Claude sha256: ${provenance.sha256}`);

        // 5. Machine registration.
        const machineId = machineIdFromToken(TOKEN);
        await waitFor(async () => {
          const res = await fetch(`${baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        }, REGISTER_TIMEOUT_MS);

        // 6. The Closed Loop with an ENABLED schedule, so the finish has to
        //    disarm a live cron rather than a dormant one.
        const createRes = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            machineId,
            name: "b3-real-claude",
            workdir,
            taskFile,
            goal: GOAL,
            cron: CRON_EVERY_MINUTE,
          }),
        });
        expect(createRes.status).toBe(201);
        const { loop } = createLoopResponseSchema.parse(await createRes.json());
        const loopId = loop.id;

        // 7. The page the operator actually clicks: `GET /`, token scraped
        //    from the rendered form.
        const page = await fetch(`${baseUrl}/`);
        expect(page.status).toBe(200);
        const { action, token } = runFormFrom(await page.text());

        /** Submit the page's own form ONCE — the route answers a bare 303, so
         *  the new Run is settled and identified in one poll. A real Run that
         *  fails is a failed acceptance, never something to re-trigger. */
        const runViaDashboard = async (expectedCount: number): Promise<string> => {
          const before = new Set((await runsOf(baseUrl, loopId)).map((r) => r.id));
          const res = await fetch(`${baseUrl}${action}`, {
            method: "POST",
            headers: { "content-type": FORM },
            body: `csrf=${encodeURIComponent(token)}`,
            redirect: "manual",
          });
          expect(res.status).toBe(303);
          const runId = await waitForValue(async () => {
            const runs = await runsOf(baseUrl, loopId);
            if (runs.length !== expectedCount) return null;
            const created = runs.filter((r) => !before.has(r.id));
            if (created.length !== 1) return null;
            const run = created[0]!;
            return run.phase === "done" || run.phase === "error" ? run.id : null;
          }, AGENT_TIMEOUT_MS);
          const settled = (await runsOf(baseUrl, loopId)).find((r) => r.id === runId)!;
          if (settled.phase !== "done") {
            throw new Error(`real run ${runId} ended ${settled.phase}: ${settled.error ?? "no classification"}`);
          }
          return runId;
        };

        // ---- RUN 1 ----
        const run1Id = await runViaDashboard(1);
        const run1 = (await runsOf(baseUrl, loopId)).find((r) => r.id === run1Id)!;
        expect(run1).toMatchObject({ phase: "done", outcome: "exec", error: null });
        expect(run1.message).toContain("step 1 recorded");

        // State promoted + the Task File rewrite, on disk AND in the snapshot.
        const rows1 = (await first.booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        expect(rows1.state).toMatchObject({ step: 1, marker: markerA });
        expect(rows1.completedAt).toBeNull();
        const afterRun1 = await readFile(taskFile, "utf-8");
        expect(afterRun1).not.toBe(taskContent);
        expect(afterRun1).toContain(markerB);
        assertBatch3StateSource(afterRun1, markerA, markerB);
        // No copied marker in auxiliary files may become an alternate source.
        const filesAfterRun1 = await readdir(workdir, { recursive: true });
        for (const file of filesAfterRun1) {
          const absolute = path.join(workdir, file);
          if ((await stat(absolute)).isFile()) {
            expect(await readFile(absolute, "utf-8")).not.toContain(markerA);
          }
        }
        expect(rows1.taskFileContent).toBe(afterRun1);
        expect(rows1.taskFileSyncError).toBeNull();

        const firstCost = (await first.booted.handle.db.select().from(runs).where(eq(runs.id, run1Id)))[0]!.costUsd;
        expect(firstCost).not.toBeNull();
        expect(firstCost!).toBeLessThanOrEqual(approvedBudget - perRunBudget);
        console.log(`[b3-real] Run 1 cost USD: ${firstCost}`);

        // ---- RUN 2: the finish reports BOTH markers ----
        const run2Id = await runViaDashboard(2);
        const run2 = (await runsOf(baseUrl, loopId)).find((r) => r.id === run2Id)!;
        expect(run2).toMatchObject({ phase: "done", outcome: "exec", status: "resolved", error: null });
        // Marker A could only come from the promoted state, marker B only from
        // the rewritten Timeline: the reason is the cross-run proof.
        expect(run2.message).toBe(`goal met; state-marker=${markerA}; timeline-marker=${markerB}`);

        const secondCost = (await first.booted.handle.db.select().from(runs).where(eq(runs.id, run2Id)))[0]!.costUsd;
        expect(secondCost).not.toBeNull();
        expect(firstCost! + secondCost!).toBeLessThanOrEqual(approvedBudget);
        console.log(`[b3-real] Run 2 cost USD: ${secondCost}; total USD: ${firstCost! + secondCost!}`);

        // Completed atomically: completion + schedule disable + state kept.
        const rows2 = (await first.booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        expect(rows2.completedAt).not.toBeNull();
        expect(rows2.completionReason).toBe(`goal met; state-marker=${markerA}; timeline-marker=${markerB}`);
        expect(rows2.enabled).toBe(false);
        expect(rows2.state).toMatchObject({ step: 1, marker: markerA });
        expect(await first.booted.handle.db.select().from(runLeases)).toHaveLength(0);

        // The operator-visible end state: Completed page, disabled button, and
        // the coded 409 from the API.
        const completedPage = await (await fetch(`${baseUrl}/`)).text();
        expect(completedPage).toContain('data-lifecycle="completed"');
        expect(completedPage).toContain('<button type="submit" disabled>Run Now</button>');
        const runNow = await fetch(`${baseUrl}/api/loops/${loopId}/run`, { method: "POST" });
        expect(runNow.status).toBe(409);
        expect(((await runNow.json()) as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);

        // 8. Graceful daemon shutdown: exit 0 and every observed Claude
        //    process group closed.
        const ownedControlRoots = readdirSync(daemonTmp)
          .filter((n) => n.startsWith("loopzhb-control-") && !controlRootsBefore.has(n))
          .map((n) => path.join(daemonTmp, n));
        const ownedScratchRoots = readdirSync(daemonTmp)
          .filter((n) => n.startsWith("loopzhb-runs-") && !scratchRootsBefore.has(n))
          .map((n) => path.join(daemonTmp, n));
        expect(ownedControlRoots).toHaveLength(1);
        expect(ownedScratchRoots).toHaveLength(1);
        const closed = await supervisor.terminate({ graceMs: 5000, killWaitMs: 2000 });
        expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
        control.assertHealthy();
        const daemonIndex = daemons.indexOf(supervisor);
        if (daemonIndex !== -1) daemons.splice(daemonIndex, 1);

        // Per-start resources leave WITH the daemon: the control root (wrapper,
        // journal outboxes) and the per-run scratch root.
        for (const root of [...ownedControlRoots, ...ownedScratchRoots]) {
          await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }

        // ---- the restart half ----
        // An unfinished control loop on the SAME cron: it MUST catch up at the
        // restart, which keeps the Completed Loop's "0 new Runs" from being a
        // tautology.
        const controlRes = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ machineId, name: "b3-real-control", workdir, taskFile, cron: CRON_EVERY_MINUTE }),
        });
        expect(controlRes.status).toBe(201);
        const controlLoop = createLoopResponseSchema.parse(await controlRes.json()).loop;
        const completedBefore = (
          await first.booted.handle.db.select().from(loops).where(eq(loops.id, loopId))
        )[0]!;

        await bootClose(first);
        clock.advance(DOWNTIME_MS);

        // Restart #1.
        const second = await bootOne();
        baseUrl = second.url;
        const controlRuns = await runsOf(second.url, controlLoop.id);
        expect(controlRuns).toHaveLength(1);
        expect(controlRuns[0]).toMatchObject({ phase: "pending", role: "exec" });
        expect(await runsOf(second.url, loopId)).toHaveLength(2);
        const completedAfterRestart = (
          await second.booted.handle.db.select().from(loops).where(eq(loops.id, loopId))
        )[0]!;
        expect(completedAfterRestart.state).toMatchObject({ step: 1, marker: markerA });
        expect(completedAfterRestart.completedAt).toBe(completedBefore.completedAt);
        expect(completedAfterRestart.completionReason).toBe(completedBefore.completionReason);
        expect(completedAfterRestart).toEqual(completedBefore);
        expect(await (await fetch(`${second.url}/`)).text()).toContain('data-lifecycle="completed"');
        await bootClose(second);

        // Restart #2 at the SAME instant: the occurrence is already covered.
        const third = await bootOne();
        expect(await runsOf(third.url, loopId)).toHaveLength(2);
        expect(await runsOf(third.url, controlLoop.id)).toHaveLength(1);
        const completedAfterSecondRestart = (
          await third.booted.handle.db.select().from(loops).where(eq(loops.id, loopId))
        )[0]!;
        expect(completedAfterSecondRestart).toEqual(completedBefore);

        // 9. The daemon's complete stdout/stderr lifecycle is credential-free.
        expect(logs.secretSeen).toBe(false);
      } catch (err) {
        // Failure diagnostics — and deliberately NOT a retry. `journal_multiple`
        // is a content-free classification by design (ADR-009 修订 8/9), so the
        // observable context has to come from outside it: the agent's own
        // workdir (the one surface the acceptance mutates) and the Run rows.
        // Neither reads a transcript nor a credential.
        try {
          const tree = await readdir(workdir, { recursive: true }).catch(() => ["<unreadable>"]);
          console.error(`[b3-real] workdir listing: ${JSON.stringify(tree)}`);
          console.error(`[b3-real] TASK.md after the run:\n${await readFile(taskFile, "utf-8").catch(() => "<unreadable>")}`);
          // The agent's own breadcrumb (Branch B writes it): the ONE place the
          // model's read values and intended command become observable without
          // reading a session transcript.
          console.error(
            `[b3-real] RUN-NOTES.md:\n${await readFile(path.join(workdir, "RUN-NOTES.md"), "utf-8").catch(() => "<absent>")}`,
          );
        } catch {
          // Diagnostics must never mask the acceptance failure itself.
        }
        for (const lifetime of bootedServers) {
          try {
            const rows = await lifetime.handle.db.select().from(runs);
            console.error(
              `[b3-real] run rows: ${JSON.stringify(
                rows.map((row) => ({
                  id: row.id,
                  phase: row.phase,
                  outcome: row.outcome,
                  status: row.status,
                  error: row.error,
                  message: row.message,
                  sessionId: row.sessionId,
                })),
              )}`,
            );
          } catch {
            // A closed handle simply has nothing to report.
          }
        }
        const tail = logs.secretSeen ? "[suppressed because a credential was detected]" : logs.diagnosticTail();
        console.error(`[b3-real] bounded redacted daemon log tail (max ${MAX_LOG_BYTES} bytes):\n${tail}`);
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
