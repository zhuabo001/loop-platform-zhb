import { expect, it } from "vitest";

import { PROTOCOL_VERSION } from "./version.js";

it("PROTOCOL_VERSION stays 1 (additive evolution needs no bump — ADR-002)", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
