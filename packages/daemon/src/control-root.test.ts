/**
 * Control root + per-run control directory pins (Phase 4 Batch 2, plan §2.1,
 * ADR-009 修订 8): the per-start 0700 root with the static 0500 wrapper
 * (secret-free content), and the per-run 0700 directory with the read-only
 * compact prev-state.json and the outbox — plus fail-closed release.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createControlRoot, releaseControlRoot } from "./control-root.js";
import { prepareRunControl, releaseRunControl } from "./run-control.js";
import { JOURNAL_OUTBOX_ENV } from "./wrapper-main.js";

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

  it("the wrapper is a fixed launcher around the digest-verified bundle — all secret-free", async () => {
    const { wrapperDir, wrapperPath, bundlePath, opensslConfigPath, nodePath } = await createControlRoot(base);
    const second = await createControlRoot(base);
    // The launcher: canonical-Node shebang carrying the wrapper-only OpenSSL
    // config as the kernel's single argument, then the bundle import.
    const launcher = readFileSync(wrapperPath, "utf8");
    expect(launcher).toBe(`#!${nodePath} --openssl-config=${opensslConfigPath}\nimport "./loopzhb-wrapper.mjs";\n`);
    // The bundle keeps the executable header and the wrapper logic; identical
    // bytes across roots (only the launcher's baked paths differ per start).
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).toContain("#!/usr/bin/env node");
    expect(bundle).toContain("runLoopzhbWrapper");
    expect(readFileSync(second.bundlePath)).toEqual(readFileSync(bundlePath));
    expect(bundle).not.toContain("file://");
    expect(bundle).not.toContain(realpathSync(path.join(import.meta.dirname, "..")));
    // Modes: launcher 0500, bundle and config 0400.
    expect(modeOf(wrapperPath)).toBe(0o500);
    expect(modeOf(bundlePath)).toBe(0o400);
    expect(modeOf(opensslConfigPath)).toBe(0o400);
    expect(readFileSync(opensslConfigPath, "utf8")).toBe("");
    // ESM marker sibling (the extensionless wrapper must parse as ESM).
    expect(readFileSync(path.join(wrapperDir, "package.json"), "utf8")).toBe('{"type":"module"}\n');
    // Runtime credentials are never interpolated into the static capsule.
    const runtimeOnlySecrets = ["dk_runtime-only", "rk_runtime-only", "https://runtime-secret.invalid"];
    for (const name of readdirSync(wrapperDir)) {
      const content = readFileSync(path.join(wrapperDir, name), "utf8");
      for (const secret of runtimeOnlySecrets) expect(content).not.toContain(secret);
    }
  });

  it("the launcher passes arguments with spaces, quotes and dollars through verbatim — no shell re-evaluation", async () => {
    const controlRoot = await createControlRoot(base);
    const control = await prepareRunControl({ controlRoot, runId: "args", prevState: null });
    const tricky = 'a $HOME `whoami` "quoted" tail';
    const result = spawnSync(controlRoot.wrapperPath, ["report", "--status", "nothing-new", "--message", tricky], {
      env: { ...process.env, PATH: [controlRoot.wrapperDir, controlRoot.nodeDir].join(path.delimiter), [JOURNAL_OUTBOX_ENV]: control.outboxDir },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const records = readdirSync(control.outboxDir);
    expect(records).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(control.outboxDir, records[0]!), "utf8"))).toEqual({
      kind: "report",
      status: "nothing-new",
      message: tricky,
    });
  });

  it("a wrong node earlier in PATH is never picked — the launcher execs the canonical daemon Node", async () => {
    const controlRoot = await createControlRoot(base);
    const control = await prepareRunControl({ controlRoot, runId: "wrong-node", prevState: null });
    const decoyDir = path.join(base, "decoy-bin");
    mkdirSync(decoyDir);
    const marker = path.join(base, "decoy-ran");
    writeFileSync(path.join(decoyDir, "node"), `#!/bin/sh\necho decoy > ${marker}\nexit 42\n`, { mode: 0o755 });
    const result = spawnSync(controlRoot.wrapperPath, ["report", "--status", "nothing-new"], {
      env: {
        ...process.env,
        PATH: [controlRoot.wrapperDir, decoyDir, controlRoot.nodeDir].join(path.delimiter),
        [JOURNAL_OUTBOX_ENV]: control.outboxDir,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(control.outboxDir)).toHaveLength(1);
  });

  it("refuses to start when the daemon itself runs under a custom OpenSSL configuration", async () => {
    process.env.OPENSSL_CONF = "/etc/site-openssl.cnf";
    try {
      await expect(createControlRoot(base)).rejects.toThrow(/custom OpenSSL configuration/);
    } finally {
      delete process.env.OPENSSL_CONF;
    }
  });

  it("buildWrapperLauncher rejects non-absolute or whitespace/quote-bearing paths", async () => {
    const { buildWrapperLauncher } = await import("./control-root.js");
    const good = await createControlRoot(base);
    expect(() => buildWrapperLauncher(good.nodePath, good.opensslConfigPath)).not.toThrow();
    expect(() => buildWrapperLauncher("relative/node", good.opensslConfigPath)).toThrow(/absolute/);
    expect(() => buildWrapperLauncher(good.nodePath, "/tmp/has space/openssl.cnf")).toThrow(/whitespace/);
    expect(() => buildWrapperLauncher('/tmp/evil"quote/node', good.opensslConfigPath)).toThrow(/whitespace/);
  });

  it("executes as a self-contained capsule without read access to the daemon install", async () => {
    const controlRoot = await createControlRoot(base);
    const control = await prepareRunControl({ controlRoot, runId: "capsule", prevState: null });
    const result = spawnSync(
      controlRoot.wrapperPath,
      ["report", "--status", "nothing-new"],
      {
        cwd: controlRoot.rootDir,
        env: {
          ...process.env,
          PATH: [controlRoot.wrapperDir, controlRoot.nodeDir].join(path.delimiter),
          NODE_OPTIONS: [
            "--permission",
            `--allow-fs-read=${controlRoot.rootDir}`,
            `--allow-fs-read=${controlRoot.nodePath}`,
            `--allow-fs-write=${control.outboxDir}`,
          ].join(" "),
          [JOURNAL_OUTBOX_ENV]: control.outboxDir,
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const records = readdirSync(control.outboxDir);
    expect(records).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(control.outboxDir, records[0]!), "utf8"))).toEqual({
      kind: "report",
      status: "nothing-new",
    });
  });

  it.each(["missing", "invalid"] as const)("fails before minting when the wrapper bundle is %s", async (failure) => {
    const controlBase = path.join(base, "unusable-bundle");
    const readFile = (async (file: Parameters<typeof fs.readFile>[0], options?: unknown) => {
      if (String(file).endsWith("loopzhb-wrapper.mjs")) {
        if (failure === "missing") throw Object.assign(new Error("missing bundle"), { code: "ENOENT" });
        if (failure === "invalid") return Buffer.from("corrupt bundle");
      }
      return await fs.readFile(file, options as never);
    }) as typeof fs.readFile;

    await expect(createControlRoot(controlBase, { ...fs, readFile })).rejects.toThrow(
      failure === "missing" ? /missing bundle/ : /invalid or stale/,
    );
    expect(existsSync(controlBase)).toBe(false);
  });

  it.each(["bundle", "config", "wrapper", "package"] as const)(
    "cleans the minted root when the %s write fails",
    async (failure) => {
      let minted = "";
      const match: Record<string, RegExp> = {
        bundle: /loopzhb-wrapper\.mjs$/,
        config: /openssl\.cnf$/,
        wrapper: /bin\/loopzhb$/,
        package: /package\.json$/,
      };
      await expect(
        createControlRoot(base, {
          ...fs,
          writeFile: async (file, data, options) => {
            minted = path.dirname(path.dirname(String(file)));
            if (match[failure]!.test(String(file))) throw new Error(`injected ${failure} write failure`);
            return fs.writeFile(file, data, options);
          },
        }),
      ).rejects.toThrow(`injected ${failure} write failure`);
      expect(minted).not.toBe("");
      expect(existsSync(minted)).toBe(false);
    },
  );
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
