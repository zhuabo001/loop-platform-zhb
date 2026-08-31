/**
 * JSON value/object wire shapes for Phase 4 terminal state (ADR-009 决策 6).
 *
 * The schema pins SHAPE only (ADR-002 决策 4), and it does so STACK-SAFELY
 * (review SP-1): a recursive `z.lazy` schema threw `RangeError` on
 * pathologically deep input, escaping `safeParse` as an uncategorized 500
 * before any policy could run. The wire layer now checks only the top-level
 * object shape non-recursively and delegates nested legality to the iterative
 * `isStrictJsonValue`; the 64 KiB ceiling and database-writability rules stay
 * in `terminal-policy.ts`, the narrow exception both peers execute identically.
 */
import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Stack-safe, TOTAL strict JSON-value check: rejects `undefined`, functions,
 * symbols, bigints, non-finite numbers and exotic object prototypes — values
 * that `JSON.stringify` would silently drop or mangle.
 *
 * Totality: the guarded serialization turns pathological depth (RangeError)
 * and cycles (TypeError) into `false`, and the explicit-stack walk never
 * recurses. Getter/Proxy traps throwing mid-walk land in the same catch — any
 * traversal or serialization exception is a rejection, never an escape
 * (ADR-009 决策 6; review A-3).
 */
export function isStrictJsonValue(root: unknown): boolean {
  try {
    if (typeof JSON.stringify(root) !== "string") return false;
    const stack: unknown[] = [root];
    while (stack.length > 0) {
      const value = stack.pop();
      if (value === null) continue;
      switch (typeof value) {
        case "string":
        case "boolean":
          continue;
        case "number":
          if (!Number.isFinite(value)) return false;
          continue;
        case "object": {
          if (Array.isArray(value)) {
            for (const item of value) stack.push(item);
            continue;
          }
          const proto: unknown = Object.getPrototypeOf(value);
          if (proto !== null && proto !== Object.prototype) return false;
          for (const key of Object.keys(value)) {
            stack.push((value as Record<string, unknown>)[key]);
          }
          continue;
        }
        default:
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A top-level JSON object (arrays/null/scalars are NOT valid state). The zod
 * layer is NON-RECURSIVE (top-level shape only); nested legality rides the
 * stack-safe `isStrictJsonValue` superRefine, so a deep or cyclic body
 * degrades to a stable schema rejection (HTTP 400, lease untouched) instead
 * of a `RangeError` (review SP-1). Value policy — the 64 KiB compact ceiling
 * and PostgreSQL writability — is deliberately NOT here: it lives in
 * `terminal-policy.ts` and runs in the domain layer.
 *
 * The base schema is `z.unknown()`, NOT `z.record(...)` (review SP2-1): a
 * record REBUILDS the object by ordinary assignment, and assigning a
 * `__proto__` key sets the prototype instead of an own property — a legal
 * state like `{"__proto__":{...},"keep":2}` would parse successfully with the
 * key silently DELETED, corrupting the state the Loop later promotes. The
 * identity passthrough never rebuilds keys, so every own property of the
 * parsed JSON survives verbatim.
 */
export const jsonObjectSchema: z.ZodType<JsonObject> = z
  .unknown()
  .superRefine((value, ctx) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "must be a top-level JSON object" });
      return;
    }
    if (!isStrictJsonValue(value)) {
      ctx.addIssue({ code: "custom", message: "must be a strict JSON object" });
    }
  }) as z.ZodType<JsonObject>;
