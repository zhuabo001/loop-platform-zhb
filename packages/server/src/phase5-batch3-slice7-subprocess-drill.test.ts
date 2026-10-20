/**
 * Phase 5 Batch 3 slice 7 — OPT-IN subprocess drill (ADR-011 决策 37).
 *
 * The default gate proves the upgrade chain with the production modules inside
 * ONE test process. This drill puts the REAL built processes on the wire:
 *
 *   dist/start.js  (production Server)  → holds the dataDir lock
 *   dist/claim/main.js (real CLI)       → exit 3 while held, exit 0 after stop
 *   daemon dist/cli.js (real daemon)    → executes the pre-upgrade pending Run
 *                                         and syncs a new snapshot
 *
 * Gate: `LOOPZHB_SUBPROCESS_DRILL=1`. Without it the test is skipped, so a
 * clean checkout runs `pnpm test` without building the server. When ENABLED
 * and a build artifact is missing, the test FAILS with the build command —
 * never a silent skip. Run it with:
 *
 *   pnpm build && LOOPZHB_SUBPROCESS_DRILL=1 \
 *     pnpm --filter @loopzhb/server exec vitest run \
 *       src/phase5-batch3-slice7-subprocess-drill.test.ts
 *
 * Evidence is recorded separately from the default gate; this file never
 * contacts real GitHub or real Claude.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "./auth/cookies.js";
import { closeDb, openMigratedDb } from "./db/index.js";
import { buildBatch2World } from "./testkit/batch2-world.js";
import { seedPersonalIdentity, seedSession } from "./testkit/index.js";

const ENABLED = process.env.LOOPZHB_SUBPROCESS_DRILL === "1";
const DAY_MS = 24 * 3600 * 1000;
const OLD_APP = "drill legacy app\n";
const LEGACY_TOKEN = "dk_drill_legacy_machine";
const UNKNOWN_TOKEN = "dk_drill_unknown_machine";

const repoRoot = path.resolve(__dirname, "../../..");
const serverEntry = path.join(repoRoot, "packages/server/dist/start.js");
const claimEntry = path.join(repoRoot, "packages/server/dist/claim/main.js");
const daemonEntry = path.join(repoRoot, "packages/daemon/dist/cli.js");
const fakeClaude = path.join(repoRoot, "packages/daemon/test-fixtures/fake-claude.mjs");

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-${prefix}-${process.pid}-`));
  tempDirs.push(dir);
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Spawned {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
}

function spawnNode(entry: string, args: readonly string[], env: NodeJS.ProcessEnv): Spawned {
  const child = spawn(process.execPath, [entry, ...args], {
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => out.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return { child, out: () => out.join(""), err: () => err.join(""), exited };
}

async function stop(child: Spawned, label: string): Promise<number | null> {
  if (child.child.exitCode === null) child.child.kill("SIGTERM");
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000));
  const result = await Promise.race([child.exited, timeout]);
  if (result === "timeout") {
    child.child.kill("SIGKILL");
    throw new Error(`${label} did not exit after SIGTERM`);
  }
  return result;
}

async function until<T>(probe: () => Promise<T | undefined>, label: string, deadlineMs = 30_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`deadline exceeded waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForHttp(url: string, deadlineMs = 30_000): Promise<void> {
  await until(
    async () => {
      try {
        const res = await fetch(url);
        return res.status === 200 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    `GET ${url}`,
    deadlineMs,
  );
}

describe.skipIf(!ENABLED)("slice 7 DRILL: the built Server, claim CLI and daemon run the upgrade", () => {
  it("DRILL: dist/start.js locks, dist/claim/main.js claims offline, the built daemon executes and syncs", async () => {
    for (const artifact of [serverEntry, claimEntry, daemonEntry, fakeClaude]) {
      if (!(await exists(artifact))) {
        throw new Error(`missing build artifact ${artifact} — run \`pnpm build\` first`);
      }
    }

    const dataDir = await freshDir("drill-data");
    const workdir = await realpath(await freshDir("drill-work"));
    await mkdir(path.join(workdir, "dist"), { recursive: true });
    await writeFile(path.join(workdir, "dist", "app.js"), "drill post-upgrade app\n");
    await writeFile(path.join(workdir, ".fake-claude-v1-scenario"), "report-resolved");
    await writeFile(path.join(workdir, "TASK.md"), "# drill task\n");

    const world = await buildBatch2World(dataDir, {
      machineToken: LEGACY_TOKEN,
      workdir,
      machineRoots: [workdir],
      runMode: "pending",
      // The real Server starts its scheduler after the claim; the drill drives
      // the pre-upgrade pending Run through the daemon, so no catch-up Run.
      cron: null,
      includePlainLoop: false,
      taskFile: path.join(workdir, "TASK.md"),
      taskFileContent: "# drill task\n",
      artifacts: [{ path: "dist/app.js", text: OLD_APP }],
    });

    // Apply 0006 and state the account a real login would create.
    const handle = await openMigratedDb({ dataDir });
    let credential: string;
    try {
      const identity = await seedPersonalIdentity(handle.db, { githubUserId: "424242", username: "analyst" });
      const session = await seedSession(handle.db, {
        userId: identity.userId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      });
      credential = session.credential;
    } finally {
      await closeDb(handle);
    }
    const cookie = `${SESSION_COOKIE}=${credential}`;

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LOOPZHB_HOST: "127.0.0.1",
      LOOPZHB_PORT: String(port),
      LOOPZHB_DATA_DIR: dataDir,
      LOOPZHB_ORIGIN: baseUrl,
      LOOPZHB_GITHUB_CLIENT_ID: "drill-client-id",
      LOOPZHB_GITHUB_CLIENT_SECRET: "drill-client-secret",
    };
    const lockPath = path.join(dataDir, "data-dir.lock");

    // ---- 1. The real Server boots and holds the lock ----
    const server = spawnNode(serverEntry, [], serverEnv);
    await waitForHttp(`${baseUrl}/login`);
    expect(await exists(lockPath)).toBe(true);

    // ---- 2. The real CLI refuses while the Server holds the lock ----
    const lockedClaim = spawnNode(claimEntry, [
      "--data-dir",
      dataDir,
      "--github-user-id",
      "424242",
      "--machine-id",
      world.machineId,
    ], process.env);
    expect(await lockedClaim.exited).toBe(3);
    expect(lockedClaim.err()).toContain("data directory is locked");
    expect(lockedClaim.err()).toContain("role: server");

    // ---- 3. SIGTERM stops the Server cleanly and releases the lock ----
    expect(await stop(server, "server")).toBe(0);
    await until(async () => ((await exists(lockPath)) ? undefined : true), "the lock file to be removed");

    // ---- 4. The real CLI claims the machine ----
    const claim = spawnNode(claimEntry, [
      "--data-dir",
      dataDir,
      "--github-user-id",
      "424242",
      "--machine-id",
      world.machineId,
    ], process.env);
    expect(await claim.exited).toBe(0);
    expect(claim.out()).toContain("committed: 1 machine(s)");

    // ---- 5. Reboot: the claimed Loop and old snapshot are visible ----
    const server2 = spawnNode(serverEntry, [], serverEnv);
    await waitForHttp(`${baseUrl}/login`);
    const loopsRes = await fetch(`${baseUrl}/api/loops`, { headers: { cookie } });
    expect(loopsRes.status).toBe(200);
    const loops = (await loopsRes.json()) as { loops: { id: string }[] };
    expect(loops.loops.map((loop) => loop.id)).toContain(world.loopId);

    const oldDownload = await fetch(
      `${baseUrl}/api/loops/${world.loopId}/artifacts/download?snapshotId=${world.manifestId}&path=${encodeURIComponent("dist/app.js")}`,
      { headers: { cookie } },
    );
    expect(oldDownload.status).toBe(200);
    expect(await oldDownload.text()).toBe(OLD_APP);

    const unknown = await fetch(`${baseUrl}/api/machine/poll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${UNKNOWN_TOKEN}` },
      body: "{}",
    });
    expect(unknown.status).toBe(401);

    // ---- 6. The built daemon executes the pre-upgrade pending Run ----
    const daemonTmp = await freshDir("drill-daemon-tmp");
    const claudeConfig = await freshDir("drill-claude-config");
    const daemon = spawnNode(daemonEntry, [], {
      ...process.env,
      TMPDIR: daemonTmp,
      LOOPZHB_SERVER_URL: baseUrl,
      LOOPZHB_MACHINE_CREDENTIAL: LEGACY_TOKEN,
      LOOPZHB_ALLOWED_ROOTS: JSON.stringify([workdir]),
      LOOPZHB_CLAUDE_BIN: fakeClaude,
      LOOPZHB_POLL_MS: "500",
      ANTHROPIC_API_KEY: "sk-ant-drill-fake",
      CLAUDE_CONFIG_DIR: claudeConfig,
      NODE_ENV: "production",
    });

    const bound = await until(
      async () => {
        const res = await fetch(`${baseUrl}/api/runs/${world.pendingRunId}/artifacts`, { headers: { cookie } });
        if (res.status !== 200) return undefined;
        const body = (await res.json()) as { state?: string; snapshotId?: string };
        return body.state === "bound" ? body : undefined;
      },
      "the built daemon to bind a new snapshot",
      60_000,
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- daemon stdout ---\n${daemon.out()}\n--- daemon stderr ---\n${daemon.err()}`);
    });
    expect(bound.snapshotId).toBeTruthy();
    expect(bound.snapshotId).not.toBe(world.manifestId);

    // The old snapshot still serves its original bytes.
    const oldAgain = await fetch(
      `${baseUrl}/api/loops/${world.loopId}/artifacts/download?snapshotId=${world.manifestId}&path=${encodeURIComponent("dist/app.js")}`,
      { headers: { cookie } },
    );
    expect(await oldAgain.text()).toBe(OLD_APP);

    // ---- 7. Ordered shutdown: daemon, then Server; no lock remains ----
    expect(await stop(daemon, "daemon")).toBe(0);
    expect(await stop(server2, "server2")).toBe(0);
    expect(await exists(lockPath)).toBe(false);
  }, 180_000);
});
