/**
 * The committed version constant must equal package.json's `version` — the
 * drift pin the handoff review required (no runtime import in PRODUCTION
 * code; the TEST reading the file is exactly the point).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DAEMON_VERSION } from "./version.js";

describe("DAEMON_VERSION", () => {
  it("equals package.json version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(DAEMON_VERSION).toBe(pkg.version);
  });
});
