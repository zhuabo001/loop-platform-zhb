/**
 * The daemon's private control root (Phase 4 Batch 2, plan §2.1, ADR-009
 * 修订 8): minted ONCE per daemon start as an unpredictable mkdtemp
 * directory (0700), holding the static `loopzhb` wrapper the agent's PATH
 * points at. The wrapper is a build-generated, self-contained read-only
 * capsule (0500): it has no runtime import back into the daemon install and
 * carries NO Server URL, Machine Credential or Run Credential. Per-run
 * control directories live under this root (run-control.ts).
 *
 * The root is a per-start resource with a full lifecycle (review STD-4):
 * the composition root releases it on startup failure and at shutdown —
 * fail-closed, like the per-run release below it.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WRAPPER_BUNDLE_FILE, WRAPPER_BUNDLE_SHA256 } from "./wrapper-artifact.generated.js";

export const WRAPPER_COMMAND = "loopzhb";
const CONTROL_ROOT_PREFIX = "loopzhb-control-";
const WRAPPER_PACKAGE_JSON = '{"type":"module"}\n';
// Resolves to packages/daemon/dist from both src/control-root.ts under
// Vitest and dist/control-root.js in production.
const WRAPPER_BUNDLE_PATH = fileURLToPath(new URL(`../dist/${WRAPPER_BUNDLE_FILE}`, import.meta.url));

export interface ControlRoot {
  /** The 0700 mkdtemp root — parent of every per-run control directory. */
  rootDir: string;
  /** `rootDir/bin` — the directory prepended to the agent's PATH. */
  wrapperDir: string;
  /** `wrapperDir/loopzhb` — the static 0500 executable. */
  wrapperPath: string;
  /** Canonical executable of the Node process that started this daemon. */
  nodePath: string;
  /** Directory placed immediately after wrapperDir in the child PATH. */
  nodeDir: string;
  /** The canonicalized base the root was minted under — release re-verifies
   *  the root's identity against it before deleting anything. */
  baseDir: string;
}

type ControlRootIo = Pick<
  typeof fs,
  "mkdir" | "realpath" | "mkdtemp" | "chmod" | "readFile" | "writeFile" | "rm"
>;

export async function createControlRoot(baseDir: string, io: ControlRootIo = fs): Promise<ControlRoot> {
  if (!path.isAbsolute(baseDir)) {
    throw new Error(`control root base must be an absolute path: ${JSON.stringify(baseDir)}`);
  }
  // Fail startup before minting any directory when the generated install
  // artifact is absent, corrupt, or stale relative to its build digest.
  const bundle = await io.readFile(WRAPPER_BUNDLE_PATH);
  const actualDigest = createHash("sha256").update(bundle).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(WRAPPER_BUNDLE_SHA256) || WRAPPER_BUNDLE_SHA256 !== actualDigest) {
    throw new Error("loopzhb wrapper bundle is invalid or stale — rebuild @loopzhb/daemon");
  }
  const nodePath = await io.realpath(process.execPath);
  await io.mkdir(baseDir, { recursive: true });
  const base = await io.realpath(baseDir);
  let rootDir: string | undefined;
  try {
    rootDir = await io.mkdtemp(path.join(base, CONTROL_ROOT_PREFIX));
    await io.chmod(rootDir, 0o700);
    const wrapperDir = path.join(rootDir, "bin");
    await io.mkdir(wrapperDir);
    await io.chmod(wrapperDir, 0o700);
    const wrapperPath = path.join(wrapperDir, WRAPPER_COMMAND);
    await io.writeFile(wrapperPath, bundle, { mode: 0o500 });
    await io.chmod(wrapperPath, 0o500);
    await io.writeFile(path.join(wrapperDir, "package.json"), WRAPPER_PACKAGE_JSON, { mode: 0o400 });
    return { rootDir, wrapperDir, wrapperPath, nodePath, nodeDir: path.dirname(nodePath), baseDir: base };
  } catch (err) {
    // Construction owns the directory as soon as mkdtemp returns. Any later
    // chmod/mkdir/write failure must not transfer a half-built root to the
    // process lifecycle, and cleanup failure must not mask the original.
    if (rootDir !== undefined) await io.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Release the per-start control root (review STD-4), fail-closed like the
 *  per-run release (run-control.ts): an already-missing root is idempotent
 *  success (a startup-failure path may have cleaned up first); anything
 *  that is NOT exactly the minted directory — a symlink, a non-directory,
 *  a different parent or a different name prefix — throws instead of
 *  deleting a swapped target. */
export async function releaseControlRoot(root: ControlRoot): Promise<void> {
  // Identity is pure path logic — refuse a wrong parent or name prefix
  // BEFORE touching the filesystem at all.
  if (path.dirname(root.rootDir) !== root.baseDir || !path.basename(root.rootDir).startsWith(CONTROL_ROOT_PREFIX)) {
    throw new Error(`control root identity mismatch: ${root.rootDir}`);
  }
  let stat;
  try {
    stat = await fs.lstat(root.rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`control root was replaced before release: ${root.rootDir}`);
  }
  await fs.rm(root.rootDir, { recursive: true, force: true });
}
