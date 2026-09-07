/**
 * Per-Run Claude temp root pins (Issue #50, sandbox-compat plan §3 每 Run
 * 的临时文件能力 / §4.5–4.6): minting discipline (canonical base, 0700,
 * short credential-free prefix, fresh per Run), runner ownership of
 * CLAUDE_CODE_TMPDIR (a user-provided value can neither override the
 * runner's mint nor widen the profile), and fail-closed release.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareClaudeRunTemp, releaseClaudeRunTemp } from "./run-temp.js";

const minted: string[] = [];

afterEach(async () => {
  for (const dir of minted.splice(0)) {
    await rmSync(dir, { recursive: true, force: true });
  }
});

function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

describe("prepareClaudeRunTemp", () => {
  it("mints a 0700 root on the canonical base with the short prefix — fresh per call", async () => {
    const first = await prepareClaudeRunTemp();
    minted.push(first.tmpRoot);
    const second = await prepareClaudeRunTemp();
    minted.push(second.tmpRoot);

    const expectedBase = process.platform === "darwin" ? "/private/tmp" : realpathSync(tmpdir());
    for (const prepared of [first, second]) {
      expect(prepared.baseDir).toBe(expectedBase);
      expect(path.dirname(prepared.tmpRoot)).toBe(expectedBase); // canonical, never the /tmp alias
      expect(path.basename(prepared.tmpRoot)).toMatch(/^lzc-/);
      expect(modeOf(prepared.tmpRoot)).toBe(0o700);
    }
    expect(first.tmpRoot).not.toBe(second.tmpRoot);
  });

  it("cleans up the minted root when chmod fails", async () => {
    const { promises: fs } = await import("node:fs");
    let mintedPath = "";
    await expect(
      prepareClaudeRunTemp({
        ...fs,
        mkdtemp: (async (prefix: string) => {
          mintedPath = await fs.mkdtemp(prefix);
          return mintedPath;
        }) as typeof fs.mkdtemp,
        chmod: async () => {
          throw new Error("injected chmod failure");
        },
      }),
    ).rejects.toThrow("injected chmod failure");
    expect(mintedPath).not.toBe("");
    expect(existsSync(mintedPath)).toBe(false);
  });
});

describe("releaseClaudeRunTemp", () => {
  it("removes the minted root", async () => {
    const prepared = await prepareClaudeRunTemp();
    await releaseClaudeRunTemp(prepared);
    expect(existsSync(prepared.tmpRoot)).toBe(false);
  });

  it("refuses an identity mismatch (wrong parent or wrong prefix) before touching the filesystem", async () => {
    const prepared = await prepareClaudeRunTemp();
    minted.push(prepared.tmpRoot);
    await expect(releaseClaudeRunTemp({ tmpRoot: "/etc/lzc-nope", baseDir: prepared.baseDir })).rejects.toThrow(
      /identity mismatch/,
    );
    await expect(
      releaseClaudeRunTemp({ tmpRoot: path.join(prepared.baseDir, "other-name"), baseDir: prepared.baseDir }),
    ).rejects.toThrow(/identity mismatch/);
    expect(existsSync(prepared.tmpRoot)).toBe(true); // untouched
  });

  it("refuses a swapped (symlink) root — fail closed, target untouched", async () => {
    const prepared = await prepareClaudeRunTemp();
    const target = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-runtemp-target-"));
    minted.push(target);
    await rmSync(prepared.tmpRoot, { recursive: true });
    symlinkSync(target, prepared.tmpRoot);
    await expect(releaseClaudeRunTemp(prepared)).rejects.toThrow(/replaced before release/);
    expect(existsSync(target)).toBe(true);
    rmSync(prepared.tmpRoot, { force: true });
  });
});
