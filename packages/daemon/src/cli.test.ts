import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { registerShutdownSignals, type ShutdownSignalEvents } from "./cli.js";

describe("registerShutdownSignals", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`aborts on ${signal} and unregisters both signal listeners`, () => {
      const events = new EventEmitter() as ShutdownSignalEvents & EventEmitter;
      const ctl = new AbortController();
      const logs: string[] = [];
      const unregister = registerShutdownSignals(ctl, (line) => logs.push(line), events);

      expect(events.listenerCount("SIGINT")).toBe(1);
      expect(events.listenerCount("SIGTERM")).toBe(1);
      events.emit(signal, signal);

      expect(ctl.signal.aborted).toBe(true);
      expect(logs).toEqual([`received ${signal} — stopping poll loop`]);

      unregister();
      expect(events.listenerCount("SIGINT")).toBe(0);
      expect(events.listenerCount("SIGTERM")).toBe(0);
    });
  }
});
