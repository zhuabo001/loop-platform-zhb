import { describe, expect, it } from "vitest";

import { machineIdFromToken, preparePayloadFingerprint, sha256, watchConfigDigest } from "./node.js";

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

describe("artifact fingerprints (AP11 — golden vectors pin the canonicalization + hash composition)", () => {
  const HASH_A = "a".repeat(64);

  it("preparePayloadFingerprint matches the golden vector (hardcoded, not self-computed)", () => {
    // sha256 over the canonical prepare string pinned in artifact-policy.test.ts:
    // {"baseManifestRevision":2,"configRevision":3,"entries":[{"hash":"<64×a>","path":"a.txt","size":12}],"loopId":"loop-01"}
    const fingerprint = preparePayloadFingerprint({
      loopId: "loop-01",
      configRevision: 3,
      baseManifestRevision: 2,
      entries: [{ path: "a.txt", hash: HASH_A, size: 12 }],
    });
    expect(fingerprint).toBe("3acfbb59b408564dceb081f53ec410a2a70ad158e857f29f700186b7cec5d7d5");
  });

  it("watchConfigDigest matches the golden vector (set semantics: item/root order and dupes ignored)", () => {
    const item = (loopId: string) => ({
      loopId,
      artifactDir: "dist",
      workdir: null,
      roots: ["/b", "/a", "/a"],
      configRevision: 1,
    });
    const digest = watchConfigDigest([item("l2"), item("l1")]);
    expect(digest).toBe(watchConfigDigest([item("l1"), item("l2")]));
    expect(digest).toBe("8cb5eafa75926d24bf4e00131cc70417e383fa5237971db75bd8b8c83e1d601d");
  });
});
