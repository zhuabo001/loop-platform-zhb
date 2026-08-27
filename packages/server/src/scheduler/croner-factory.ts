/**
 * Production Croner factory — wraps real Croner instances.
 */

import { Cron } from "croner";
import type { CronFactory, CronJob } from "./index.js";

export const productionCronFactory: CronFactory = {
  create(pattern, options, callback) {
    const cron = new Cron(
      pattern,
      {
        timezone: options.timezone,
        protect: options.protect,
        catch: options.catch,
        mode: "5-part",
      },
      callback,
    );

    return {
      stop: () => cron.stop(),
    };
  },
};
