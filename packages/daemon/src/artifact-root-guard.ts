/**
 * Artifact-root never-sync guard (Phase 5 Batch 2 slice 5, ADR-010 决策 25,
 * [#91]): the slice-3 scanner deliberately does not look at the ROOT itself —
 * shared policy only sees relative manifest paths — so a loop configured with
 * an artifactDir inside a never-sync region (`.config/gcloud`, `~/.ssh`, a
 * path whose ancestor or root-symlink landing point is one) would otherwise
 * have its relative entries accepted by BOTH sides. This guard closes that at
 * the two places that can start production sync:
 *
 *  - the slice-4 sync client's attempt (`syncLoop`), after root resolution and
 *    before the scan — structural protection for EVERY caller, including
 *    slice 6's final sync;
 *  - the WatchManager's admission — a sensitive root is never subscribed to
 *    nor enumerated.
 *
 * The predicate is protocol's `isNeverSyncDirectoryPath` — the single source
 * of the directory-rule window matching. Only DIRECTORY rules apply here: the
 * root is a directory, so a folder merely named `credentials` stays legal.
 *
 * An unresolvable root (missing, permission-denied, race) is NOT a refusal:
 * the scan owns that closed failure class (`directory_missing` /
 * `unreadable`), and refusing here would misreport it.
 */
import { promises as fs } from "node:fs";

import { isNeverSyncDirectoryPath } from "@loopzhb/protocol";

export interface ArtifactRootGuardIo {
  /** TEST-ONLY seam (mirrors the scanner's io seams). */
  realpath?: (path: string) => Promise<string>;
}

export type ArtifactRootGuardVerdict = { kind: "ok" } | { kind: "refused"; detail: string };

/** Follow the root through EVERY path component (so an ancestor or a root
 *  symlink landing inside a never-sync region is caught, not just a matching
 *  final segment), then apply the directory-rule window match. */
export async function guardArtifactRoot(
  root: string,
  io: ArtifactRootGuardIo = {},
): Promise<ArtifactRootGuardVerdict> {
  const realpath = io.realpath ?? ((target: string): Promise<string> => fs.realpath(target));
  let landed: string;
  try {
    landed = await realpath(root);
  } catch {
    return { kind: "ok" };
  }
  if (!isNeverSyncDirectoryPath(landed)) return { kind: "ok" };
  return { kind: "refused", detail: `artifact root resolves into a never-sync directory: ${landed}` };
}
