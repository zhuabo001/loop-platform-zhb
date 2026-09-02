/**
 * Control root + per-run control directory pins (Phase 4 Batch 2, plan §2.1,
 * ADR-009 修订 8): the per-start 0700 root with the static 0500 wrapper
 * (secret-free content), and the per-run 0700 directory with the read-only
 * compact prev-state.json and the outbox — plus fail-closed release.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createControlRoot, releaseControlRoot } from "./control-root.js";
import { prepareRunControl, releaseRunControl } from "./run-control.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-control-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

describe("createControlRoot", () => {
  it("mints an unpredictable 0700 root with the static 0500 wrapper", async () => {
    const first = await createControlRoot(base);
    const second = await createControlRoot(base);
    expect(first.rootDir).not.toBe(second.rootDir);
    expect(path.dirname(first.rootDir)).toBe(base);
    expect(path.basename(first.rootDir)).toMatch(/^loopzhb-control-/);
    expect(modeOf(first.rootDir)).toBe(0o700);
    expect(modeOf(first.wrapperDir)).toBe(0o700);
    expect(modeOf(first.wrapperPath)).toBe(0o500);
    expect(path.basename(first.wrapperPath)).toBe("loopzhb");
  });

  it("the wrapper content is static, ESM-marked and secret-free", async () => {
    const { wrapperDir, wrapperPath } = await createControlRoot(base);
    const script = readFileSync(wrapperPath, "utf8");
    expect(script).toContain("#!/usr/bin/env node");
    expect(script).toContain("runLoopzhbWrapper");
    // ESM marker sibling (the extensionless wrapper must parse as ESM).
    expect(readFileSync(path.join(wrapperDir, "package.json"), "utf8")).toBe('{"type":"module"}\n');
    // Secret scan: nothing credential-shaped in any wrapper-dir file.
    for (const name of readdirSync(wrapperDir)) {
      const content = readFileSync(path.join(wrapperDir, name), "utf8");
      expect(content).not.toMatch(/dk_|rk_|https?:\/\//);
      expect(content).not.toContain("LOOPZHB_MACHINE_CREDENTIAL");
      expect(content).not.toContain("LOOPZHB_SERVER_URL");
    }
  });

  it.each(["wrapper", "package"] as const)("cleans the minted root when the %s write fails", async (failure) => {
    let minted = "";
    await expect(
      createControlRoot(base, {
        ...fs,
        writeFile: async (file, data, options) => {
          minted = path.dirname(path.dirname(String(file)));
          const isPackage = String(file).endsWith("package.json");
          if ((failure === "package") === isPackage) throw new Error(`injected ${failure} write failure`);
          return fs.writeFile(file, data, options);
        },
      }),
    ).rejects.toThrow(`injected ${failure} write failure`);
    expect(minted).not.toBe("");
    expect(existsSync(minted)).toBe(false);
  });
});

describe("releaseControlRoot — the per-start lifecycle (review STD-4)", () => {
  it("removes the minted root and everything under it", async () => {
    const root = await createControlRoot(base);
    await releaseControlRoot(root);
    expect(() => statSync(root.rootDir)).toThrow();
  });

  it("an already-missing root is idempotent success (startup-failure cleanup ran first)", async () => {
    const root = await createControlRoot(base);
    rmSync(root.rootDir, { recursive: true, force: true });
    await releaseControlRoot(root); // no throw
  });

  it("release refuses a swapped (symlink) root — fail closed, target untouched", async () => {
    const root = await createControlRoot(base);
    rmSync(root.rootDir, { recursive: true, force: true });
    const decoy = path.join(base, "decoy");
    writeFileSync(path.join(base, "marker"), "x");
    symlinkSync(decoy, root.rootDir, "dir");
    await expect(releaseControlRoot(root)).rejects.toThrow(/replaced/);
    expect(readFileSync(path.join(base, "marker"), "utf8")).toBe("x"); // nothing deleted
    rmSync(root.rootDir, { force: true });
  });

  it("release refuses a non-directory replacement", async () => {
    const root = await createControlRoot(base);
    rmSync(root.rootDir, { recursive: true, force: true });
    writeFileSync(root.rootDir, "not a directory");
    await expect(releaseControlRoot(root)).rejects.toThrow(/replaced/);
    rmSync(root.rootDir, { force: true });
  });

  it("release refuses an identity mismatch (wrong parent or wrong name prefix)", async () => {
    const root = await createControlRoot(base);
    await expect(releaseControlRoot({ ...root, baseDir: path.join(base, "elsewhere") })).rejects.toThrow(/identity/);
    await expect(
      releaseControlRoot({ ...root, rootDir: path.join(root.baseDir, "not-the-prefix-123") }),
    ).rejects.toThrow(/identity/);
    await releaseControlRoot(root); // the real root still releases fine
  });
});

describe("prepareRunControl / releaseRunControl", () => {
  it("creates the 0700 context+outbox and the read-only compact prev-state", async () => {
    const controlRoot = await createControlRoot(base);
    const control = await prepareRunControl({
      controlRoot,
      runId: "run-1",
      prevState: { cursor: 2, nested: { list: [1, "x"] } },
    });
    expect(path.dirname(control.controlDir)).toBe(controlRoot.rootDir);
    expect(modeOf(control.controlDir)).toBe(0o700);
    expect(modeOf(control.contextDir)).toBe(0o700);
    expect(modeOf(control.outboxDir)).toBe(0o700);
    expect(modeOf(control.prevStatePath)).toBe(0o400);
    expect(readFileSync(control.prevStatePath, "utf8")).toBe('{"cursor":2,"nested":{"list":[1,"x"]}}');

    await releaseRunControl(control.controlDir);
    expect(() => statSync(control.controlDir)).toThrow();
  });

  it("serializes a null/absent prevState as the JSON null literal", async () => {
    const controlRoot = await createControlRoot(base);
    const control = await prepareRunControl({ controlRoot, runId: "run-2", prevState: null });
    expect(readFileSync(control.prevStatePath, "utf8")).toBe("null");
    await releaseRunControl(control.controlDir);
  });

  it("release refuses a swapped (symlink) control dir — fail closed", async () => {
    const controlRoot = await createControlRoot(base);
    const control = await prepareRunControl({ controlRoot, runId: "run-3", prevState: null });
    rmSync(control.controlDir, { recursive: true, force: true });
    const decoy = path.join(base, "decoy");
    writeFileSync(path.join(base, "marker"), "x");
    symlinkSync(decoy, control.controlDir, "dir");
    await expect(releaseRunControl(control.controlDir)).rejects.toThrow(/replaced/);
    rmSync(control.controlDir, { force: true });
  });
});
