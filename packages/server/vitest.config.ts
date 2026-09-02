import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test boots real in-memory PGlite instances (WASM Postgres +
    // migrations); under full-suite parallel load a multi-instance test can
    // exceed vitest's 5s default. This is HEADROOM for contention, not an
    // expectation — a healthy local run is far below it.
    testTimeout: 20_000,
    // beforeEach/afterEach boot and close those same PGlite instances; the
    // 10s default hookTimeout was the actual flake source under WASM
    // contention (spec-track P2, Batch 3 review).
    hookTimeout: 60_000,
    // Bound concurrent WASM Postgres boots. Unbounded file-level workers can
    // exhaust the host and turn unrelated 1–2s tests into deterministic
    // 20–60s timeouts; two workers keep the complete gate representative and
    // reproducible without weakening any per-test timeout.
    maxWorkers: 2,
  },
});
