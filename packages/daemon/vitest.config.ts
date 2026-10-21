import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // artifact-watch-manager's poll-until helper gives a positive wait a 10 s
    // WALL-CLOCK budget; the per-test budget must EXCEED it — otherwise
    // vitest's 5 s default kills a slow-but-healthy (or correctly-failing)
    // test before the labeled `deadline exceeded waiting for …` can fire,
    // replacing an actionable error with an unlabeled testTimeout kill (seen
    // on CI run 39453931521). Headroom, not an expectation: a healthy local
    // run finishes the whole file in well under a second.
    testTimeout: 20_000,
  },
});
