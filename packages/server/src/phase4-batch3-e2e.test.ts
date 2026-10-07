/**
 * Phase 4 Batch 3 slice 5, E1–E2 (batch plan §4 确定性测试「完整链路」):
 * the Dashboard's OWN chain — page → CSRF form → Run → Report → state
 * promotion → Task File sync → Finish → Completed page → guards — and then
 * the restart behaviour of a Completed Loop over the same data directory.
 *
 * The chain is the production one, end to end, with nothing stubbed but
 * Claude:
 *
 *   bootstrapServer (file-backed PGlite) → real 127.0.0.1 listener →
 *   PRODUCTION daemon CLI (child process) → production Claude runner →
 *   fake-claude fixture as LOOPZHB_CLAUDE_BIN → real OS-level spawn, jail,
 *   control root, journal outbox, wrapper PATH → Report → DB.
 *
 * Both Runs are triggered by SUBMITTING THE DASHBOARD'S OWN FORM
 * (`POST /dashboard/loops/:id/run` with the token scraped from the rendered
 * page), never by the JSON API: the CSRF path, the no-supersede policy and
 * the page's advisory button rule are all exercised as the browser would.
 *
 * Anti-vacuity (plan §2.1): the Task File carries TWO random markers minted at
 * test time.
 *
 *   Run 1 (`batch3-e2e-record`) moves marker A out of the Timeline and into
 *     the reported state, rewriting the file without that line.
 *   Run 2 (`batch3-e2e-finish`) READS marker A back out of the run's
 *     prev-state.json and marker B out of the rewritten Timeline, and finishes
 *     with both, plus whether marker A really left the file.
 *
 * So the Loop's `completionReason` is a measurement taken on disk at run time:
 * it cannot be satisfied by a page that merely echoes what the test planted,
 * and it fails loudly if state promotion or the Task File sync silently
 * stopped happening. The same string is then asserted on the rendered
 * Completed page.
 *
 * E2 restarts the SAME data directory twice (production shutdown order:
 * scheduler drain → listener → DB). The Completed Loop is the subject: it must
 * gain no Run, lose no state and keep its completion fields, even though its
 * cron would have fired ~210 times during the downtime. A second, UNFINISHED
 * control loop is there so that "0 new Runs" cannot pass by accident — it MUST
 * catch up, which is what proves the recovery pass actually ran.
 *
 * Bounded waits follow slice-5 plan §2.1 (registration ≤30s, each Run ≤10min,
 * whole test ≤25min). Cleanup is registered before any assertion can fail:
 * daemon → listener → DB → temp dirs.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLoopResponseSchema,
  LOOP_COMPLETED_CODE,
  runListResponseSchema,
} from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb } from "./db/index.js";
import { loops, runLeases, runs, type Loop } from "./db/schema.js";
import { AcceptedReportCostObserver, DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";
import { bootstrapServer, waitForListening, type BootedServer } from "./start.js";
import { FakeClock, FakeCronFactory, makeTestAuthConfig } from "./testkit/index.js";

const TOKEN = "dk_e2e_batch3_dashboard";
const GOAL = "Record the step-1 marker into state, then finish from the updated Timeline";
/** Minutely: during the E2 downtime this cron has ~210 legal occurrences, so a
 *  Completed Loop that still ran would be caught immediately. */
const CRON_EVERY_MINUTE = "* * * * *";
/** Every lifetime starts here; activation equals the creation instant. */
const T0 = new Date("2026-08-27T09:00:00.000Z");
/** 09:00 → 12:30, across the whole minutely grid. */
const DOWNTIME_MS = 3.5 * 60 * 60 * 1000;
const CATCHUP_OCCURRENCE = "2026-08-27T12:30:00.000Z";

const REGISTER_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 25 * 60_000;
const MAX_LOG_BYTES = 64 * 1024;
const FORM = "application/x-www-form-urlencoded";

const daemons: DetachedProcessSupervisor[] = [];
const lifetimes: Lifetime[] = [];
const tempDirs: string[] = [];

/** One server lifetime: the production boot order (DB → listener bind →
 *  scheduler start) and the production shutdown order (scheduler drain →
 *  listener close → DB close). The clock is SHARED across lifetimes — that is
 *  what makes "restart after downtime" observable — while each boot gets its
 *  own CronFactory, exactly like a fresh process would. */
interface Lifetime {
  booted: BootedServer;
  server: ServerType;
  cronFactory: FakeCronFactory;
  baseUrl: string;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.terminate({ graceMs: 5000, killWaitMs: 2000 });
  }
  for (const lifetime of lifetimes.splice(0)) {
    await closeLifetime(lifetime).catch(() => {});
  }
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

const reportCosts = new AcceptedReportCostObserver();

async function bootLifetime(dataDir: string, clock: FakeClock): Promise<Lifetime> {
  const cronFactory = new FakeCronFactory();
  const booted = await bootstrapServer({ auth: makeTestAuthConfig(), host: "127.0.0.1", port: 0, dataDir }, { clock, cronFactory });
  const server = serve({ fetch: (req: Request) => reportCosts.fetch(req, (r) => booted.app.fetch(r)), port: 0, hostname: "127.0.0.1" });
  const lifetime: Lifetime = { booted, server, cronFactory, baseUrl: "" };
  try {
    await waitForListening(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to get server address");
    lifetime.baseUrl = `http://127.0.0.1:${address.port}`;
    // start.ts main()'s fixed order: the listener is bound BEFORE the
    // scheduler's startup scan, so nothing schedules behind an unbound port.
    await booted.scheduler.start();
  } catch (err) {
    await closeLifetime(lifetime).catch(() => {});
    throw err;
  }
  lifetimes.push(lifetime);
  return lifetime;
}

async function closeLifetime(lifetime: Lifetime): Promise<void> {
  const index = lifetimes.indexOf(lifetime);
  if (index !== -1) lifetimes.splice(index, 1);
  try {
    await lifetime.booted.scheduler.stopAndDrain();
  } finally {
    try {
      await new Promise<void>((resolve) => lifetime.server.close(() => resolve()));
    } finally {
      await closeDb(lifetime.booted.handle);
    }
  }
}

/** The Run Now action AND its token, scraped from the page a browser would
 *  have loaded — the same round trip `routes.test.ts` pins. */
function runFormFrom(html: string): { action: string; token: string } {
  const action = /<form class="run-form" method="post" action="([^"]+)">/.exec(html)?.[1];
  const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (action === undefined || token === undefined) throw new Error("no Run Now form in the rendered page");
  return { action, token };
}

async function getPage(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
  return res.text();
}

async function runsOf(baseUrl: string, loopId: string) {
  const res = await fetch(`${baseUrl}/api/loops/${loopId}/runs`);
  expect(res.status).toBe(200);
  return runListResponseSchema.parse(await res.json()).runs;
}

async function loopRow(lifetime: Lifetime, loopId: string): Promise<Loop> {
  return (await lifetime.booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
}

async function createLoop(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/loops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return createLoopResponseSchema.parse(await res.json()).loop;
}

describe("Phase 4 Batch 3 deterministic E2E (E1–E2): Dashboard → state → finish → restart", () => {
  it(
    "both Runs triggered from the page: the markers prove state promotion + the Task File rewrite, the Completed Loop stays frozen across two restarts, and the control loop catches up",
    async () => {
      // Two markers minted at test time, so the chain below is measured rather
      // than echoed: nothing in the product knows these strings.
      const markerA = `mk-a-${randomBytes(8).toString("hex")}`;
      const markerB = `mk-b-${randomBytes(8).toString("hex")}`;
      const taskContent = [
        "# Batch 3 E2E Task",
        "",
        "## Spec",
        "Step 1: move the step-1 marker out of the Timeline and into state.",
        "Step 2: finish, reporting the state marker and the keep marker.",
        "",
        "## Timeline",
        "",
        `- step-1 marker: ${markerA}`,
        `- keep marker: ${markerB}`,
        "",
      ].join("\n");
      /** What the fixture's run-1 rewrite leaves behind — computed the same
       *  way, so an exact-equality assertion is meaningful. */
      const taskContentAfterRun1 = taskContent
        .split("\n")
        .filter((line) => !line.startsWith("- step-1 marker:"))
        .join("\n");
      const completionReason = `goal met; state-marker=${markerA}; timeline-marker=${markerB}; task-file-clean=yes`;

      // 1. The operator's allowed root with the workdir and Task File.
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-b3e2e-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      await mkdir(workdir, { recursive: true });
      const taskFile = path.join(workdir, "TASK.md");
      await writeFile(taskFile, taskContent, "utf-8");

      // 2. Lifetime #1 — the production composition root over a file-backed DB.
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b3e2e-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const clock = new FakeClock(T0);
      const first = await bootLifetime(dataDir, clock);

      // 3. The production daemon CLI with the fake Claude binary.
      //    CLAUDE_CONFIG_DIR is pinned to an EMPTY fixture: a deterministic
      //    test must never read the developer's real ~/.claude/settings.json
      //    through the daemon's provider bootstrap (plan §5.5). The daemon
      //    gets a PRIVATE TMPDIR (the slice4-secret-e2e precedent) so its
      //    control/scratch roots never pollute another e2e file's shared-
      //    tmpdir audit under vitest's 2 parallel workers.
      const fakeClaudeConfigDir = await mkdtemp(path.join(tmpdir(), `loopzhb-b3e2e-claude-config-${process.pid}-`));
      tempDirs.push(fakeClaudeConfigDir);
      const daemonTmp = await mkdtemp(path.join(tmpdir(), `loopzhb-b3e2e-daemon-tmp-${process.pid}-`));
      tempDirs.push(daemonTmp);
      const daemon = spawn(process.execPath, [path.join(__dirname, "../../daemon/dist/cli.js")], {
        env: {
          ...process.env,
          TMPDIR: daemonTmp,
          LOOPZHB_SERVER_URL: first.baseUrl,
          LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
          LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
          LOOPZHB_CLAUDE_BIN: path.join(__dirname, "../../daemon/test-fixtures/fake-claude.mjs"),
          LOOPZHB_POLL_MS: "500",
          LOOPZHB_REAL_CLAUDE_E2E: "1",
          CLAUDE_CONFIG_DIR: fakeClaudeConfigDir,
          NODE_ENV: "production",
        },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const supervisor = new DetachedProcessSupervisor(daemon);
      const logs = new DaemonLogObserver([TOKEN], MAX_LOG_BYTES);
      daemons.push(supervisor);
      daemon.stdout?.on("data", (chunk: Buffer) => logs.append("stdout", chunk));
      daemon.stderr?.on("data", (chunk: Buffer) => logs.append("stderr", chunk));

      try {
        // 4. Machine registration (the daemon self-registers on first poll).
        const machineId = machineIdFromToken(TOKEN);
        await waitFor(async () => {
          const res = await fetch(`${first.baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        }, REGISTER_TIMEOUT_MS);

        // 5. The Closed Loop (goal + minutely cron, far from firing under a
        //    frozen clock but with ~210 occurrences waiting in the downtime).
        const loop = await createLoop(first.baseUrl, {
          machineId,
          name: "b3-e2e-dashboard",
          workdir,
          taskFile,
          goal: GOAL,
          cron: CRON_EVERY_MINUTE,
        });
        const loopId = loop.id;

        // 6. The page BEFORE any Run: Closed, one form, button enabled.
        const pageBefore = await getPage(first.baseUrl);
        const { action, token } = runFormFrom(pageBefore);
        expect(pageBefore).toContain(`data-lifecycle="closed"`);
        expect(pageBefore).toContain('<button type="submit">Run Now</button>');
        // The stylesheet legitimately mentions `:disabled`, so the assertion
        // is on the BUTTON, not on the word.
        expect(pageBefore).not.toContain('<button type="submit" disabled>');
        expect(pageBefore).toContain("暂无活跃 Run。");

        /** Submit the page's own form and settle the new Run. The route
         *  answers a bare 303, so the Run is identified by DIFFING the loop's
         *  run ids around the POST. */
        const runViaDashboard = async (
          scenario: string,
          expectedCount: number,
        ): Promise<{ id: string; runs: unknown }> => {
          await writeFile(path.join(workdir, ".fake-claude-v1-scenario"), scenario, "utf-8");
          const before = new Set((await runsOf(first.baseUrl, loopId)).map((r) => r.id));
          const res = await fetch(`${first.baseUrl}${action}`, {
            method: "POST",
            headers: { "content-type": FORM },
            body: `csrf=${encodeURIComponent(token)}`,
            redirect: "manual",
          });
          expect(res.status).toBe(303);
          expect(res.headers.get("location")).toBe("/");
          await waitFor(async () => {
            const runs = await runsOf(first.baseUrl, loopId);
            if (runs.length !== expectedCount) return false;
            return runs.some((r) => !before.has(r.id) && (r.phase === "done" || r.phase === "error"));
          }, RUN_TIMEOUT_MS);
          const all = await runsOf(first.baseUrl, loopId);
          expect(all).toHaveLength(expectedCount);
          const created = all.filter((r) => !before.has(r.id));
          expect(created).toHaveLength(1);
          return { id: created[0]!.id, runs: created[0] };
        };

        // ---- E1 · RUN 1: the state marker leaves the Task File ----
        const run1 = await runViaDashboard("batch3-e2e-record", 1);
        const run1Rows = await first.booted.handle.db.select().from(runs).where(eq(runs.id, run1.id));
        expect(reportCosts.requireCost(run1.id)).toBe(0.125);
        expect(run1Rows[0]!.costUsd).toBeNull(); // cost remains parse-only in production
        expect(run1Rows[0]).toMatchObject({
          phase: "done",
          outcome: "exec",
          status: "new",
          message: "step 1 recorded the task file",
          error: null,
          // The run's OWN terminal state snapshot — the in-database half of
          // the promotion, visible on no summary projection.
          state: { step: 1, marker: markerA },
        });

        // The promotion and the sync, straight from the loop row.
        const loopAfterRun1 = await loopRow(first, loopId);
        expect(loopAfterRun1.state).toEqual({ step: 1, marker: markerA });
        expect(loopAfterRun1.taskFileContent).toBe(taskContentAfterRun1);
        expect(loopAfterRun1.taskFileSyncError).toBeNull();
        expect(loopAfterRun1.completedAt).toBeNull();
        // …and the agent really rewrote the file on disk.
        expect(await readFile(taskFile, "utf-8")).toBe(taskContentAfterRun1);

        // The page between the Runs: the finished Run is the latest exec Run
        // and the button is available again (nothing is pending or running).
        const pageAfterRun1 = await getPage(first.baseUrl);
        expect(pageAfterRun1).toContain('data-lifecycle="closed"');
        expect(pageAfterRun1).toContain('<button type="submit">Run Now</button>');
        expect(pageAfterRun1).toContain("step 1 recorded the task file");
        expect(pageAfterRun1).not.toContain("从未成功同步");

        // ---- E1 · RUN 2: the finish reports BOTH markers ----
        const run2 = await runViaDashboard("batch3-e2e-finish", 2);
        expect(reportCosts.requireCost(run2.id)).toBe(0.125);
        const run2Rows = await first.booted.handle.db.select().from(runs).where(eq(runs.id, run2.id));
        expect(run2Rows[0]).toMatchObject({
          phase: "done",
          outcome: "exec",
          status: "resolved",
          message: completionReason,
          error: null,
          // A finish carries no state of its own — this is also the ordering
          // proof: exactly ONE of the two Runs carries marker A in its row.
          state: null,
        });
        // The ordering argument, stated once: run 2's reason quotes marker A,
        // which only ever existed in the state run 1 promoted.
        expect(run1.id).not.toBe(run2.id);

        // Completed atomically: completion + schedule disable + state kept.
        const loopAfterRun2 = await loopRow(first, loopId);
        expect(loopAfterRun2.completionReason).toBe(completionReason);
        expect(loopAfterRun2.completedAt).not.toBeNull();
        expect(loopAfterRun2.enabled).toBe(false);
        expect(loopAfterRun2.state).toEqual({ step: 1, marker: markerA });
        expect(loopAfterRun2.taskFileContent).toBe(taskContentAfterRun1);
        expect(await first.booted.handle.db.select().from(runLeases)).toHaveLength(0);

        // 7. The Completed page: the button is disabled WITH a stated reason,
        //    and the completion reason renders the marker chain to the operator.
        const pageCompleted = await getPage(first.baseUrl);
        expect(pageCompleted).toContain('data-lifecycle="completed"');
        expect(pageCompleted).toContain('<span class="tag" data-lifecycle="completed">Completed</span>');
        expect(pageCompleted).toContain('<button type="submit" disabled>Run Now</button>');
        expect(pageCompleted).toContain("Loop 已完成（Completed），Run Now 会被拒绝。");
        expect(pageCompleted).toContain(completionReason);

        // 8. The management API's Completed guards are the coded 409 — the
        //    disabled button is advisory, these are the authority.
        const apiBodies: string[] = [];
        for (const [route, init] of [
          [`/api/loops/${loopId}/run`, { method: "POST" }],
          [`/api/loops/${loopId}/schedule`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }],
          [`/api/loops/${loopId}/goal`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "too late" }) }],
        ] as Array<[string, RequestInit]>) {
          const res = await fetch(`${first.baseUrl}${route}`, init);
          const text = await res.text();
          apiBodies.push(text);
          expect(res.status).toBe(409);
          expect((JSON.parse(text) as { code?: string }).code).toBe(LOOP_COMPLETED_CODE);
        }

        // 9. Graceful shutdown of the daemon: SIGTERM → exit 0, no credential
        //    in its complete stdout/stderr lifecycle.
        const closed = await supervisor.terminate({ graceMs: 5000, killWaitMs: 2000 });
        expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
        const daemonIndex = daemons.indexOf(supervisor);
        if (daemonIndex !== -1) daemons.splice(daemonIndex, 1);
        expect(logs.secretSeen).toBe(false);

        // ---- E2 · the frozen Completed Loop across two restarts ----
        // The control loop is UNFINISHED and enabled on the same minutely grid:
        // at the restart it MUST catch up, which is what makes the Completed
        // Loop's "no new Run" a measurement instead of a tautology.
        const control = await createLoop(first.baseUrl, {
          machineId,
          name: "b3-e2e-control",
          workdir,
          taskFile,
          cron: CRON_EVERY_MINUTE,
        });
        expect(await runsOf(first.baseUrl, control.id)).toHaveLength(0);

        const completedBefore = await loopRow(first, loopId);
        await closeLifetime(first); // production order: scheduler → listener → DB

        // Downtime crossing the whole minutely grid.
        clock.advance(DOWNTIME_MS);

        // Restart #1.
        const second = await bootLifetime(dataDir, clock);
        // The startup scan really ran, and it registered EXACTLY one job: the
        // control loop's. The Completed Loop is not merely skipped at enqueue
        // time — it never even reaches the cron registry (enabled = false).
        expect(second.cronFactory.activeCount()).toBe(1);
        const controlRuns = await runsOf(second.baseUrl, control.id);
        expect(controlRuns).toHaveLength(1);
        expect(controlRuns[0]).toMatchObject({ phase: "pending", role: "exec" });
        // The watermark only advances when a SCHEDULED enqueue commits, so this
        // is the proof the recovery pass really executed.
        expect((await loopRow(second, control.id)).lastScheduledAt).toBe(CATCHUP_OCCURRENCE);

        // The Completed Loop: same Runs, same state, same completion fields,
        // same row — the scan never even considers it (enabled = false).
        expect(await runsOf(second.baseUrl, loopId)).toHaveLength(2);
        const completedAfterRestart = await loopRow(second, loopId);
        expect(completedAfterRestart.state).toEqual({ step: 1, marker: markerA });
        expect(completedAfterRestart.completedAt).toBe(completedBefore.completedAt);
        expect(completedAfterRestart.completionReason).toBe(completionReason);
        expect(completedAfterRestart).toEqual(completedBefore);
        // …and the page still says Completed after the restart.
        expect(await getPage(second.baseUrl)).toContain('data-lifecycle="completed"');
        await closeLifetime(second);

        // Restart #2 at the SAME instant: the occurrence is already covered, so
        // the control loop gains nothing and the Completed Loop is still frozen.
        const third = await bootLifetime(dataDir, clock);
        expect(await runsOf(third.baseUrl, loopId)).toHaveLength(2);
        expect(await runsOf(third.baseUrl, control.id)).toHaveLength(1);
        expect((await loopRow(third, control.id)).lastScheduledAt).toBe(CATCHUP_OCCURRENCE);
        const completedAfterSecondRestart = await loopRow(third, loopId);
        expect(completedAfterSecondRestart.state).toEqual({ step: 1, marker: markerA });
        expect(completedAfterSecondRestart.completedAt).toBe(completedBefore.completedAt);
        expect(completedAfterSecondRestart.completionReason).toBe(completionReason);
        expect(completedAfterSecondRestart).toEqual(completedBefore);
        await closeLifetime(third);
      } catch (err) {
        const tail = logs.secretSeen ? "[suppressed because a credential was detected]" : logs.diagnosticTail();
        console.error(`[b3-e2e] bounded redacted daemon log tail (max ${MAX_LOG_BYTES} bytes):\n${tail}`);
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
