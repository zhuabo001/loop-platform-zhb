/**
 * The state secret scan (Phase 4 Batch 2 review ADV-1, ADR-009 修订 8):
 * the SINGLE stack-safe key/value scan shared by both layers of the journal
 * secret boundary — the wrapper runs it BEFORE the record lands on disk,
 * the journal collector runs it again BEFORE the state enters the report
 * (an agent can write its outbox directly, bypassing the wrapper, so the
 * collector can never trust the first layer ran). A hit FAILS CLOSED: the
 * state is never silently rewritten — the invocation/collection fails with
 * a stable, content-free classification instead (plan §2.6).
 */

/** Iterative, stack-safe secret scan over an already policy-validated state:
 *  ANY string key or value containing a known secret needle fails. */
import { createProtectedSecretMatcher } from "./agent-env.js";

export function stateContainsSecret(value: unknown, needles: readonly string[], stack: unknown[] = []): boolean {
  if (needles.length === 0) return false;
  const containsSecret = createProtectedSecretMatcher(needles);
  stack.push(value);
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current === "string") {
        if (containsSecret(current)) return true;
        continue;
      }
      if (current === null || typeof current !== "object") continue;
      if (Array.isArray(current)) {
        for (const item of current) stack.push(item);
        continue;
      }
      for (const [key, child] of Object.entries(current)) {
        if (containsSecret(key)) return true;
        stack.push(child);
      }
    }
    return false;
  } finally {
    stack.length = 0;
  }
}
