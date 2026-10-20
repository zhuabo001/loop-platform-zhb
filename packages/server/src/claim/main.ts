/**
 * The built entry point for `claim:legacy` (`node --enable-source-maps
 * dist/claim/main.js`). Thin by design, exactly like `start.ts`'s direct-run
 * guard: all behaviour lives in `runClaimLegacy`, which returns an exit code.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runClaimLegacy } from "./legacy.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  process.exitCode = await runClaimLegacy(process.argv.slice(2), process.env, process.cwd());
}
