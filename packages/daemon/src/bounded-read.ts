/**
 * Bounded no-follow file reads (Phase 4 Batch 2 review ADV-4 / SPEC-2 /
 * SPEC-4, ADR-009 修订): the single read discipline for every daemon path
 * that consumes an agent-influenceable file — the journal record, the task
 * file, the wrapper's *-file arguments.
 *
 *  - the file is opened ONCE with O_NOFOLLOW (a terminal-component symlink
 *    swap between check and use gets ELOOP, never the swapped target);
 *  - fstat on THAT handle proves a regular file and enforces the byte
 *    ceiling BEFORE any allocation sized by the attacker;
 *  - the read itself is bounded: a fixed maxBytes+1 buffer, never a
 *    readFile(path) whole-file allocation (a huge or sparse agent-written
 *    file must not OOM the daemon);
 *  - the caller compares the returned dev/ino with its own lstat when it
 *    needs check/use identity.
 *
 * Documented residual: O_NOFOLLOW guards only the terminal path component;
 * a swapped INTERMEDIATE directory between the caller's realpath and this
 * open is out of Node's cross-platform reach — callers mitigate with a
 * post-read realpath re-check (see task-file.ts). On Windows O_NOFOLLOW is
 * undefined and degrades to a plain open (dev/ino identity still checked);
 * this repo's CI is POSIX-only.
 */
import { promises as fs } from "node:fs";

export type BoundedRead =
  | { kind: "ok"; bytes: Buffer; dev: number; ino: number }
  | { kind: "symlink" } // O_NOFOLLOW refused a terminal-component symlink
  | { kind: "not_found" } // ENOENT/ENOTDIR at open
  | { kind: "not_regular" } // fstat says directory/FIFO/socket/…
  | { kind: "too_large" } // fstat.size over the ceiling, or the read crossed it
  | { kind: "unreadable" }; // any other IO failure

export async function readRegularFileNoFollow(
  filePath: string,
  maxBytes: number,
  openImpl: typeof fs.open = fs.open, // TEST-ONLY seam (spawnImpl precedent)
): Promise<BoundedRead> {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fs.FileHandle;
  try {
    handle = await openImpl(filePath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { kind: "symlink" };
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "not_found" };
    return { kind: "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "not_regular" };
    if (stat.size > maxBytes) return { kind: "too_large" };
    // Bounded read: the buffer caps at maxBytes+1 regardless of what the
    // file does between fstat and now (growth included).
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return { kind: "too_large" };
    }
    return { kind: "ok", bytes: buffer.subarray(0, total), dev: stat.dev, ino: stat.ino };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}
