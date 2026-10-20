import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // artifact-watch-manager's poll-until helper gives a positive wait a 10 s
    // WALL-CLOCK budget: the chain it waits on (admission lstat + full rehash
    // + sync round after a fired reconcile tick) is real async I/O, and a
    // loaded CI runner can stall the event loop for seconds. The per-test
    // budget must EXCEED that poll budget — otherwise vitest's 5 s default
    // kills a slow-but-healthy test before the labeled `deadline exceeded
    // waiting for …` can resolve or fire, which is exactly the flake seen on
    // CI (4 red / 2 green on the same tree, then a 5 s testTimeout kill).
    // Headroom, not an expectation: a healthy local run finishes the whole
    // file in well under a second.
    testTimeout: 20_000,
  },
});
