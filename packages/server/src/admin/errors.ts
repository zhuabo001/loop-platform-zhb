import type { ArtifactConfigRejection } from "../artifact/config.js";

/** A declared field exceeded its server-side length ceiling (ADR-002 决策 4:
 *  caps are server policy, not wire shape). The HTTP adapter maps this to the
 *  unified 400 — same taxonomy slot as a schema rejection. */
export class LoopValidationError extends Error {
  constructor(readonly field: string) {
    super(`loop ${field} exceeds its length cap`);
    this.name = "LoopValidationError";
  }
}

/** Create's `artifactDir` failed the artifact config planner (ADR-010 决策 8,
 *  Batch 2 slice 2). Carries the planner's own rejection literal, so the same
 *  illegal value gets the same wire code on both endpoints (400
 *  `artifact_validation_failed`; exhaustion is unreachable at a fresh loop's
 *  generation 0 but maps identically if it ever were). */
export class ArtifactDirValidationError extends Error {
  constructor(readonly reason: ArtifactConfigRejection) {
    super(`loop artifactDir rejected: ${reason}`);
    this.name = "ArtifactDirValidationError";
  }
}
