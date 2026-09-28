/**
 * Artifact config — the DB write path for a loop's `artifactDir`
 * (ADR-010 决策 8, Phase 5 Batch 1 slice 2).
 *
 * This is an INTERNAL write path: the ArtifactHome state machine (slice 4)
 * and the Batch 2 admin route call it; Batch 1 wires it from TESTS ONLY — no
 * production route, no composition (决策 16). The pure planner decides WHAT
 * to write; `updateArtifactConfig` owns the resolve, the guarded write and
 * the bounded re-resolve, exactly on the loop-lifecycle ops template
 * (updateGoal/updateTaskFile).
 *
 * Generation semantics (决策 8): an effective set/change/clear increments
 * `artifactConfigRevision`, clears the previous generation's sync-attempt
 * state, and KEEPS the old manifest pointer — the current view's staleness
 * is computed from the generations at READ time (`readCurrentArtifactView`),
 * never by nulling the pointer. An equal-value update is a strict no-op:
 * zero writes, `updatedAt` and the OCC `revision` untouched.
 *
 * The server never resolves the machine-side path (决策 8): the only
 * server-side policy is that a RELATIVE dir (not `/`-prefixed) requires the
 * loop to have an explicit `workdir` — without one the dir must be absolute.
 * Empty/NUL-containing strings are rejected defensively (the wire schema's
 * `nulFreeString().min(1)` already blocks them at HTTP; internal callers
 * bypass HTTP).
 */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { artifactManifests, loops, type ArtifactManifestRow, type Loop } from "../db/schema.js";
import { REVISION_INT32_MAX } from "../schedule/transition.js";
import { withGuardRetry } from "../store/guard-retry.js";
import type { Clock } from "../time.js";

// ---- pure planner (no DB, no clock — the caller passes nowIso) ----

/** The three loop fields the planner may consult — nothing else. */
export interface ArtifactConfigSnapshot {
  artifactDir: string | null;
  artifactConfigRevision: number;
  /** The loop's machine-side cwd; a relative artifactDir resolves against it
   *  on the machine, so without one a relative dir is meaningless. */
  workdir: string | null;
}

export type ArtifactConfigRejection =
  /** Empty or NUL-containing. */
  | "artifact_dir_invalid"
  /** A relative dir with no loop workdir to resolve against (决策 8). */
  | "artifact_dir_relative_without_workdir"
  /** The generation counter is at the int32 ceiling — stable rejection, zero
   *  writes (plan §2 revision rules; wire mapping is Batch 2's, see the ADR
   *  revision log). */
  | "config_revision_exhausted";

export interface ArtifactConfigPatch {
  artifactDir: string | null;
  artifactConfigRevision: number;
  /** A config change clears the PREVIOUS generation's sync-attempt state
   *  (决策 8) — a stale error/success stamp can never be mistaken for the new
   *  generation's (the updateTaskFile sync-snapshot precedent). */
  artifactSyncAttemptedAt: null;
  artifactSyncSucceededAt: null;
  artifactSyncError: null;
  updatedAt: string;
}

export type ArtifactConfigPlan =
  | { kind: "noop" }
  | { kind: "rejected"; reason: ArtifactConfigRejection }
  | { kind: "changed"; writes: ArtifactConfigPatch };

/**
 * Fixed evaluation order: **validate → noop → exhaustion**. Validation first
 * means an invalid value rejects even when it equals the stored one (a
 * degenerate stored value can never launder an invalid command into a noop);
 * noop before exhaustion means an equal-value command at the int32 ceiling
 * still writes nothing instead of failing (the planGoalUpdate order).
 *
 * The manifest pointer (`artifactManifestId`/`artifactManifestRevision`) is
 * NEVER in the patch — the old view survives a config change and is marked
 * stale by generation at read time (决策 8).
 */
export function planArtifactConfigUpdate(
  snapshot: ArtifactConfigSnapshot,
  command: { artifactDir: string | null },
  nowIso: string,
): ArtifactConfigPlan {
  const dir = command.artifactDir;
  if (dir !== null) {
    if (dir.length === 0 || dir.includes("\0")) return { kind: "rejected", reason: "artifact_dir_invalid" };
    if (!dir.startsWith("/") && !snapshot.workdir) {
      return { kind: "rejected", reason: "artifact_dir_relative_without_workdir" };
    }
  }
  if (dir === snapshot.artifactDir) return { kind: "noop" };
  if (snapshot.artifactConfigRevision >= REVISION_INT32_MAX) {
    return { kind: "rejected", reason: "config_revision_exhausted" };
  }
  return {
    kind: "changed",
    writes: {
      artifactDir: dir,
      artifactConfigRevision: snapshot.artifactConfigRevision + 1,
      artifactSyncAttemptedAt: null,
      artifactSyncSucceededAt: null,
      artifactSyncError: null,
      updatedAt: nowIso,
    },
  };
}

// ---- DB adapter (updateGoal template: resolve → plan → guarded write) ----

export interface ArtifactConfigStoreDeps {
  db: Db;
  clock: Clock;
  /** TEST-ONLY seam (the LifecycleOpsHooks precedent): fires between the
   *  pre-transaction resolve and the guarded write, letting a test commit a
   *  REAL competing transaction on the single PGlite connection. */
  hooks?: { afterResolve?(loopId: string): void | Promise<void> };
}

export type UpdateArtifactConfigResult =
  | { ok: true; outcome: "noop" | "changed"; loop: Loop }
  | { ok: false; failure: "loop_not_found" | ArtifactConfigRejection };

/** A guarded write observed zero rows — a competitor committed between the
 *  resolve and the write. Internal: `withGuardRetry` re-runs the whole
 *  resolve+plan+write once on fresh state. */
class ArtifactConfigGuardLostError extends Error {
  constructor(readonly loopId: string) {
    super(`artifact config guard lost for loop ${loopId}`);
    this.name = "ArtifactConfigGuardLostError";
  }
}

/** The guard lost AGAIN on the single bounded re-resolve — the row is still
 *  moving. Surfaces as a retryable-500-grade exception, never a domain
 *  result; no partial state was ever committed (LifecycleRaceLostError
 *  precedent). */
export class ArtifactConfigRaceLostError extends Error {
  constructor(readonly loopId: string) {
    super(`artifact config guard did not settle for loop ${loopId}`);
    this.name = "ArtifactConfigRaceLostError";
  }
}

/**
 * Set/change/clear a loop's artifact directory. The guarded UPDATE keys on
 * the resolved row's unified OCC `revision`, so NO concurrent loops write (a
 * goal change, a claim bump, a schedule edit, …) can ever be silently
 * overwritten — and a write planned from config generation N can never land
 * on generation N+1 without re-planning (AM6's old-generation evidence at
 * the CAS level; the session half is slice 4's). `scheduleRevision` and
 * `goalRevision` keep their own semantics and are untouched.
 */
export async function updateArtifactConfig(
  deps: ArtifactConfigStoreDeps,
  loopId: string,
  command: { artifactDir: string | null },
): Promise<UpdateArtifactConfigResult> {
  return withGuardRetry(
    async (): Promise<UpdateArtifactConfigResult> => {
      const resolved = (await deps.db.select().from(loops).where(eq(loops.id, loopId)).limit(1))[0];
      if (!resolved) return { ok: false, failure: "loop_not_found" };
      await deps.hooks?.afterResolve?.(loopId);
      const plan = planArtifactConfigUpdate(resolved, command, deps.clock.now().toISOString());
      if (plan.kind === "noop") return { ok: true, outcome: "noop", loop: resolved };
      if (plan.kind === "rejected") return { ok: false, failure: plan.reason };
      return deps.db.transaction(async (tx): Promise<UpdateArtifactConfigResult> => {
        const updated = await tx
          .update(loops)
          .set({ ...plan.writes, revision: sql`${loops.revision} + 1` })
          .where(and(eq(loops.id, loopId), eq(loops.revision, resolved.revision)))
          .returning();
        if (updated.length !== 1) throw new ArtifactConfigGuardLostError(loopId);
        return { ok: true, outcome: "changed", loop: updated[0]! };
      });
    },
    (err) => err instanceof ArtifactConfigGuardLostError,
    (err) => new ArtifactConfigRaceLostError((err as ArtifactConfigGuardLostError).loopId),
  );
}

// ---- current-view read (决策 8: pointer kept, staleness by generation) ----

export interface ArtifactCurrentView {
  artifactDir: string | null;
  configRevision: number;
  manifestRevision: number;
  manifestId: string | null;
  /** The pointed-at manifest row; null when nothing was ever committed. */
  manifest: ArtifactManifestRow | null;
  /** true ⇔ a manifest is pointed at AND it committed under a DIFFERENT
   *  config generation than the loop's current one (决策 8: 保留旧 manifest
   *  指针，读取时按配置代际计算过期状态). */
  stale: boolean;
}

/** Read the loop's current artifact view. `undefined` = loop not found. A
 *  dangling pointer (no FK, by convention — possible only via out-of-band
 *  damage) yields `manifest: null, stale: false`. */
export async function readCurrentArtifactView(db: Db, loopId: string): Promise<ArtifactCurrentView | undefined> {
  const loop = (await db.select().from(loops).where(eq(loops.id, loopId)).limit(1))[0];
  if (!loop) return undefined;
  const manifest = loop.artifactManifestId
    ? ((await db.select().from(artifactManifests).where(eq(artifactManifests.id, loop.artifactManifestId)).limit(1))[0] ??
      null)
    : null;
  return {
    artifactDir: loop.artifactDir,
    configRevision: loop.artifactConfigRevision,
    manifestRevision: loop.artifactManifestRevision,
    manifestId: loop.artifactManifestId,
    manifest,
    stale: manifest !== null && manifest.configRevision !== loop.artifactConfigRevision,
  };
}
