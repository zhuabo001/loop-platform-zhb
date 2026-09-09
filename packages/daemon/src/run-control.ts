/**
 * The per-run control directory (Phase 4 Batch 2, plan §2.1, ADR-009 修订 8):
 * minted inside the daemon's control root for every terminal-protocol v1
 * run, 0700 throughout:
 *
 *   <controlRoot>/<run-hash>-<random>/
 *     context/prev-state.json   read-only (0400) compact JSON = the
 *                               Delivery's prevState — the ONE way a run
 *                               observes the previous successful state
 *     outbox/                   the journal's ONLY writable directory
 *
 * Release is fail-closed like the jail's scratch release: a swapped
 * (symlink / non-directory) control directory is refused, and a failed
 * release fails the run.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ControlRoot } from "./control-root.js";

export interface PreparedRunControl {
  controlDir: string;
  contextDir: string;
  outboxDir: string;
  prevStatePath: string;
}

export async function prepareRunControl(input: {
  controlRoot: ControlRoot;
  runId: string;
  prevState: unknown;
}): Promise<PreparedRunControl> {
  // Same minting discipline as the jail's scratch dirs: the hash is only a
  // prefix, mkdtemp's random suffix makes every run's directory fresh.
  const prefix = createHash("sha256").update(`run-control ${input.runId}`).digest("hex").slice(0, 16);
  const controlDir = await fs.mkdtemp(path.join(input.controlRoot.rootDir, `${prefix}-`));
  try {
    await fs.chmod(controlDir, 0o700);
    const contextDir = path.join(controlDir, "context");
    const outboxDir = path.join(controlDir, "outbox");
    await fs.mkdir(contextDir);
    await fs.chmod(contextDir, 0o700);
    await fs.mkdir(outboxDir);
    await fs.chmod(outboxDir, 0o700);
    const prevStatePath = path.join(contextDir, "prev-state.json");
    // Compact JSON, read-only. prevState originates from the server's jsonb
    // column, so it is always strict JSON; `?? null` covers the wire's
    // absent/undefined spellings.
    const compact = JSON.stringify(input.prevState ?? null) ?? "null";
    await fs.writeFile(prevStatePath, compact, { mode: 0o400 });
    await fs.chmod(prevStatePath, 0o400);
    return { controlDir, contextDir, outboxDir, prevStatePath };
  } catch (err) {
    await fs.rm(controlDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Fail-closed release: refuse a control dir that was swapped for a symlink
 *  or a non-directory (an agent could have raced us), never follow it. */
export async function releaseRunControl(controlDir: string): Promise<void> {
  const stat = await fs.lstat(controlDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`run control dir was replaced before release: ${JSON.stringify(controlDir)}`);
  }
  await fs.rm(controlDir, { recursive: true });
}
