import { describe, expect, it } from "vitest";

import { machineIdFromToken, sha256 } from "./node.js";

describe("node subpath helpers", () => {
  it("sha256 matches the golden vector (hardcoded, not self-computed)", () => {
    // Independently computed: printf 'dk_demo_cookie_unified' | shasum -a 256
    expect(sha256("dk_demo_cookie_unified")).toBe(
      "848c882b40d15d56c412c828fef7088b27ac23855540332c933ec451908c225f",
    );
  });

  it("machineIdFromToken derives m-<sha256(token)[:16]>", () => {
    expect(machineIdFromToken("dk_demo_cookie_unified")).toBe("m-848c882b40d15d56");
  });

  it("machine id format is stable: m- + 16 lowercase hex chars", () => {
    expect(machineIdFromToken(`dk_${"a1".repeat(15)}`)).toMatch(/^m-[0-9a-f]{16}$/);
  });
});
