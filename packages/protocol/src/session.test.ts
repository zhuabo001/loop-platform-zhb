/**
 * `sessionInfoResponseSchema` pins: the `GET /api/session` wire shape
 * (Batch 3 slice 2) — required fields, ISO expiry, tolerant reader.
 */
import { describe, expect, it } from "vitest";

import { sessionInfoResponseSchema } from "./session.js";

const VALID = {
  user: { id: "424242", username: "tester" },
  team: { id: "t-0123456789abcdef", name: "tester" },
  session: { expiresAt: "2026-10-14T00:00:00.000Z" },
  csrfToken: "csrf-token-plaintext",
};

describe("sessionInfoResponseSchema", () => {
  it("accepts the canonical response and round-trips every field", () => {
    expect(sessionInfoResponseSchema.parse(VALID)).toEqual(VALID);
  });

  it("requires every field of every nested object", () => {
    const cases: unknown[] = [
      { ...VALID, user: { username: "tester" } },
      { ...VALID, user: { id: "424242" } },
      { ...VALID, team: { name: "tester" } },
      { ...VALID, team: { id: "t-0123456789abcdef" } },
      { ...VALID, session: {} },
      { user: VALID.user, team: VALID.team, session: VALID.session },
    ];
    for (const body of cases) {
      expect(sessionInfoResponseSchema.safeParse(body).success).toBe(false);
    }
  });

  it("expiresAt must be a real ISO datetime, not an arbitrary string", () => {
    for (const bad of ["tomorrow", "2026-10-14", 42, null]) {
      expect(sessionInfoResponseSchema.safeParse({ ...VALID, session: { expiresAt: bad } }).success).toBe(false);
    }
    // Offsets are accepted (admin.ts convention).
    expect(
      sessionInfoResponseSchema.safeParse({ ...VALID, session: { expiresAt: "2026-10-14T08:00:00+08:00" } }).success,
    ).toBe(true);
  });

  it("tolerant reader: unknown extra keys are stripped, not rejected", () => {
    const parsed = sessionInfoResponseSchema.parse({ ...VALID, future: true });
    expect(parsed).toEqual(VALID);
    expect("future" in parsed).toBe(false);
  });
});
