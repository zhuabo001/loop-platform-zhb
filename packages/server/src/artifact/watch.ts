/**
 * Poll watch planning — the artifact-watch configuration the daemon's
 * watcher keeps (ADR-010 决策 22, Batch 2 slice 2).
 *
 * The watch set is EVERY configured loop of the machine (`artifactDir` set;
 * paused and completed loops included — the plan's §1 rule) with the
 * machine's effective jail roots. The digest covers the CONFIGURATION only
 * (never file content), so a poll can cheaply detect drift: the server sends
 * the full set only when the daemon's digest differs.
 *
 * A request WITHOUT `watchDigest` means a daemon that has no watch state at
 * all — it is treated as carrying the EMPTY SET's digest, which keeps every
 * Batch 1 daemon's poll response byte-identical while a configured loop
 * still propagates on the next poll.
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { ArtifactWatchItem } from "@loopzhb/protocol";
import { watchConfigDigest } from "@loopzhb/protocol/node";

import type { Db } from "../db/index.js";
import { loops, type Machine } from "../db/schema.js";

/** The machine fields the watch set needs — nothing else. */
export type WatchMachine = Pick<Machine, "id" | "roots">;

/** Every configured loop of the machine, in stable `id` order. */
export async function readMachineWatchItems(db: Db, machine: WatchMachine): Promise<ArtifactWatchItem[]> {
  const roots = machine.roots ?? [];
  const rows = await db
    .select({
      id: loops.id,
      artifactDir: loops.artifactDir,
      workdir: loops.workdir,
      configRevision: loops.artifactConfigRevision,
    })
    .from(loops)
    .where(and(eq(loops.machineId, machine.id), isNotNull(loops.artifactDir)))
    .orderBy(asc(loops.id));
  return rows.flatMap((row) =>
    row.artifactDir === null
      ? [] // unreachable: the WHERE excludes NULLs; keeps the narrowing honest
      : [
          {
            loopId: row.id,
            artifactDir: row.artifactDir,
            workdir: row.workdir ?? null,
            roots,
            configRevision: row.configRevision,
          } satisfies ArtifactWatchItem,
        ],
  );
}

/**
 * The poll response's watch fields for one machine.
 *
 * Fixed rule: the daemon's effective digest is its request digest, or the
 * EMPTY set's digest when it sent none (decision 22). Equal digest ⇒ both
 * keys are ABSENT (no update needed); different ⇒ the complete set plus the
 * computed digest rides the response. `watch: []` is the legal clear-all
 * payload when the last configured loop disappears.
 */
export function planArtifactWatchResponse(
  items: readonly ArtifactWatchItem[],
  requestDigest: string | undefined,
): { watch?: ArtifactWatchItem[]; watchDigest?: string } {
  const digest = watchConfigDigest(items);
  const effectiveDigest = requestDigest ?? watchConfigDigest([]);
  if (effectiveDigest === digest) return {};
  return { watch: [...items], watchDigest: digest };
}
