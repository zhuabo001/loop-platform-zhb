/**
 * Production Croner factory — wraps real Croner instances.
 *
 * Fixed options (Batch 2 plan §2): five-part parsing is locked (`mode`),
 * the internal timer never keeps the process alive (`unref` — shutdown is
 * driven by stopAndDrain, not by timer refcounting), and `protect`/`catch`
 * are supplied by the Scheduler's fixed-classification log handlers.
 */

import { Cron } from "croner";
import type { CronFactory } from "./index.js";

export const productionCronFactory: CronFactory = {
  create(pattern, options, callback) {
    const cron = new Cron(
      pattern,
      {
        timezone: options.timezone,
        protect: options.protect,
        catch: options.catch,
        mode: "5-part",
        unref: true,
      },
      callback,
    );

    return {
      stop: () => cron.stop(),
    };
  },
};
