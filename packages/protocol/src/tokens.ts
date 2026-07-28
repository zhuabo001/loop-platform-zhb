/**
 * Credential wire formats. Two credential TYPES, distinguished by prefix:
 * `dk_` device token (identifies a machine; its id derives from the token —
 * see `@loopzhb/protocol/node` `machineIdFromToken`) and `rk_` run lease
 * (authorizes one run's in-run verbs + final report).
 *
 * Shape checks are a CHEAP MALFORMED-INPUT FILTER at the enrollment surface,
 * never the auth boundary: a well-shaped but unknown token must still be
 * rejected by the server's lookup. The charset past the prefix is deliberately
 * permissive — real tokens are hex, but hand-minted demo/dev tokens (e.g.
 * `dk_demo_cookie_unified`) are legitimately word-shaped.
 *
 * Mirrors the reference (loop-platform packages/server/src/gateway/tokens.ts:27-50).
 */
import { z } from "zod";

export const DEVICE_TOKEN_PREFIX = "dk_";
export const RUN_TOKEN_PREFIX = "rk_";

export const DEVICE_TOKEN_RE = /^dk_[A-Za-z0-9_-]{3,120}$/;

export function isDeviceTokenShape(token: string): boolean {
  return DEVICE_TOKEN_RE.test(token);
}

export const RUN_TOKEN_RE = /^rk_[A-Za-z0-9_-]{3,120}$/;

export function isRunTokenShape(token: string): boolean {
  return RUN_TOKEN_RE.test(token);
}

/** Shared shape validation for the `rk_…` run lease where it appears INSIDE a
 *  zod-parsed payload (today: `deliverySchema.runToken`). Same cheap-filter
 *  semantics as the regexes above — never the auth boundary. */
export const runTokenSchema = z.string().regex(RUN_TOKEN_RE);
