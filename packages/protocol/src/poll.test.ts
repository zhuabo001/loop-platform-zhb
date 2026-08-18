import { describe, expect, it } from "vitest";

import {
  deliverySchema,
  pollRequestSchema,
  pollResponseSchema,
  runProgressSchema,
} from "./poll.js";

/** A golden Delivery, mirroring the reference shape field-for-field. */
const GOLDEN_DELIVERY = {
  runId: "r_01HXYZ",
  runToken: `rk_${"b2".repeat(16)}`,
  role: "exec",
  loop: {
    id: "loop_01",
    name: "react-doctor",
    workdir: "/home/dev/project",
    taskFile: "/home/dev/project/loops/react-doctor/README.md",
    workflow: null,
    model: null,
    allowControl: true,
    agent: "claude-code",
  },
  prevState: { lastScore: 87 },
  roots: ["/home/dev/project"],
  systemPrompt: "",
  task: [
    "[loop run]",
    'Loop id: "loop_01"',
    'Loop name: "react-doctor"',
    'Read the task file first: "/home/dev/project/loops/react-doctor/README.md"',
    "Do the work it describes.",
    "Run once, then stop.",
  ].join("\n"),
} as const;

describe("pollRequestSchema", () => {
  it("round-trips a full golden poll body", () => {
    const body = {
      host: "mbp.local",
      platform: "darwin",
      arch: "arm64",
      version: "0.16.0",
      progress: [{ runId: "r_01", step: 3, label: "editing src/app.ts" }],
      wait: true as const,
    };
    expect(pollRequestSchema.parse(body)).toEqual(body);
  });

  it("parses an empty body (every field optional — old daemons send almost nothing)", () => {
    expect(pollRequestSchema.parse({})).toEqual({});
  });

  it("strips unknown keys (tolerant reader: a newer peer's fields never break us)", () => {
    const parsed = pollRequestSchema.parse({ host: "h", watchDigest: "abc", futureField: 42 });
    expect(parsed).toEqual({ host: "h" });
    expect(parsed).not.toHaveProperty("watchDigest");
    expect(parsed).not.toHaveProperty("futureField");
  });

  it("rejects wait:false — the flag is only ever SENT as true", () => {
    expect(() => pollRequestSchema.parse({ wait: false })).toThrow();
  });

  it("rejects a progress entry without a label", () => {
    expect(() => runProgressSchema.parse({ runId: "r", step: 1 })).toThrow();
    expect(() =>
      pollRequestSchema.parse({ progress: [{ runId: "r", step: 1 }] }),
    ).toThrow();
  });

  it("rejects a non-integer progress step", () => {
    expect(() => runProgressSchema.parse({ runId: "r", step: 1.5, label: "x" })).toThrow();
  });

  it("round-trips availableSlots 0 and 1 (Phase 2 cooperative backpressure signal)", () => {
    expect(pollRequestSchema.parse({ availableSlots: 0 })).toEqual({ availableSlots: 0 });
    expect(pollRequestSchema.parse({ availableSlots: 1 })).toEqual({ availableSlots: 1 });
  });

  it("leaves availableSlots undefined when absent (old daemon ⇒ server keeps batch claim)", () => {
    expect(pollRequestSchema.parse({}).availableSlots).toBeUndefined();
  });

  it("rejects non-literal availableSlots values (0|1 only — same style as wait:true)", () => {
    for (const availableSlots of [2, -1, 0.5, true, "1"]) {
      expect(() => pollRequestSchema.parse({ availableSlots })).toThrow();
    }
  });

  it("keeps progress caps OUT of the schema (ADR-002: protocol pins shape, server pins size)", () => {
    // A 10KB label and 50 entries must still PARSE — a schema-level .max()
    // would turn an oversized heartbeat into a 400 and kill the daemon's poll
    // loop. Size policy lives server-side, cleaned before the DB write.
    const entries = Array.from({ length: 50 }, (_, i) => ({
      runId: `r_${i}`,
      step: i,
      label: "x".repeat(10 * 1024),
    }));
    const parsed = pollRequestSchema.parse({ progress: entries });
    expect(parsed.progress).toHaveLength(50);
    expect(parsed.progress?.[0]?.label).toHaveLength(10 * 1024);
  });
});

describe("deliverySchema", () => {
  it("round-trips the golden delivery", () => {
    expect(deliverySchema.parse(GOLDEN_DELIVERY)).toEqual(GOLDEN_DELIVERY);
  });

  it("passes prevState through untouched (any JSON, incl. null)", () => {
    for (const prevState of [null, 0, "x", { nested: [1, 2] }]) {
      const d = deliverySchema.parse({ ...GOLDEN_DELIVERY, prevState });
      expect(d.prevState).toEqual(prevState);
    }
  });

  it("accepts a delivery with no agent (old server) — daemon defaults to claude-code", () => {
    const { agent: _agent, ...loopNoAgent } = GOLDEN_DELIVERY.loop;
    const parsed = deliverySchema.parse({ ...GOLDEN_DELIVERY, loop: loopNoAgent });
    expect(parsed.loop.agent).toBeUndefined();
  });

  it("rejects an unknown agent and an unknown role", () => {
    expect(() =>
      deliverySchema.parse({ ...GOLDEN_DELIVERY, loop: { ...GOLDEN_DELIVERY.loop, agent: "gpt" } }),
    ).toThrow();
    expect(() => deliverySchema.parse({ ...GOLDEN_DELIVERY, role: "review" })).toThrow();
  });

  it("keeps runToken OPAQUE (tolerant reader: any string passes, incl. bare UUIDs)", () => {
    // Pinning the mirror discipline (ADR-002): the reader must NOT shape-check
    // the token — a pre-Batch-6 bare UUID and a future mint format both ride
    // this field. Shape filtering lives mint/write-side (isRunTokenShape).
    for (const runToken of [
      `rk_${"b2".repeat(16)}`, // current mint form
      "4b6f8a2e-1c3d-4e5f-9a0b-7c8d9e0f1a2b", // pre-Batch-6 bare UUID
      "whatever-a-future-server-mints",
      "",
    ]) {
      expect(deliverySchema.parse({ ...GOLDEN_DELIVERY, runToken }).runToken).toBe(runToken);
    }
  });

  it("requires roots to be present ([] = unrestricted, but never absent)", () => {
    const { roots: _roots, ...noRoots } = GOLDEN_DELIVERY;
    expect(() => deliverySchema.parse(noRoots)).toThrow();
  });

  it("requires non-null workdir to be a string, allows null", () => {
    expect(() =>
      deliverySchema.parse({ ...GOLDEN_DELIVERY, loop: { ...GOLDEN_DELIVERY.loop, workdir: 3 } }),
    ).toThrow();
  });
});

describe("pollResponseSchema", () => {
  it("round-trips deliveries (incl. empty)", () => {
    expect(pollResponseSchema.parse({ deliveries: [] })).toEqual({ deliveries: [] });
    expect(pollResponseSchema.parse({ deliveries: [GOLDEN_DELIVERY] })).toEqual({
      deliveries: [GOLDEN_DELIVERY],
    });
  });
});
