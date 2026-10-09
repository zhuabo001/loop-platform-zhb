/**
 * `claim:legacy` — the offline claim command (ADR-011 决策 22). Pure with
 * respect to the process: it returns an exit code and writes through the
 * injected writers, so the same function backs the built entry point and the
 * tests. It NEVER calls `process.exit`.
 *
 * The ordering before the database is opened is the point:
 *   parse args → stat the dataDir (never create it) → take the dataDir lock →
 *   stat pgdata → open.
 * Every one of those steps can refuse without having touched the database, so
 * a claim against a typo'd path or a RUNNING server cannot corrupt anything.
 *
 * This command reads NO environment variable: an operator's shell has no
 * `LOOPZHB_GITHUB_CLIENT_ID`, and `loadServerConfig` (which requires the OAuth
 * triple) is deliberately not imported.
 */
import fs from "node:fs";
import path from "node:path";

import { createLocalBlobStore } from "../artifact/blob-store-local.js";
import type { BlobStore } from "../artifact/blob-store.js";
import { artifactBlobRoot } from "../artifact/production.js";
import {
  acquireDataDirLock,
  formatAcquireFailureMessage,
  formatDataDirLockedMessage,
  type DataDirLock,
} from "../data-dir-lock.js";
import { closeDb, openMigratedDb } from "../db/index.js";
import { systemClock, type Clock } from "../time.js";

import { applyClaim, type ApplyClaimOptions } from "./apply.js";
import { CLAIM_COMMAND, parseClaimArgs, USAGE } from "./args.js";
import { copyAndVerifyBlobs } from "./blobs.js";
import { planClaim, type ClaimPlan, type ClaimRefusal } from "./plan.js";

export interface ClaimDeps {
  clock?: Clock;
  /** TEST-ONLY override (injected failures, ENOSPC shapes). Defaults to the
   *  production local blob store over `<dataDir>/blobs`. */
  blobStore?: BlobStore;
  /** TEST-ONLY throw seam inside the claim transaction. */
  hooks?: ApplyClaimOptions["hooks"];
}

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_LOCKED = 3;

export async function runClaimLegacy(
  argv: readonly string[],
  _env: NodeJS.ProcessEnv,
  cwd: string,
  write: (text: string) => void = (text) => void process.stdout.write(text),
  writeError: (text: string) => void = (text) => void process.stderr.write(text),
  deps: ClaimDeps = {},
): Promise<number> {
  const clock = deps.clock ?? systemClock;

  const parsed = parseClaimArgs(argv, cwd);
  if (!parsed.ok) {
    if (parsed.failure === "help") {
      write(USAGE);
      return EXIT_OK;
    }
    writeError(`${CLAIM_COMMAND}: ${parsed.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const args = parsed.args;

  // The data directory must already exist: this command never creates one, so
  // a typo fails loudly instead of materialising an empty world.
  const dirStat = await fs.promises.stat(args.dataDir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory()) {
    writeError(`${refusalLine({ failure: "storage_error", detail: `data directory not found: ${args.dataDir}` })}\n`);
    return EXIT_REFUSED;
  }

  let lock: DataDirLock;
  const acquired = await acquireDataDirLock(args.dataDir, { role: "claim", clock });
  if (!acquired.ok) {
    writeError(`${acquired.failure === "locked" ? formatDataDirLockedMessage(acquired) : formatAcquireFailureMessage(acquired)}\n`);
    return acquired.failure === "locked" ? EXIT_LOCKED : EXIT_REFUSED;
  }
  lock = acquired.lock;

  // An uninitialised data dir would be MIGRATED into existence by the open
  // below and then report "target user missing", which reads like a data
  // problem instead of a wrong path.
  const pgdata = await fs.promises.stat(path.join(args.dataDir, "pgdata")).catch(() => null);
  if (pgdata === null) {
    await lock.release().catch(() => {});
    writeError(`${refusalLine({ failure: "storage_error", detail: `not a loopzhb data directory (no pgdata): ${args.dataDir}` })}\n`);
    return EXIT_REFUSED;
  }

  let handle;
  try {
    handle = await openMigratedDb({ dataDir: args.dataDir, dataDirLock: lock });
  } catch (err) {
    await lock.release().catch(() => {});
    writeError(`${refusalLine({ failure: "storage_error", detail: `cannot open the database: ${String(err)}` })}\n`);
    return EXIT_REFUSED;
  }

  try {
    const blobStore = deps.blobStore ?? createLocalBlobStore({ rootDir: artifactBlobRoot(args.dataDir) });

    const planned = await planClaim({
      db: handle.db,
      blobStore,
      dataDir: args.dataDir,
      githubUserId: args.githubUserId,
      machineIds: args.machineIds,
    });
    if (!planned.ok) {
      writeError(renderRefusal(planned.refusal));
      return EXIT_REFUSED;
    }
    const plan = planned.plan;

    if (args.dryRun) {
      write(renderDryRun(plan, args.machineIds.length));
      return EXIT_OK;
    }

    if (plan.toClaim.length === 0) {
      write(renderNoOp(plan));
      return EXIT_OK;
    }

    const copied = await copyAndVerifyBlobs(blobStore, {
      teamId: plan.teamId,
      hashes: plan.copyHashes,
      reuseHashes: plan.reuseHashes,
      expectedSize: plan.expectedSize,
      sourceNamespaceOf: plan.sourceNamespaceOf,
    });
    if (!copied.ok) {
      writeError(renderRefusal(copied.refusal));
      return EXIT_REFUSED;
    }

    const applied = await applyClaim({ db: handle.db, plan, clock, hooks: deps.hooks });
    if (!applied.ok) {
      writeError(renderRefusal(applied.refusal));
      return EXIT_REFUSED;
    }

    write(renderExecuted(plan, applied.outcome, copied.outcome));
    return EXIT_OK;
  } finally {
    // Releases the dataDir lock after the client closes (closeDb's order).
    await closeDb(handle).catch(() => {});
  }
}

// ---- report rendering (pure) -----------------------------------------------

function renderHeader(plan: ClaimPlan): string[] {
  return [`data dir : ${plan.dataDir}`, `account  : ${plan.userId} (${plan.username})`, `team     : ${plan.teamId} (${plan.teamName})`];
}

function renderMachineLine(machine: ClaimPlan["machines"][number]): string {
  const state = machine.alreadyClaimed ? "already claimed" : "to claim";
  return (
    `  ${machine.id}  ${state}  loops ${machine.loopCount}  runs ${machine.runCount} (pending ${machine.pendingRunCount})` +
    `  manifests ${machine.manifestCount}  sessions ${machine.sessionCount} (committed ${machine.committedSessionCount})` +
    `  blobs ${machine.blobRowCount}`
  );
}

function renderWarnings(plan: ClaimPlan): string[] {
  const pending = plan.machines.reduce((sum, m) => sum + m.pendingRunCount, 0);
  if (pending === 0) return [];
  return [`warnings : ${pending} pending Run(s) will become claimable after the claim`];
}

export function renderDryRun(plan: ClaimPlan, selected: number): string {
  return (
    [
      `${CLAIM_COMMAND} — DRY RUN (nothing was copied, no data was changed)`,
      ...renderHeader(plan),
      `machines : ${selected} selected — ${plan.alreadyClaimed.length} already claimed, ${plan.toClaim.length} to claim`,
      ...plan.machines.map(renderMachineLine),
      `blobs    : ${plan.copyHashes.length + plan.reuseHashes.length} unique hashes — ${plan.copyHashes.length} to copy (${plan.copyBytes} bytes), ${plan.reuseHashes.length} already present (${plan.reuseBytes} bytes)`,
      ...renderWarnings(plan),
      "",
    ].join("\n")
  );
}

export function renderNoOp(plan: ClaimPlan): string {
  return (
    `${CLAIM_COMMAND} — no-op: all ${plan.alreadyClaimed.length} selected machine(s) are already claimed by ` +
    `${plan.teamId} (${plan.teamName}). Nothing to do.\n`
  );
}

export function renderExecuted(
  plan: ClaimPlan,
  outcome: { machinesClaimed: number; manifests: number; sessions: number; blobRowsInserted: number },
  copy: { copied: number; copiedBytes: number; reused: number },
): string {
  return (
    [
      `${CLAIM_COMMAND} — claiming ${plan.toClaim.length} machine(s) into ${plan.teamId} (${plan.teamName})`,
      ...renderHeader(plan),
      `copied   : ${copy.copied} blob(s), ${copy.copiedBytes} bytes (${copy.reused} already present and verified)`,
      `committed: ${outcome.machinesClaimed} machine(s), ${outcome.manifests} manifest(s), ${outcome.sessions} session(s), ${outcome.blobRowsInserted} blob row(s) inserted`,
      ...renderWarnings(plan),
      "done: source blobs and source metadata were kept; no GC. The Daemon may be restarted.",
      "",
    ].join("\n")
  );
}

/** Fixed operator hints. The code is the greppable part; the hint is what an
 *  operator reads at 03:00. */
const REFUSAL_HINT: Record<ClaimRefusal["failure"], string> = {
  target_user_missing: "no user has logged in with that GitHub id; this command never creates accounts.",
  target_team_missing: "the user has no personal team yet; have them log in once at /login.",
  target_team_namespace_invalid: "the user's team id is not a usable storage namespace.",
  target_membership_missing: "the user's personal team is missing its owner membership.",
  machine_missing: "no machine with that id exists in this data directory.",
  machine_revoked: "the machine is revoked; revocation is terminal in this batch.",
  machine_owned_by_other_team: "the machine already belongs to another team; the WHOLE selection was refused.",
  machine_run_active: "a run is executing on this machine — finish it and stop the Daemon, then retry.",
  chain_inconsistent: "the stored Artifact history is inconsistent; nothing was changed.",
  source_blob_missing: "a referenced source blob file is missing; restore it from backup before claiming.",
  source_blob_corrupt: "a source blob's bytes do not match its verified metadata; restore it from backup.",
  target_blob_corrupt: "a blob already in the team namespace failed verification — it was NOT overwritten.",
  storage_error: "an I/O failure occurred; nothing was changed.",
  claim_guard_lost: "the database changed while planning; re-run the command.",
  claim_transaction_failed: "the transaction rolled back; nothing was changed. Re-running is safe.",
};

export function renderRefusal(refusal: ClaimRefusal): string {
  return `${refusalLine(refusal)}\n  ${REFUSAL_HINT[refusal.failure]}\n`;
}

function refusalLine(refusal: ClaimRefusal): string {
  const scope: string[] = [];
  if (refusal.machineId !== undefined) scope.push(`machine ${refusal.machineId}`);
  if (refusal.hash !== undefined) scope.push(`blob ${refusal.hash}`);
  if (refusal.subject !== undefined) scope.push(`row ${refusal.subject}`);
  if (refusal.detail !== undefined) scope.push(refusal.detail);
  return `${CLAIM_COMMAND} refused: ${refusal.failure}${scope.length > 0 ? ` (${scope.join(", ")})` : ""}`;
}
