/**
 * JSON value/object wire shapes for Phase 4 terminal state (ADR-009 决策 6).
 *
 * The schema pins SHAPE only (ADR-002 决策 4), and it does so STACK-SAFELY
 * because a recursive `z.lazy` schema threw `RangeError` on
 * pathologically deep input, escaping `safeParse` as an uncategorized 500
 * before any policy could run. The wire layer now checks only the top-level
 * object shape non-recursively and delegates nested legality to the iterative
 * `isStrictJsonValue`; the 64 KiB ceiling and database-writability rules stay
 * in `terminal-policy.ts`, the narrow exception both peers execute identically.
 */
import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

type WireAttach = (clone: unknown) => void;

type WireArrayFrame = {
  kind: "array";
  source: unknown[];
  clone: unknown[];
  length: number;
  index: number;
  attach: WireAttach;
};

type WireObjectFrame = {
  kind: "object";
  source: Record<string, unknown>;
  clone: Record<string, unknown>;
  keys: IterableIterator<string>;
  attach: WireAttach;
};

type WireFrame = WireArrayFrame | WireObjectFrame;
type WireEvent = { type: "visit"; value: unknown; attach: WireAttach } | { type: "next"; frame: WireFrame };

function* ownEnumerableKeys(source: object): IterableIterator<string> {
  for (const key in source) {
    if (Object.hasOwn(source, key)) yield key;
  }
}

function createSafeArray(length: number): unknown[] {
  const clone: unknown[] = new Array(length);
  Object.defineProperty(clone, "toJSON", { value: undefined, enumerable: false });
  return clone;
}

function createSafeObject(): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  // Keep Object.prototype for downstream libraries that inspect constructor,
  // but shadow a polluted inherited serializer. A legal own `toJSON` data key
  // can replace this configurable placeholder during the walk.
  Object.defineProperty(clone, "toJSON", {
    value: undefined,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return clone;
}

/**
 * Stack-safe, TOTAL strict JSON-value check: rejects `undefined`, functions,
 * symbols, bigints, non-finite numbers, cycles and exotic object prototypes.
 * It first builds a plain clone with a lazy cursor walk, so getters are read
 * once and shared DAG nodes are never expanded per reference. A final guarded
 * stringify runs only for non-shared trees to preserve the wire's stable
 * rejection of engine-depth failures. Caller-controlled reflection stays
 * inside the exception boundary.
 */
export function isStrictJsonValue(root: unknown): boolean {
  try {
    const clones = new Map<object, Record<string, unknown> | unknown[]>();
    const active = new Set<object>();
    let rootClone: unknown;
    let valid = true;
    // A null-prototype LIFO avoids Array.prototype numeric accessors changing
    // traversal control flow while validating adversarial input.
    const events = Object.create(null) as Record<number, WireEvent>;
    let eventCount = 0;
    const pushEvent = (event: WireEvent): void => {
      events[eventCount++] = event;
    };
    const popEvent = (): WireEvent => {
      const index = --eventCount;
      const event = events[index]!;
      Reflect.deleteProperty(events, String(index));
      return event;
    };
    pushEvent({
      type: "visit",
      value: root,
      attach: (clone) => {
        rootClone = clone;
      },
    });

    while (eventCount > 0 && valid) {
      const event = popEvent();
      if (event.type === "next") {
        const frame = event.frame;
        if (frame.kind === "array") {
          if (frame.index >= frame.length) {
            active.delete(frame.source);
            frame.attach(frame.clone);
            continue;
          }
          const index = frame.index++;
          if (!Object.hasOwn(frame.source, index)) {
            valid = false;
            continue;
          }
          const child = frame.source[index];
          pushEvent({ type: "next", frame });
          pushEvent({
            type: "visit",
            value: child,
            attach: (clone) => {
              Object.defineProperty(frame.clone, index, {
                value: clone,
                writable: true,
                enumerable: true,
                configurable: true,
              });
            },
          });
          continue;
        }

        const keyResult = frame.keys.next();
        if (keyResult.done) {
          active.delete(frame.source);
          frame.attach(frame.clone);
          continue;
        }
        const key = keyResult.value;
        // Recreate a legal data key at its source-order position instead of
        // retaining the earlier non-enumerable prototype-pollution shield.
        if (key === "toJSON") Reflect.deleteProperty(frame.clone, key);
        const child = frame.source[key];
        pushEvent({ type: "next", frame });
        pushEvent({
          type: "visit",
          value: child,
          attach: (clone) => {
            Object.defineProperty(frame.clone, key, {
              value: clone,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          },
        });
        continue;
      }

      const { value, attach } = event;
      if (value === null || typeof value === "string" || typeof value === "boolean") {
        attach(value);
        continue;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) valid = false;
        else attach(value);
        continue;
      }
      if (typeof value !== "object" || active.has(value)) {
        valid = false;
        continue;
      }
      const shared = clones.get(value);
      if (shared !== undefined) {
        // The clone is validation-only. One occurrence already contains the
        // complete shared subtree; a primitive placeholder prevents the depth
        // probe below from expanding it again at every reference point.
        attach(null);
        continue;
      }
      if (Array.isArray(value)) {
        const length = value.length;
        const clone = createSafeArray(length);
        clones.set(value, clone);
        active.add(value);
        pushEvent({ type: "next", frame: { kind: "array", source: value, clone, length, index: 0, attach } });
        continue;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        valid = false;
        continue;
      }
      const clone = createSafeObject();
      clones.set(value, clone);
      active.add(value);
      pushEvent({
        type: "next",
        frame: {
          kind: "object",
          source: value as Record<string, unknown>,
          clone,
          keys: ownEnumerableKeys(value),
          attach,
        },
      });
    }

    if (!valid) return false;
    return typeof JSON.stringify(rootClone) === "string";
  } catch {
    return false;
  }
}

/**
 * A top-level JSON object (arrays/null/scalars are NOT valid state). The zod
 * layer is NON-RECURSIVE (top-level shape only); nested legality rides the
 * stack-safe `isStrictJsonValue` superRefine, so a deep or cyclic body
 * degrades to a stable schema rejection (HTTP 400, lease untouched) instead
 * of a `RangeError`. Value policy — the 64 KiB compact ceiling
 * and PostgreSQL writability — is deliberately NOT here: it lives in
 * `terminal-policy.ts` and runs in the domain layer.
 *
 * The base schema is `z.unknown()`, NOT `z.record(...)`: a
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
    if (typeof value !== "object" || value === null) {
      ctx.addIssue({ code: "custom", message: "must be a top-level JSON object" });
      return;
    }
    try {
      if (Array.isArray(value)) {
        ctx.addIssue({ code: "custom", message: "must be a top-level JSON object" });
        return;
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a strict JSON object" });
      return;
    }
    if (!isStrictJsonValue(value)) {
      ctx.addIssue({ code: "custom", message: "must be a strict JSON object" });
    }
  }) as z.ZodType<JsonObject>;
