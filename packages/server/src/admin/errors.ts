/** A declared field exceeded its server-side length ceiling (ADR-002 决策 4:
 *  caps are server policy, not wire shape). The HTTP adapter maps this to the
 *  unified 400 — same taxonomy slot as a schema rejection. */
export class LoopValidationError extends Error {
  constructor(readonly field: string) {
    super(`loop ${field} exceeds its length cap`);
    this.name = "LoopValidationError";
  }
}
