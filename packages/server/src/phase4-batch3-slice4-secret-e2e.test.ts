/**
 * Issue #53 (Phase 4 Batch 3 切片四) — batch plan §4 S2: the SETTINGS-DERIVED
 * provider secret's full-chain deterministic evidence. (S1, the #51 path-free
 * startup error, lives in the daemon's claude-provider-env/cli tests; S3, the
 * #33/#36 re-verification, is the already-pinned protocol terminal-policy +
 * phase4-wire suites, the PGlite writability round-trip and the L7 deep-body
 * HTTP pin — re-run rather than re-implemented.)
 *
 * The gap the issue names: the provider-bootstrap unit tests prove a settings
 * secret reaches `secretValues`, and the Batch 2 E2E proves an EXPLICIT-env
 * secret stays out of the logs and the wire — but no single deterministic test
 * carried a secret sourced from a temp `CLAUDE_CONFIG_DIR/settings.json`
 * through the production daemon CLI, the Journal/state/Task File boundaries,
 * Report/DB and the log observer. `phase4-batch2-e2e.test.ts` pins
 * CLAUDE_CONFIG_DIR to an EMPTY fixture and plants its key as an explicit
 * ANTHROPIC_API_KEY.
 *
 * This file closes that gap with the same production chain
 * (bootstrapServer → real 127.0.0.1 listener → built daemon CLI → production
 * Claude runner → fake-claude fixture) and five runs:
 *
 *   A `report-resolved`      the NORMAL path: the settings file is the only
 *                            source of the credential, the sidecar proves it
 *                            reached the Claude child env, and nothing on any
 *                            outward boundary carries it.
 *   B `report-secret-output` the secret is quoted by the CHILD's own output
 *                            (journal message AND result text): both carrier
 *                            paths must be redacted, never merely dropped.
 *   C `report-state-derived` a BASE64 encoding of the secret inside state:
 *                            fail closed — the run errors with a stable,
 *                            content-free classification and state is never
 *                            promoted (ADR-009 修订 8).
 *   D `task-file-derived`    a BASE64 encoding inside the Task File: the
 *                            post-run snapshot refuses it, so the poisoned
 *                            content never reaches the database.
 *   E `secret-session-derived` the credential quoted in the child's SESSION
 *                            ID — a column no run summary projects, so only a
 *                            complete-row scan can see the leak.
 *
 * The inherited provider credentials are DELETED from the child env before the
 * spawn, so "the sidecar saw it" can only mean "it came from settings".
 * Bounded waits: registration ≤30s, each run ≤60s, whole test ≤240s.
 * Cleanup order (finally): daemon → listener → DB → temp dirs.
 *
 * Round 1 review (Standards PASS; Spec + Adversarial P2) closed four gaps in
 * THIS file's own evidence — the issue was never that the chain leaked, but
 * that these boundaries were unaudited, so a future regression could pass:
 *
 *   1. The daemon → server Report body was never observed. The Run summary
 *      shows the JOURNAL message (the terminal command beats `finalText`), so
 *      an unredacted `finalText` could ride the wire unseen. The listener now
 *      captures every machine-endpoint request body the daemon produces and
 *      Run B's Report is asserted directly: `finalText` must survive as
 *      REDACTED PROSE, never as the value and never merely dropped.
 *   2. The database audit read the `/runs` SUMMARY projection only. The whole
 *      `runs` rows (state, sessionId, transcript, artifacts, usage) and the
 *      whole `loops` row are now scanned — those columns are exactly where a
 *      secret could land without ever entering a summary. Run E gives that
 *      scan something to find: it plants the credential in `session_id` (a
 *      field `runSummarySchema` does not even have), so the scan is
 *      falsifiable rather than coverage-only.
 *      (transcript/artifacts/usage are null on every batch-3 run — the
 *      adapter never populates them — so those three stay coverage-only.)
 *   3. The log observer knew only the RAW credential, so a DERIVED encoding in
 *      stdout/stderr would not have tripped `secretSeen` — and the diagnostic
 *      tail could then have printed it. All DERIVED_FORMS are watched now, and
 *      a hit still suppresses the tail.
 *   4. The control-root scan turned read errors into empty content, so an
 *      unreadable leftover could have held the credential while the scan
 *      passed. A read failure is now an audit FAILURE, and non-regular entries
 *      (symlinks, FIFOs, sockets) are surfaced instead of skipped.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopResponseSchema, loopListResponseSchema, runListResponseSchema } from "@loopzhb/protocol";
import { machineIdFromToken } from "@loopzhb/protocol/node";

import { closeDb, type DbHandle } from "./db/index.js";
import { loops, runs } from "./db/schema.js";
import { DaemonLogObserver, DetachedProcessSupervisor } from "./real-claude-e2e-harness.js";
import { bootstrapServer, waitForListening } from "./start.js";

const TOKEN = "dk_e2e_slice4_machine";
/** The planted provider credential. It lives ONLY in the temp settings
 *  fixture, in the agent env (a legitimate carrier), in the adversarial child
 *  output the fixture deliberately emits, and in this test's assertions. */
const SETTINGS_SECRET = "sk-ant-settings-derived-planted-4f2b91";
/** Every DISTINCT form the daemon's protected-form matcher derives for a
 *  secret of this length. The JSON-escaped and percent-encoded forms coincide
 *  with the raw value here (the credential is pure ASCII), so the raw entry
 *  already covers them — no assertion is weakened by their absence. */
const DERIVED_FORMS = [
  SETTINGS_SECRET,
  Buffer.from(SETTINGS_SECRET, "utf8").toString("base64"),
  Buffer.from(SETTINGS_SECRET, "utf8").toString("base64url"),
  Buffer.from(SETTINGS_SECRET, "utf8").toString("hex"),
];

/** Provider/TLS/proxy names the daemon's bootstrap could otherwise inherit
 *  from the developer's shell. All are removed before the spawn so the child
 *  env value can only have come from the temp settings fixture. */
const INHERITED_PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

const GOAL = "Carry the settings-derived credential through one full run";
const CRON_FAR_FUTURE = "0 0 1 1 *"; // Jan 1 00:00 — never fires during the test
const TASK_CONTENT = [
  "# Slice 4 secret E2E Task",
  "",
  "## Spec",
  "Record nothing sensitive.",
  "",
  "## Timeline",
  "(empty)",
  "",
].join("\n");

const REGISTER_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 240_000;
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

/** The control-root residue scan. The per-run Journal outbox lives inside the
 *  control root and is deleted with its run (the runner releases the control
 *  dir in its `finally`, before the terminal Report is ever sent), so this
 *  proves no leftover artifact carries the credential — the accepted record's
 *  own content is covered by the Report/DB and wire scans instead.
 *
 *  Round-1 review (Adversarial): this used to turn every read error into empty
 *  content, so an unreadable leftover could have held the credential while the
 *  scan still passed. A read failure is now an audit FAILURE, and an entry
 *  that is neither a regular file nor a directory is REPORTED rather than
 *  skipped, so the caller can assert the expected set: the control root is
 *  daemon-owned and must hold nothing but regular files and directories (a
 *  symlink is never followed out of the root, and a FIFO/socket persists no
 *  bytes, so an unexpected kind is a finding, not a footnote). */
async function scanTree(dir: string): Promise<{ files: string[]; text: string; special: string[] }> {
  const files: string[] = [];
  const parts: string[] = [];
  const special: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        files.push(relative);
        parts.push(
          await readFile(full, "utf-8").catch((err: unknown) => {
            throw new Error(
              `control-root residue scan could not read ${relative}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
        );
        continue;
      }
      special.push(`${relative} (${entry.isSymbolicLink() ? "symlink" : "non-regular"})`);
    }
  };
  await walk(dir);
  return { files, text: parts.join("\n"), special };
}

/** The report the daemon put on the wire for one Run. `finalText` is the
 *  field the Run summary can NOT stand in for: the summary shows the journal
 *  message (the terminal command beats `finalText` in the store's priority
 *  select), so only the captured wire body can pin it. */
type WireReport = {
  runId?: string;
  finalText?: string;
  message?: string;
  ok?: boolean;
  terminal?: { kind?: string; message?: string };
} & Record<string, unknown>;

/** Settle the listener's in-flight clone-reads before an audit reads the
 *  captured bodies: `clone().text()` is async, so reading the array straight
 *  after a Run goes terminal could miss the very request under audit — and a
 *  MISSING capture must never read as "clean". */
async function settleDaemonRequests(
  pending: ReadonlySet<Promise<void>>,
  requests: ReadonlyArray<{ path: string; body: string }>,
): Promise<Array<{ path: string; body: string }>> {
  await Promise.all([...pending]);
  return [...requests];
}

describe("Phase 4 Batch 3 slice 4 (Issue #53): the settings-derived provider secret across every boundary", () => {
  it(
    "a temp settings.json credential reaches the agent env, is redacted in output text, and cannot enter state, Task File, DB, wire bodies or the daemon log",
    async () => {
      // 1. The operator's allowed root with the workdir and task file.
      const allowedRoot = await mkdtemp(path.join(tmpdir(), `loopzhb-s4e2e-root-${process.pid}-`));
      tempDirs.push(allowedRoot);
      const workdir = path.join(allowedRoot, "workdir");
      await mkdir(workdir, { recursive: true });
      const taskFile = path.join(workdir, "TASK.md");
      await writeFile(taskFile, TASK_CONTENT, "utf-8");
      const canonicalWorkdir = await realpath(workdir);

      // 2. Production server: file PGlite + real HTTP listener.
      const dataDir = await mkdtemp(path.join(tmpdir(), `loopzhb-s4e2e-data-${process.pid}-`));
      tempDirs.push(dataDir);
      const booted = await bootstrapServer({ host: "127.0.0.1", port: 0, dataDir });
      handles.push(booted.handle);
      // The daemon's own traffic, captured at the listener (round-1 review):
      // cloning the request BEFORE the app reads it observes the exact bytes
      // the production daemon produced. Only the BODY is captured — the
      // machine credential and the run credential legitimately ride the
      // Authorization header, which is a different boundary.
      const daemonRequests: Array<{ path: string; body: string }> = [];
      const pendingCaptures = new Set<Promise<void>>();
      const server = serve({
        fetch: (req: Request) => {
          const pathname = new URL(req.url).pathname;
          if (pathname.startsWith("/api/machine/")) {
            const captured = req.clone().text();
            pendingCaptures.add(
              captured.then((text) => {
                daemonRequests.push({ path: pathname, body: text });
              }),
            );
          }
          return booted.app.fetch(req);
        },
        port: 0,
        hostname: "127.0.0.1",
      });
      servers.push(server);
      await waitForListening(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to get server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Every wire body the test observes — scanned for the secret at the end.
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

      // 3. The TEMP provider fixture: <configDir>/settings.json carries the
      //    planted credential in its `env` block. This is the ONLY source.
      const configDir = await mkdtemp(path.join(tmpdir(), `loopzhb-s4e2e-claude-config-${process.pid}-`));
      tempDirs.push(configDir);
      await writeFile(
        path.join(configDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_API_KEY: SETTINGS_SECRET, ANTHROPIC_BASE_URL: "https://fixture.example" } }),
        "utf-8",
      );

      // 4. The production daemon CLI with the fake Claude binary, on an env
      //    stripped of every inherited provider credential.
      const controlRootsBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("loopzhb-control-")));
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        LOOPZHB_SERVER_URL: baseUrl,
        LOOPZHB_MACHINE_CREDENTIAL: TOKEN,
        LOOPZHB_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
        LOOPZHB_CLAUDE_BIN: path.join(__dirname, "../../daemon/test-fixtures/fake-claude.mjs"),
        LOOPZHB_POLL_MS: "500",
        CLAUDE_CONFIG_DIR: configDir,
        NODE_ENV: "production",
      };
      for (const key of INHERITED_PROVIDER_KEYS) delete childEnv[key];
      const daemon = spawn(process.execPath, [path.join(__dirname, "../../daemon/dist/cli.js")], {
        env: childEnv,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const supervisor = new DetachedProcessSupervisor(daemon);
      // Round-1 review (Adversarial): watching only the RAW credential means a
      // derived encoding in stdout/stderr never trips `secretSeen`, and the
      // failure path would then print it through `diagnosticTail()`. Every
      // form this test exercises is watched, so a hit both fails the audit and
      // suppresses the tail.
      const logs = new DaemonLogObserver([TOKEN, ...DERIVED_FORMS], MAX_LOG_BYTES);
      daemons.push(supervisor);
      daemon.stdout?.on("data", (chunk: Buffer) => logs.append("stdout", chunk));
      daemon.stderr?.on("data", (chunk: Buffer) => logs.append("stderr", chunk));

      /** One run: set the scenario, trigger, wait for a terminal phase. */
      const runScenario = async (scenario: string): Promise<string> => {
        await writeFile(path.join(workdir, ".fake-claude-v1-scenario"), scenario, "utf-8");
        const trigger = await api(`/api/loops/${loopId}/run`, { method: "POST" });
        expect(trigger.status).toBe(202);
        const body = trigger.body as { enqueued?: boolean; runId?: string };
        if (body.enqueued !== true || body.runId === undefined) throw new Error(`expected ${scenario} to enqueue`);
        const runId = body.runId;
        await waitFor(async () => {
          const runs = runListResponseSchema.parse((await api(`/api/loops/${loopId}/runs`)).body).runs;
          const run = runs.find((r) => r.id === runId);
          return run !== undefined && (run.phase === "done" || run.phase === "error");
        }, RUN_TIMEOUT_MS);
        return runId;
      };

      let loopId = "";
      try {
        // 5. Machine registration (the daemon self-registers on first poll).
        const machineId = machineIdFromToken(TOKEN);
        await waitFor(async () => {
          const res = await fetch(`${baseUrl}/api/machines`);
          if (!res.ok) return false;
          const body = (await res.json()) as { machines?: Array<{ id: string }> };
          return body.machines?.some((m) => m.id === machineId) ?? false;
        }, REGISTER_TIMEOUT_MS);

        // 6. The control root exists (0700) and its static wrapper carries
        //    neither the machine credential nor the settings-derived secret.
        const newRoots = readdirSync(tmpdir())
          .filter((n) => n.startsWith("loopzhb-control-") && !controlRootsBefore.has(n))
          .map((n) => path.join(tmpdir(), n));
        expect(newRoots).toHaveLength(1);
        // The daemon realpaths its mkdtemp base (macOS /var → /private/var).
        const controlRoot = await realpath(newRoots[0]!);
        expect(await modeOf(controlRoot)).toBe(0o700);
        const wrapperSource = await readFile(path.join(controlRoot, "bin", "loopzhb"), "utf-8");
        expect(wrapperSource).not.toContain(TOKEN);
        for (const form of DERIVED_FORMS) expect(wrapperSource).not.toContain(form);

        // 7. The Closed Loop with the goal + far-future cron.
        const createRes = await api("/api/loops", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ machineId, name: "s4-e2e-loop", workdir, taskFile, goal: GOAL, cron: CRON_FAR_FUTURE }),
        });
        expect(createRes.status).toBe(201);
        const { loop } = createLoopResponseSchema.parse(createRes.body);
        loopId = loop.id;

        // ---- RUN A: the normal path ----
        const runAId = await runScenario("report-resolved");
        const runsA = runListResponseSchema.parse((await api(`/api/loops/${loopId}/runs`)).body).runs;
        expect(runsA).toHaveLength(1);
        // The journal's own message passes through untouched — this run had no
        // secret in play at all.
        expect(runsA[0]).toMatchObject({ phase: "done", outcome: "exec", message: "done", error: null });

        const sidecar = JSON.parse(await readFile(path.join(workdir, ".fake-claude-session.json"), "utf-8")) as {
          argv: string[];
          prompt: string;
          env: Record<string, string | null>;
        };
        // THE settings-derived proof: the value the agent saw is exactly the
        // fixture's, not an inherited one (all inherited ones were deleted).
        expect(sidecar.env.ANTHROPIC_API_KEY).toBe(SETTINGS_SECRET);
        expect(sidecar.env.LOOPZHB_MACHINE_CREDENTIAL).toBeNull();
        // The credential never rides argv or the prompt.
        for (const form of DERIVED_FORMS) {
          expect(sidecar.argv.join(" ")).not.toContain(form);
          expect(sidecar.prompt).not.toContain(form);
        }
        expect(sidecar.prompt).toContain(JSON.stringify(path.join(canonicalWorkdir, "TASK.md")));
        expect(sidecar.prompt).not.toContain(TASK_CONTENT);

        // The normal-path DB state: the clean Task File was synced and no
        // state was promoted.
        const loopA = (await booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        expect(loopA).toMatchObject({ taskFileContent: TASK_CONTENT, taskFileSyncError: null, state: null });

        // ---- RUN B: the child quotes the credential in its own output ----
        const runBId = await runScenario("report-secret-output");
        const runsB = runListResponseSchema.parse((await api(`/api/loops/${loopId}/runs`)).body).runs;
        const runB = runsB.find((r) => r.id === runBId)!;
        // Redacted — not dropped: the surrounding prose survives, the value
        // does not. It is the journal message that becomes the Run message
        // (the terminal command is authoritative over finalText).
        expect(runB.message).toMatch(/^provider said /);
        for (const form of DERIVED_FORMS) expect(runB.message).not.toContain(form);

        // …and the SAME two carriers on the wire the summary can NOT stand in
        // for: the Report body the daemon POSTed. `finalText` (the child's own
        // result text) never reaches the Run summary — the journal message wins
        // the store's priority select — so only the captured body pins it.
        const bodiesAfterB = await settleDaemonRequests(pendingCaptures, daemonRequests);
        const reportB = bodiesAfterB
          .filter((request) => request.path === "/api/machine/report")
          .map((request) => JSON.parse(request.body) as WireReport)
          .find((body) => body.runId === runBId);
        if (reportB === undefined) {
          throw new Error("no Report request was observed for run B — the wire boundary is unaudited");
        }
        expect(reportB.ok).toBe(true);
        // The report body also carries the accepted Journal command verbatim,
        // which is the record the control-root scan delegates here.
        expect(reportB.terminal?.kind).toBe("report");
        expect(reportB.terminal?.message).toMatch(/^provider said /);
        for (const form of DERIVED_FORMS) expect(reportB.terminal?.message ?? "").not.toContain(form);
        // Redacted, never dropped: the surrounding prose survives intact.
        expect(reportB.finalText).toMatch(/^used credential /);
        for (const form of DERIVED_FORMS) expect(reportB.finalText ?? "").not.toContain(form);
        // …and no other field of the report smuggles a form either.
        expect(JSON.stringify(reportB)).not.toContain(TOKEN);
        for (const form of DERIVED_FORMS) expect(JSON.stringify(reportB)).not.toContain(form);

        const loopB = (await booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        expect(loopB.state).toBeNull();

        // ---- RUN C: a derived encoding inside state fails closed ----
        const runCId = await runScenario("report-state-derived");
        const runsC = runListResponseSchema.parse((await api(`/api/loops/${loopId}/runs`)).body).runs;
        const runC = runsC.find((r) => r.id === runCId)!;
        // Stable, content-free classification; the run never reports success.
        // The `journal_invalid:` prefix is the daemon's journal error code —
        // the reason names the rejected *kind* of value, never the value.
        expect(runC).toMatchObject({ phase: "error", outcome: "error" });
        expect(runC.error).toBe("journal_invalid: state contains a known secret");
        for (const form of DERIVED_FORMS) expect(runC.error ?? "").not.toContain(form);
        // State was never promoted — a rejected state is never rewritten.
        const loopC = (await booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        expect(loopC.state).toBeNull();

        // ---- RUN D: a derived encoding inside the Task File is refused ----
        const runDId = await runScenario("task-file-derived");
        const runsD = runListResponseSchema.parse((await api(`/api/loops/${loopId}/runs`)).body).runs;
        // The Run itself succeeds — the refusal is a sync failure, not a run
        // failure, and it never rolls the run back.
        expect(runsD.find((r) => r.id === runDId)).toMatchObject({ phase: "done", outcome: "exec" });
        const loopD = (await booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        expect(loopD.taskFileSyncError).toBe("unreadable");
        // The poisoned file is still on disk (the daemon never rewrites it)…
        const poisoned = await readFile(taskFile, "utf-8");
        expect(poisoned).toContain(Buffer.from(SETTINGS_SECRET, "utf8").toString("base64"));
        // …and the database still holds run A's clean snapshot, so the
        // credential's derived form never entered it.
        expect(loopD.taskFileContent).toBe(TASK_CONTENT);
        for (const form of DERIVED_FORMS) expect(loopD.taskFileContent ?? "").not.toContain(form);

        // ---- RUN E: the credential rides a column no summary exposes ----
        const runEId = await runScenario("secret-session-derived");
        const runsE = runListResponseSchema.parse((await api(`/api/loops/${loopId}/runs`)).body).runs;
        expect(runsE.find((r) => r.id === runEId)).toMatchObject({ phase: "done", outcome: "exec" });
        // `sessionId` is NOT a field of `runSummarySchema` — the projection this
        // test reads everywhere else cannot see it at all, so a leak here would
        // have been invisible before the full-row scan below (round-1 review
        // ADV). The child-supplied text survives as prose; the value does not.
        const runERow = (await booted.handle.db.select().from(runs).where(eq(runs.id, runEId)))[0]!;
        expect(runERow.sessionId).toMatch(/^sess-/);
        expect(runERow.sessionId).not.toContain(SETTINGS_SECRET);
        for (const form of DERIVED_FORMS) expect(runERow.sessionId ?? "").not.toContain(form);

        // 8. The COMPLETE persisted rows — never the `/runs` summary
        //    projection alone. `state`, `sessionId`, `transcript`, `artifacts`
        //    and `usage` are exactly where a secret would land without ever
        //    entering a summary (round-1 review ADV); the loop row carries the
        //    Task File snapshot and the workflow state on top of that.
        const runRows = await booted.handle.db.select().from(runs).where(eq(runs.loopId, loopId));
        expect(runRows).toHaveLength(5); // one per Run — the scan is not vacuous
        const loopRow = (await booted.handle.db.select().from(loops).where(eq(loops.id, loopId)))[0]!;
        const persisted = JSON.stringify([...runRows, loopRow]);
        // Anti-vacuity: child-derived text really is inside the scanned rows
        // (the agent session id), so an empty projection could not pass.
        expect(persisted).toContain("fake-sess-1");
        expect(persisted).not.toContain(TOKEN);
        for (const form of DERIVED_FORMS) expect(persisted).not.toContain(form);

        // 9. The control-root residue scan (while the daemon still owns it):
        //    the Journal outbox and every per-run control directory live under
        //    this root and are deleted with their run, so a hit here would be
        //    the credential surviving in daemon-owned on-disk state.
        const controlTree = await scanTree(controlRoot);
        // Anti-vacuity: the walk really descended into the daemon's own tree…
        expect(controlTree.files).toContain(path.join("bin", "loopzhb"));
        // …and found nothing but regular files and directories: the root is
        // daemon-owned, so a symlink or a special file here is itself a
        // finding, not a footnote (round-1 review ADV).
        expect(controlTree.special).toEqual([]);
        expect(controlTree.text).not.toContain(TOKEN);
        for (const form of DERIVED_FORMS) expect(controlTree.text).not.toContain(form);

        // 10. Graceful shutdown: SIGTERM → exit 0.
        const closed = await supervisor.terminate({ graceMs: 5000, killWaitMs: 2000 });
        expect(closed).toEqual({ kind: "closed", code: 0, signal: null });
        const daemonIndex = daemons.indexOf(supervisor);
        if (daemonIndex !== -1) daemons.splice(daemonIndex, 1);

        // 11. The outward-boundary audit: the daemon's complete stdout/stderr
        //     lifecycle, every body the DAEMON itself put on the wire (poll
        //     progress + reports, captured at the listener) and every body this
        //     test observed are clean of the machine credential and of every
        //     form of the settings-derived secret.
        expect(logs.secretSeen).toBe(false);
        // Harness self-check (round-1 review ADV): the observer watching THIS
        // run really does catch a DERIVED form and really does keep it out of
        // the diagnostic tail. Without this, dropping a form from the observer's
        // list would silently weaken the audit above instead of failing —
        // `secretSeen` would stay false and the tail would print the value into
        // CI logs. A throwaway instance, so the audited one stays untouched.
        const probeObserver = new DaemonLogObserver([TOKEN, ...DERIVED_FORMS], MAX_LOG_BYTES);
        const derivedSample = DERIVED_FORMS[1]!;
        probeObserver.append("stdout", Buffer.from(`noise ${derivedSample} noise`, "utf8"));
        expect(probeObserver.secretSeen).toBe(true);
        expect(probeObserver.diagnosticTail()).toContain("[REDACTED]");
        expect(probeObserver.diagnosticTail()).not.toContain(derivedSample);
        const daemonBodies = await settleDaemonRequests(pendingCaptures, daemonRequests);
        // Anti-vacuity, twice over: the poll capture is real, and all four runs
        // reported through it — a capture that silently stopped working could
        // otherwise make this whole audit pass by observing nothing.
        expect(daemonBodies.filter((request) => request.path === "/api/machine/poll").length).toBeGreaterThan(0);
        const reportedRunIds = new Set(
          daemonBodies
            .filter((request) => request.path === "/api/machine/report")
            .map((request) => (JSON.parse(request.body) as WireReport).runId),
        );
        expect(reportedRunIds).toEqual(new Set([runAId, runBId, runCId, runDId, runEId]));
        for (const request of daemonBodies) {
          expect(request.body).not.toContain(TOKEN);
          for (const form of DERIVED_FORMS) expect(request.body).not.toContain(form);
        }
        for (const body of wireBodies) {
          expect(body).not.toContain(TOKEN);
          for (const form of DERIVED_FORMS) expect(body).not.toContain(form);
        }
        // The loop list (the summary projection) carries no state either.
        const loopList = JSON.stringify(loopListResponseSchema.parse((await api("/api/loops")).body));
        for (const form of DERIVED_FORMS) expect(loopList).not.toContain(form);
      } catch (err) {
        const tail = logs.secretSeen ? "[suppressed because a credential was detected]" : logs.diagnosticTail();
        console.error(`[s4-e2e] bounded redacted daemon log tail (max ${MAX_LOG_BYTES} bytes):\n${tail}`);
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
