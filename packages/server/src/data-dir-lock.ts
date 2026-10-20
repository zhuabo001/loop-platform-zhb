/**
 * dataDir exclusive lock (ADR-011 决策 20) — the ONE mutex over a data
 * directory. Two processes must never open the same `<dataDir>/pgdata`.
 *
 * Why this module exists at all: `@electric-sql/pglite@0.5.4` protects a
 * database handle with an IN-PROCESS async mutex only. It takes no
 * cross-process filesystem lock, so nothing else stops a `claim:legacy` run
 * from rewriting a live server's rows. This lock is the whole mutex, not a
 * second line of defence.
 *
 * Contract:
 *  - Path `<dataDir>/data-dir.lock`, acquired with `open(path, "wx", 0o600)` —
 *    the atomic test-and-set. EEXIST means "someone holds it"; we NEVER take it
 *    over (a PID-liveness probe is unsound under PID reuse, and the batch rule
 *    is 不自动抢占锁). The holder record exists to be PRINTED, never to make a
 *    decision.
 *  - Release is idempotent and inode-guarded: the documented recovery for a
 *    crashed holder is an operator's manual `rm`, which can race with the live
 *    holder's release. Comparing `fstat(handle)` against `lstat(path)` on
 *    `dev`+`ino` keeps us from unlinking a file someone else re-created.
 *  - SIGKILL leaves a stale lock and boot then refuses until an operator
 *    removes it. That is the documented contract (决策 20), not a defect.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { systemClock, type Clock } from "./time.js";

/** The lock file name under dataDir. Exported so tests and the ops text agree. */
export const DATA_DIR_LOCK_FILENAME = "data-dir.lock";

export function dataDirLockPath(dataDir: string): string {
  return path.join(dataDir, DATA_DIR_LOCK_FILENAME);
}

export type DataDirLockRole = "server" | "claim";

/** The holder record, written as one JSON line. Printed for the operator only —
 *  no code path branches on it. */
export interface DataDirLockInfo {
  pid: number;
  hostname: string;
  role: DataDirLockRole;
  startedAt: string;
  /** The server package version that took the lock, best-effort. */
  version: string;
}

export interface DataDirLock {
  readonly path: string;
  readonly info: DataDirLockInfo;
  /** Idempotent. Closes the descriptor, then unlinks ONLY if the path still
   *  names this lock's inode. */
  release(): Promise<void>;
}

export type AcquireDataDirLockResult =
  | { ok: true; lock: DataDirLock }
  /** Another process holds it. `holder` is null when the file is unreadable or
   *  malformed — a truncated lock is still a lock. */
  | { ok: false; failure: "locked"; path: string; holder: DataDirLockInfo | null }
  /** Any other I/O failure (permissions, missing parent, short write). */
  | { ok: false; failure: "storage_error"; path: string; cause?: unknown };

/** Best-effort package version: resolves from EITHER src/ (vitest) or dist/ —
 *  both sit one level below the package root. Never fatal. */
function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.resolve(here, "../package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const PACKAGE_VERSION = readPackageVersion();

function isErrnoWithCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function parseHolder(raw: string): DataDirLockInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DataDirLockInfo>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      (parsed.role !== "server" && parsed.role !== "claim") ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      hostname: parsed.hostname,
      role: parsed.role,
      startedAt: parsed.startedAt,
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
    };
  } catch {
    return null;
  }
}

/**
 * Acquire the dataDir lock. The caller MUST already have created `dataDir`;
 * this function never creates it (a claim against a typo'd path must fail, not
 * silently materialise a directory).
 */
export async function acquireDataDirLock(
  dataDir: string,
  options: { role: DataDirLockRole; clock?: Clock },
): Promise<AcquireDataDirLockResult> {
  const clock = options.clock ?? systemClock;
  const lockPath = dataDirLockPath(dataDir);

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, "wx", 0o600);
  } catch (err) {
    if (isErrnoWithCode(err, "EEXIST")) {
      const raw = await fs.promises.readFile(lockPath, "utf8").catch(() => null);
      return { ok: false, failure: "locked", path: lockPath, holder: raw === null ? null : parseHolder(raw) };
    }
    return { ok: false, failure: "storage_error", path: lockPath, cause: err };
  }

  const info: DataDirLockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    role: options.role,
    startedAt: clock.now().toISOString(),
    version: PACKAGE_VERSION,
  };

  try {
    await handle.writeFile(`${JSON.stringify(info)}\n`, "utf8");
  } catch (err) {
    // A held-but-unrecorded lock is worse than no lock: undo it.
    await handle.close().catch(() => {});
    await fs.promises.unlink(lockPath).catch(() => {});
    return { ok: false, failure: "storage_error", path: lockPath, cause: err };
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    const own = await handle.stat().catch(() => null);
    const atPath = await fs.promises.lstat(lockPath).catch(() => null);
    await handle.close().catch(() => {});
    if (own === null || atPath === null) return;
    if (own.dev !== atPath.dev || own.ino !== atPath.ino) return; // swapped out from under us
    await fs.promises.unlink(lockPath).catch(() => {});
  };

  return { ok: true, lock: { path: lockPath, info, release } };
}

/** Boot gate: the data directory could not be locked, so the process must not
 *  open the database. Thrown by `bootstrapServer`; the claim CLI reports the
 *  same condition as its own exit code. */
export class DataDirLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirLockError";
  }
}

/** Operator-facing text for either acquisition failure. */
export function formatAcquireFailureMessage(result: Extract<AcquireDataDirLockResult, { ok: false }>): string {
  if (result.failure === "locked") return formatDataDirLockedMessage(result);
  return `cannot acquire the data directory lock at ${result.path}: ${String(result.cause)}`;
}

/** The fixed refusal text. Tests and the ops notes pin it, so keep the wording
 *  stable: it must always name the path and the manual recovery command. */
export function formatDataDirLockedMessage(
  result: Extract<AcquireDataDirLockResult, { ok: false; failure: "locked" }>,
): string {
  const lines = [`data directory is locked: ${result.path}`];
  if (result.holder !== null) {
    const h = result.holder;
    lines.push(`  held by pid ${h.pid} on ${h.hostname} (role: ${h.role}) since ${h.startedAt}`);
  } else {
    lines.push("  the holder record is missing or unreadable");
  }
  lines.push(
    "Stop the server (and any other claim run) before continuing.",
    "This lock is never taken over automatically. If the holder crashed, confirm",
    "that no process is using the data directory, then remove the file:",
    `  rm ${result.path}`,
  );
  return lines.join("\n");
}
