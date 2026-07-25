import { describe, expect, it } from "vitest";

import { DEVICE_TOKEN_PREFIX, isDeviceTokenShape, RUN_TOKEN_PREFIX } from "./tokens.js";

describe("isDeviceTokenShape", () => {
  it("accepts the real minted form (dk_ + 30 hex chars)", () => {
    expect(isDeviceTokenShape(`dk_${"a1".repeat(15)}`)).toBe(true);
  });
  it("accepts word-shaped demo/dev tokens (deliberately permissive charset)", () => {
    expect(isDeviceTokenShape("dk_demo_cookie_unified")).toBe(true);
    expect(isDeviceTokenShape("dk_abc")).toBe(true); // min length: 3 past prefix
    expect(isDeviceTokenShape("dk_A0_-x")).toBe(true);
    expect(isDeviceTokenShape(`dk_${"a".repeat(120)}`)).toBe(true); // exactly AT the cap
  });
  it("rejects junk before any lookup work", () => {
    expect(isDeviceTokenShape("")).toBe(false);
    expect(isDeviceTokenShape("dk_")).toBe(false); // nothing past the prefix
    expect(isDeviceTokenShape("dk_ab")).toBe(false); // under the 3-char floor
    expect(isDeviceTokenShape(`rk_${"a".repeat(32)}`)).toBe(false); // run token, wrong prefix
    expect(isDeviceTokenShape(" dk_abcdef")).toBe(false); // stray whitespace
    expect(isDeviceTokenShape("dk_abc def")).toBe(false);
    expect(isDeviceTokenShape("dk_abc.def")).toBe(false); // charset excludes dots
    expect(isDeviceTokenShape(`dk_${"a".repeat(121)}`)).toBe(false); // over the 120 cap
    expect(isDeviceTokenShape("xdk_abcdef")).toBe(false); // anchored at the start
  });
});

it("token prefixes stay dk_/rk_ (the CLI router branches on them)", () => {
  expect(DEVICE_TOKEN_PREFIX).toBe("dk_");
  expect(RUN_TOKEN_PREFIX).toBe("rk_");
});
