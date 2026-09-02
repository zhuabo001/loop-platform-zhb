/**
 * The Task File resolver / snapshotter (Phase 4 Batch 2, plan §2.2,
 * ADR-009 修订 9): the daemon-side half of the task-file sync contract.
 *
 * Path rules:
 *  - absolute paths resolve directly; relative paths resolve against the
 *    run's CANONICAL cwd (the resolved workdir, or the per-run scratch dir
 *    when the loop has no workdir); an exact `~`/`~/...` expands against
 *    the agent env's HOME — any other `~name` is an ordinary relative path;
 *  - the canonical target (realpath of the alias) must sit inside the
 *    effective roots or the scratch cwd and be a regular, readable file;
 *  - pre-spawn, the alias and its canonical target are re-verified — ANY
 *    drift refuses the spawn;
 *  - post-run, only the SAME canonical path is re-read: alias repointing,
 *    a symlink-swapped target, jail escape or any path drift classifies as
 *    `changed`; an atomic same-path replacement of a regular file is legal.
 *
 * The sync read is fd-based (review SPEC-2/ADV-2): the canonical path is
 * opened ONCE with O_NOFOLLOW (bounded-read.ts) — a terminal symlink swap
 * between check and use gets ELOOP instead of the jail-escaped target — and
 * verified by dev/ino after the read. Documented residual: an INTERMEDIATE
 * directory component swapped between realpath and open is out of Node's
 * cross-platform reach; the post-read realpath re-check narrows that window
 * to mid-read timing.
 *
 * Failure classification is the protocol's stable sync set (missing /
 * unreadable / outside_jail / changed / too_large) plus the daemon-local
 * preflight refusal for an unconfigured legacy loop. A file containing NUL
 * bytes, invalid UTF-8 or a known provider/proxy secret is `unreadable`;
 * over 256 KiB is `too_large`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { TASK_FILE_CONTENT_MAX_UTF8_BYTES, type TaskFileSyncError } from "@loopzhb/protocol";

import { readRegularFileNoFollow } from "./bounded-read.js";
import { containsProtectedSecretForm } from "./agent-env.js";
import { isWithinOrEqual, type ResolvedWorkdir } from "./jail.js";

/** The daemon-local refusal for a v1 run whose loop never configured a task
 *  file (ADR-009 修订 9: legacy loops close out with this preflight failure
 *  instead of claiming a Claude spawn). */
export const TASK_FILE_NOT_CONFIGURED_ERROR = "task file not configured";

export interface ResolvedTaskFile {
  /** The operator-configured path after `~`/relative expansion (pre-realpath). */
  aliasPath: string;
  /** The realpath'd target — the ONLY path the prompt names and the sync re-reads. */
  canonicalPath: string;
  /** The containment set the canonical path was validated against. */
  allowedRoots: readonly string[];
}

export type TaskFileResolution =
  | { kind: "ok"; file: ResolvedTaskFile }
  | { kind: "not_configured" }
  | { kind: "error"; error: TaskFileSyncError };

/** Pure path expansion (plan §2.2's resolution order). Exported for tests. */
export function expandTaskFilePath(taskFile: string, canonicalCwd: string, homeDir: string | undefined): string {
  if ((taskFile === "~" || taskFile.startsWith("~/")) && homeDir !== undefined && homeDir !== "") {
    return path.join(homeDir, taskFile.slice(1));
  }
  if (path.isAbsolute(taskFile)) return taskFile;
  return path.resolve(canonicalCwd, taskFile);
}

/** The containment set for a task-file target: the effective roots, plus the
 *  canonical cwd so a scratch-cwd run can name a file inside its scratch. */
function taskFileRoots(resolved: ResolvedWorkdir): string[] {
  return [...new Set([...resolved.effectiveRoots, resolved.cwd])];
}

/** Resolve + fully validate the task file at claim time. Every rejection is
 *  one of the stable sync classifications — preflight callers fail the run
 *  WITHOUT spawning Claude. */
export async function resolveTaskFile(input: {
  taskFile: string | null;
  resolved: ResolvedWorkdir;
  homeDir: string | undefined;
}): Promise<TaskFileResolution> {
  if (input.taskFile === null || input.taskFile === "") return { kind: "not_configured" };
  const aliasPath = expandTaskFilePath(input.taskFile, input.resolved.cwd, input.homeDir);
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(aliasPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: "error", error: code === "EACCES" || code === "EPERM" ? "unreadable" : "missing" };
  }
  const allowedRoots = taskFileRoots(input.resolved);
  if (!allowedRoots.some((root) => isWithinOrEqual(root, canonicalPath))) {
    return { kind: "error", error: "outside_jail" };
  }
  let stat;
  try {
    stat = await fs.lstat(canonicalPath);
  } catch {
    return { kind: "error", error: "missing" };
  }
  // A symlink AT the canonical path (swapped in after the realpath) is not a
  // usable regular file — never follow it (review SPEC-2).
  if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "error", error: "missing" };
  try {
    await fs.access(canonicalPath, fs.constants.R_OK);
  } catch {
    return { kind: "error", error: "unreadable" };
  }
  return { kind: "ok", file: { aliasPath, canonicalPath, allowedRoots } };
}

/** Thrown when the pre-spawn re-verification observes drift — like the
 *  jail's revalidate, any drift means NO spawn. */
export class TaskFileDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFileDriftError";
  }
}

/** The spawn-time re-check (plan §2.2): the alias must still realpath to the
 *  recorded canonical target, which must still be a regular readable file
 *  inside the original containment set. */
export async function revalidateTaskFile(file: ResolvedTaskFile): Promise<void> {
  let real: string;
  try {
    real = await fs.realpath(file.aliasPath);
  } catch {
    throw new TaskFileDriftError("task file alias vanished before spawn");
  }
  if (real !== file.canonicalPath) {
    throw new TaskFileDriftError("task file alias moved before spawn");
  }
  if (!file.allowedRoots.some((root) => isWithinOrEqual(root, real))) {
    throw new TaskFileDriftError("task file escaped its roots before spawn");
  }
  let stat;
  try {
    stat = await fs.lstat(real);
  } catch {
    throw new TaskFileDriftError("task file vanished before spawn");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TaskFileDriftError("task file is no longer a regular file before spawn");
  }
  await fs.access(real, fs.constants.R_OK).catch(() => {
    throw new TaskFileDriftError("task file became unreadable before spawn");
  });
}

export type TaskFileSnapshot = { kind: "content"; content: string } | { kind: "error"; error: TaskFileSyncError };

/** The post-run sync read (plan §2.2): re-verify the SAME canonical path,
 *  then read and classify it. `secretValues` are the agent env's
 *  provider/proxy secrets — a task file containing one is `unreadable` and
 *  its content never leaves the machine. */
export async function snapshotTaskFile(
  file: ResolvedTaskFile,
  secretValues: readonly string[],
  io?: { open?: typeof fs.open }, // TEST-ONLY seam (spawnImpl precedent)
): Promise<TaskFileSnapshot> {
  // Drift first: the alias must still resolve, and still to the recorded
  // canonical target. A resolution that FAILS means the file is effectively
  // gone (missing); one that resolves ELSEWHERE is drift (changed).
  let real: string;
  try {
    real = await fs.realpath(file.aliasPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: "error", error: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "changed" };
  }
  if (real !== file.canonicalPath) return { kind: "error", error: "changed" };
  if (!file.allowedRoots.some((root) => isWithinOrEqual(root, real))) {
    return { kind: "error", error: "outside_jail" };
  }
  // The no-follow bounded read (review SPEC-2/ADV-2): ONE open of the
  // canonical path — a terminal symlink swap gets ELOOP (`changed`), the
  // size ceiling is enforced by fstat before any allocation, and the read
  // itself is capped.
  const read = await readRegularFileNoFollow(real, TASK_FILE_CONTENT_MAX_UTF8_BYTES, io?.open);
  if (read.kind === "not_found") return { kind: "error", error: "missing" };
  if (read.kind === "symlink") return { kind: "error", error: "changed" };
  if (read.kind === "not_regular") return { kind: "error", error: "missing" };
  if (read.kind === "too_large") return { kind: "error", error: "too_large" };
  if (read.kind === "unreadable") return { kind: "error", error: "unreadable" };
  // Post-read identity re-check: the entry at the canonical path must still
  // be the SAME regular file we read (a mid-read replacement is drift), and
  // the alias must still resolve to it.
  let after;
  try {
    after = await fs.lstat(real);
  } catch {
    return { kind: "error", error: "missing" };
  }
  if (after.isSymbolicLink() || !after.isFile()) return { kind: "error", error: "changed" };
  if (after.dev !== read.dev || after.ino !== read.ino) return { kind: "error", error: "changed" };
  try {
    if ((await fs.realpath(file.aliasPath)) !== real) return { kind: "error", error: "changed" };
  } catch {
    return { kind: "error", error: "missing" };
  }
  const bytes = read.bytes;
  if (bytes.includes(0)) return { kind: "error", error: "unreadable" };
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "error", error: "unreadable" };
  }
  if (containsProtectedSecretForm(content, secretValues)) return { kind: "error", error: "unreadable" };
  return { kind: "content", content };
}
