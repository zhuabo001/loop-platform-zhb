/**
 * JSON value/object wire shapes for Phase 4 terminal state (ADR-009 决策 6).
 *
 * The schema pins SHAPE only (ADR-002 决策 4): the top level must be a JSON
 * object whose values are JSON values. VALUE policy — the 64 KiB compact
 * UTF-8 ceiling, stack-safe deep validation — lives in `terminal-policy.ts`,
 * the narrow exception both peers execute identically.
 */
import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Recursive JSON value: string | number | boolean | null | array | object. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A top-level JSON object (arrays/null/scalars are NOT valid state). */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
