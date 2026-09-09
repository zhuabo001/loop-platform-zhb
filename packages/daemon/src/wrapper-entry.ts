/**
 * Build-only entry for the control-root executable. esbuild bundles this
 * file and the existing wrapper implementation into one self-contained ESM
 * capsule; production never imports this entry from the daemon process.
 */
import { runLoopzhbWrapper } from "./wrapper-main.js";

process.exitCode = await runLoopzhbWrapper(process.argv.slice(2), process.env, process.cwd());
