/**
 * dataDir exclusive lock (ADR-011 决策 20) — the ONE mutex over a data
 * directory, and the boot gate that makes "the server must be stopped before a
 * claim" a fact rather than a convention.
 *
 * Real temp dirs, real fs, no seams. The load-bearing pins:
 *  - acquisition is atomic (`wx`) and a held lock is REFUSED, never taken over;
 *  - the refusal text names the path and the manual `rm` recovery;
 *  - release is inode-guarded against the documented manual-recovery race;
 *  - `bootstrapServer` refuses on a held lock BEFORE creating pgdata;
 *  - closing the DB handle releases the lock — the invariant that keeps every
 *    restart-shaped test green with no edits.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireDataDirLock,
  DATA_DIR_LOCK_FILENAME,
  dataDirLockPath,
  formatDataDirLockedMessage,
  type AcquireDataDirLockResult,
} from "./data-dir-lock.js";
import { closeDb } from "./db/index.js";
import { bootstrapServer, type BootedServer } from "./start.js";
import { FakeClock, makeTestAuthConfig } from "./testkit/index.js";

const dirs: string[] = [];
const servers: BootedServer[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-lock-${process.pid}-`));
  dirs.push(dir);
  return dir;
}

function boot(dir: string): Promise<BootedServer> {
  return bootstrapServer({ auth: makeTestAuthConfig(), host: "127.0.0.1", port: 3000, dataDir: dir });
}

afterEach(async () => {
  for (const s of servers.splice(0)) await closeDb(s.handle).catch(() => {});
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function expectLocked(result: AcquireDataDirLockResult): Extract<AcquireDataDirLockResult, { ok: false; failure: "locked" }> {
  if (result.ok || result.failure !== "locked") throw new Error(`expected a locked refusal, got ${JSON.stringify(result)}`);
  return result;
}

describe("dataDir lock: acquire / refuse / release", () => {
  it("writes the holder record and removes the file on release", async () => {
    const dir = await makeDataDir();
    const clock = new FakeClock(new Date("2026-10-10T09:00:00.000Z"));

    const result = await acquireDataDirLock(dir, { role: "claim", clock });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lockPath = dataDirLockPath(dir);
    expect(result.lock.path).toBe(lockPath);
    expect(path.basename(lockPath)).toBe(DATA_DIR_LOCK_FILENAME);

    const holder = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    expect(holder.pid).toBe(process.pid);
    expect(holder.role).toBe("claim");
    expect(holder.startedAt).toBe("2026-10-10T09:00:00.000Z");
    expect(holder.hostname).toBeTypeOf("string");
    // The holder file is operator-readable only.
    expect(((await stat(lockPath)).mode & 0o777).toString(8)).toBe("600");

    await result.lock.release();
    expect(existsSync(lockPath)).toBe(false);
    // Idempotent: a second release must not throw and must not resurrect it.
    await result.lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses a second acquisition while the first is held, and names the holder", async () => {
    const dir = await makeDataDir();
    const first = await acquireDataDirLock(dir, { role: "server" });
    expect(first.ok).toBe(true);

    const second = await acquireDataDirLock(dir, { role: "claim" });
    const locked = expectLocked(second);
    expect(locked.path).toBe(dataDirLockPath(dir));
    expect(locked.holder?.pid).toBe(process.pid);
    expect(locked.holder?.role).toBe("server");

    if (first.ok) await first.lock.release();
  });

  it("refuses a hand-written stale lock and prints the documented manual recovery", async () => {
    const dir = await makeDataDir();
    const lockPath = dataDirLockPath(dir);
    // The exact shape an operator finds after a SIGKILL.
    await writeFile(lockPath, `${JSON.stringify({ pid: 999999, hostname: "op-box", role: "server", startedAt: "2026-10-10T08:00:00.000Z" })}\n`);

    const locked = expectLocked(await acquireDataDirLock(dir, { role: "claim" }));
    expect(locked.holder?.pid).toBe(999999);

    const message = formatDataDirLockedMessage(locked);
    expect(message).toContain(lockPath);
    expect(message).toContain("pid 999999 on op-box (role: server) since 2026-10-10T08:00:00.000Z");
    expect(message).toContain("never taken over automatically");
    expect(message).toContain(`rm ${lockPath}`);

    // A malformed record is still a lock — it must never be treated as free.
    await writeFile(lockPath, "not json at all");
    const truncated = expectLocked(await acquireDataDirLock(dir, { role: "claim" }));
    expect(truncated.holder).toBeNull();
    expect(formatDataDirLockedMessage(truncated)).toContain("missing or unreadable");
  });

  it("release leaves a swapped-in lock file alone (manual-recovery race)", async () => {
    const dir = await makeDataDir();
    const result = await acquireDataDirLock(dir, { role: "claim" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The operator removes our file mid-run and someone else acquires the path.
    const lockPath = dataDirLockPath(dir);
    await unlink(lockPath);
    await writeFile(lockPath, `${JSON.stringify({ pid: 4242, hostname: "other", role: "claim", startedAt: "2026-10-10T10:00:00.000Z" })}\n`);

    await result.lock.release();

    expect(existsSync(lockPath)).toBe(true);
    const still = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    expect(still.pid).toBe(4242);
  });
});

describe("dataDir lock: server boot gate", () => {
  it("records role server and refuses a boot while another holder exists, before creating pgdata", async () => {
    const dir = await makeDataDir();
    const claim = await acquireDataDirLock(dir, { role: "claim" });
    expect(claim.ok).toBe(true);

    await expect(boot(dir)).rejects.toThrow(/data directory is locked/);
    // The refusal is a BOOT gate: the database was never opened.
    expect(existsSync(path.join(dir, "pgdata"))).toBe(false);

    if (claim.ok) await claim.lock.release();
  });

  it("records role server in the holder file while booted", async () => {
    const dir = await makeDataDir();
    const server = await boot(dir);
    servers.push(server);

    const holder = JSON.parse(await readFile(dataDirLockPath(dir), "utf8")) as Record<string, unknown>;
    expect(holder.role).toBe("server");
    expect(holder.pid).toBe(process.pid);
  });

  it("releases the lock when the DB handle closes, and the same dataDir can be booted again", async () => {
    const dir = await makeDataDir();
    const first = await boot(dir);
    const lockPath = dataDirLockPath(dir);
    expect(existsSync(lockPath)).toBe(true);

    await closeDb(first.handle);
    expect(existsSync(lockPath)).toBe(false);

    // The restart shape: a second boot of the SAME dataDir must succeed.
    const second = await boot(dir);
    servers.push(second);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("gives the lock back when boot fails after acquiring it", async () => {
    const dir = await makeDataDir();
    // A file where the pgdata directory belongs: PGlite open fails AFTER the
    // lock was taken, so the failure path itself must release it.
    await writeFile(path.join(dir, "pgdata"), "a file, not a dir");

    await expect(boot(dir)).rejects.toThrow();
    expect(existsSync(dataDirLockPath(dir))).toBe(false);
  });
});
