/**
 * Startup config (A-12): defaults, overrides, blank handling, the strict port
 * matrix and the loopback warning policy — all pure, no resources opened.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  isLoopbackHost,
  loadServerConfig,
  parsePort,
  unauthenticatedExposureWarning,
} from "./config.js";

const HOME = "/home/tester";
const CWD = "/srv/app";

describe("loadServerConfig", () => {
  it("zero-config boots to 127.0.0.1:3000 with ~/.loopzhb (never in-memory)", () => {
    expect(loadServerConfig({}, HOME, CWD)).toEqual({
      host: "127.0.0.1",
      port: 3000,
      dataDir: "/home/tester/.loopzhb",
    });
  });

  it("honors explicit overrides", () => {
    expect(
      loadServerConfig({ LOOPZHB_HOST: "0.0.0.0", LOOPZHB_PORT: "8787", LOOPZHB_DATA_DIR: "/data/loop" }, HOME, CWD),
    ).toEqual({ host: "0.0.0.0", port: 8787, dataDir: "/data/loop" });
  });

  it("treats unset and all-whitespace values identically (defaults)", () => {
    for (const blank of [undefined, "", "   \n\t  "]) {
      expect(loadServerConfig({ LOOPZHB_HOST: blank, LOOPZHB_PORT: blank, LOOPZHB_DATA_DIR: blank }, HOME, CWD)).toEqual({
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        dataDir: `${HOME}/.loopzhb`,
      });
    }
  });

  it("resolves a relative DATA_DIR against the boot cwd to an absolute path", () => {
    expect(loadServerConfig({ LOOPZHB_DATA_DIR: "data/pg" }, HOME, CWD).dataDir).toBe("/srv/app/data/pg");
    expect(loadServerConfig({ LOOPZHB_DATA_DIR: "./x" }, HOME, CWD).dataDir).toBe("/srv/app/x");
  });
});

describe("parsePort: the strict 1–65535 decimal matrix", () => {
  it("accepts the boundaries and ordinary values", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("3000")).toBe(3000);
  });

  it.each(["0", "-1", "65536", "99999", "3.5", "1e3", "abc", "0x10", "12 34", "3_000"])(
    "rejects %j at boot (fail fast, never a silent fallback)",
    (bad) => {
      expect(() => parsePort(bad)).toThrow(/LOOPZHB_PORT/);
    },
  );
});

describe("loopback policy", () => {
  it("loopback hosts produce NO warning", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(unauthenticatedExposureWarning(host)).toBeNull();
    }
  });

  it("a non-loopback host produces the unauthenticated-exposure warning naming the host", () => {
    const warning = unauthenticatedExposureWarning("0.0.0.0");
    expect(warning).toContain("0.0.0.0");
    expect(warning).toMatch(/NO authentication/);
    // The Day 8–10 cancel route is part of the unauthenticated surface.
    expect(warning).toContain("/api/runs*");
    expect(unauthenticatedExposureWarning("192.168.1.10")).not.toBeNull();
  });
});
