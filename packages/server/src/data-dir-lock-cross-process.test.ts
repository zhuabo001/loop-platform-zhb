/**
 * Slice 7 — cross-process evidence for the dataDir lock (ADR-011 决策 20).
 *
 * The whole reason `data-dir-lock.ts` exists is that PGlite takes no
 * cross-process filesystem lock: another process must be unable to open the
 * same `<dataDir>/pgdata`. The existing suites prove the contract inside ONE
 * process; these two tests put a real second Node process on the other side:
 *
 *  LOCK-CP1  the parent (production `acquireDataDirLock`) holds; a child's
 *            `open(path, "wx")` gets EEXIST. After release the same child
 *            acquires and cleans up.
 *  LOCK-CP2  a child holds (with a valid holder record); the production claim
 *            CLI exits 3 naming that child's pid, and `bootstrapServer`
 *            refuses with DataDirLockError BEFORE `<dataDir>/pgdata` exists.
 *            SIGTERM removes the lock and the next acquisition succeeds.
 *
 * No build artifacts are involved: `node -e` is enough for the second process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runClaimForTest } from "./testkit/claim-fixtures.js";
import {
  acquireDataDirLock,
  DataDirLockError,
  dataDirLockPath,
  formatAcquireFailureMessage,
} from "./data-dir-lock.js";
import { bootstrapServer } from "./start.js";
import { FakeClock, makeTestAuthConfig } from "./testkit/index.js";

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-lock-cp-${process.pid}-`));
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

/** Exit 0 = EEXIST (held); 42 = acquired and cleaned up; 1 = other error. */
function probeOnce(lockPath: string): Promise<number> {
  const script = `
    const fs = require("node:fs");
    try {
      const fd = fs.openSync(process.argv[1], "wx", 0o600);
      fs.closeSync(fd);
      fs.unlinkSync(process.argv[1]);
      process.exit(42);
    } catch (err) {
      process.exit(err.code === "EEXIST" ? 0 : 1);
    }
  `;
  const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: "ignore" });
  children.add(child);
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      children.delete(child);
      resolve(code ?? 1);
    });
  });
}

/** Open the lock as a REAL second process, write a valid holder record, and
 *  wait for SIGTERM. Resolves once the child printed `ready`. */
async function spawnHolder(lockPath: string): Promise<ChildProcess> {
  const script = `
    const fs = require("node:fs");
    const os = require("node:os");
    const lockPath = process.argv[1];
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      role: "server",
      startedAt: new Date().toISOString(),
      version: "probe",
    }) + "\\n");
    fs.closeSync(fd);
    process.stdout.write("ready\\n");
    process.on("SIGTERM", () => {
      try { fs.unlinkSync(lockPath); } catch {}
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString();
      if (buffered.includes("ready\n")) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!buffered.includes("ready\n")) reject(new Error(`holder exited early (code ${code ?? "?"})`));
    });
  });
  return child;
}

async function stopHolder(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
  children.delete(child);
}

describe("slice 7 LOCK-CP: the dataDir lock is mutually exclusive across processes", () => {
  it("LOCK-CP1: a held production lock makes a real child process's open('wx') fail with EEXIST; after release it acquires", async () => {
    const dataDir = await freshDir();
    const lockPath = dataDirLockPath(dataDir);
    const acquired = await acquireDataDirLock(dataDir, { role: "server", clock: new FakeClock() });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    expect(await probeOnce(lockPath)).toBe(0);
    await acquired.lock.release();
    expect(await exists(lockPath)).toBe(false);

    // The same probe now succeeds — and removes its lock file on exit.
    expect(await probeOnce(lockPath)).toBe(42);
    expect(await exists(lockPath)).toBe(false);
  });

  it("LOCK-CP2: a child-held lock refuses the claim CLI (exit 3) and boot (before pgdata exists)", async () => {
    const dataDir = await freshDir();
    const lockPath = dataDirLockPath(dataDir);
    const child = await spawnHolder(lockPath);

    // The production claim path names the CHILD as the holder.
    const claim = await runClaimForTest(dataDir, ["dk_lock_probe_machine"]);
    expect(claim.code).toBe(3);
    expect(claim.err).toContain(`held by pid ${child.pid}`);
    expect(claim.err).toContain(`rm ${lockPath}`);

    // Boot refuses before the database is opened.
    let bootError: unknown;
    try {
      await bootstrapServer(
        { auth: makeTestAuthConfig(), host: "127.0.0.1", port: 0, dataDir },
        { clock: new FakeClock() },
      );
    } catch (err) {
      bootError = err;
    }
    expect(bootError).toBeInstanceOf(DataDirLockError);
    expect((bootError as Error).message).toContain(`held by pid ${child.pid}`);
    expect(await exists(path.join(dataDir, "pgdata"))).toBe(false);

    // The holder's own record is what the refusal text parses.
    const record = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; role: string };
    expect(record).toMatchObject({ pid: child.pid, role: "server" });

    await stopHolder(child);
    expect(await exists(lockPath)).toBe(false);

    // Released: the lock is available again.
    const next = await acquireDataDirLock(dataDir, { role: "claim", clock: new FakeClock() });
    expect(next.ok).toBe(true);
    if (next.ok) await next.lock.release();
    expect(await exists(lockPath)).toBe(false);

    // The fixed refusal text is still the one the operator sees (guard against
    // a probe reading a different message than production).
    const locked = await acquireDataDirLock(dataDir, { role: "server", clock: new FakeClock() });
    if (!locked.ok) throw new Error("expected the lock to be free");
    const blocked = await acquireDataDirLock(dataDir, { role: "claim", clock: new FakeClock() });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(formatAcquireFailureMessage(blocked)).toContain("Stop the server");
    await locked.lock.release();
  });
});
