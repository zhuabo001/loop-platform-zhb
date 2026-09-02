/**
 * Task File resolver / snapshotter pins (Phase 4 Batch 2, plan §2.2,
 * ADR-009 修订 9): path expansion (absolute / relative-to-canonical-cwd /
 * exact-~ home expansion / ~name-as-relative), jail containment, regular-
 * readable-file preflight, pre-spawn drift refusal, and the post-run sync
 * classification — atomic same-path replacement allowed, alias repoint /
 * symlink swap / drift → changed, NUL / invalid UTF-8 / secret → unreadable,
 * >256 KiB → too_large.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkdirJail, type ResolvedWorkdir, type WorkdirJail } from "./jail.js";
import {
  TaskFileDriftError,
  expandTaskFilePath,
  revalidateTaskFile,
  resolveTaskFile,
  snapshotTaskFile,
  type ResolvedTaskFile,
} from "./task-file.js";

const SECRET = "sk-ant-taskfile-secret";

let base: string;
let root: string;
let workdir: string;
let jail: WorkdirJail;
let resolved: ResolvedWorkdir;

beforeEach(async () => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-taskfile-test-"));
  root = path.join(base, "root");
  workdir = path.join(root, "work");
  mkdirSync(workdir, { recursive: true });
  jail = await createWorkdirJail({ allowedRoots: [root], scratchBase: path.join(base, "scratch") });
  resolved = await jail.resolve({ workdir, serverRoots: [], loopId: "loop-1", runId: "run-1" });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeTask(name: string, content: string | Buffer = "# Task\n"): string {
  const file = path.join(workdir, name);
  writeFileSync(file, content);
  return file;
}

async function resolveOk(taskFile: string, homeDir?: string): Promise<ResolvedTaskFile> {
  const result = await resolveTaskFile({ taskFile, resolved, homeDir });
  if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.file;
}

describe("path expansion", () => {
  it("absolute paths resolve directly", () => {
    expect(expandTaskFilePath("/abs/TASK.md", "/cwd", "/home/u")).toBe("/abs/TASK.md");
  });
  it("relative paths resolve against the canonical cwd", () => {
    expect(expandTaskFilePath("docs/TASK.md", "/real/cwd", "/home/u")).toBe(path.join("/real/cwd", "docs/TASK.md"));
  });
  it("an exact ~ and ~/... expand against HOME", () => {
    expect(expandTaskFilePath("~/TASK.md", "/cwd", "/home/u")).toBe(path.join("/home/u", "TASK.md"));
    expect(expandTaskFilePath("~", "/cwd", "/home/u")).toBe(path.join("/home/u", ""));
  });
  it("~name is an ordinary relative path", () => {
    expect(expandTaskFilePath("~other/TASK.md", "/cwd", "/home/u")).toBe(path.join("/cwd", "~other/TASK.md"));
  });
  it("~ without HOME falls back to cwd-relative", () => {
    expect(expandTaskFilePath("~/TASK.md", "/cwd", undefined)).toBe(path.join("/cwd", "~/TASK.md"));
  });
});

describe("resolveTaskFile — preflight classification", () => {
  it("a regular readable file inside the roots resolves ok (absolute + relative)", async () => {
    const file = writeTask("TASK.md");
    const abs = await resolveOk(file);
    expect(abs.canonicalPath).toBe(realpathSync(file));
    const rel = await resolveOk("TASK.md");
    expect(rel.canonicalPath).toBe(abs.canonicalPath);
    expect(rel.aliasPath).toBe(path.join(resolved.cwd, "TASK.md"));
  });

  it("~ expansion resolves through HOME when the home is inside the roots", async () => {
    const home = path.join(root, "home");
    mkdirSync(home);
    writeFileSync(path.join(home, "TASK.md"), "# Task\n");
    const file = await resolveOk("~/TASK.md", home);
    expect(file.canonicalPath).toBe(realpathSync(path.join(home, "TASK.md")));
  });

  it("null/empty taskFile is not_configured", async () => {
    expect(await resolveTaskFile({ taskFile: null, resolved, homeDir: undefined })).toEqual({ kind: "not_configured" });
    expect(await resolveTaskFile({ taskFile: "", resolved, homeDir: undefined })).toEqual({ kind: "not_configured" });
  });

  it("a missing file is missing; a directory is missing", async () => {
    expect(await resolveTaskFile({ taskFile: "nope.md", resolved, homeDir: undefined })).toEqual({
      kind: "error",
      error: "missing",
    });
    mkdirSync(path.join(workdir, "DIR.md"));
    expect(await resolveTaskFile({ taskFile: "DIR.md", resolved, homeDir: undefined })).toEqual({
      kind: "error",
      error: "missing",
    });
  });

  it("an unreadable file is unreadable", async () => {
    const file = writeTask("LOCKED.md");
    chmodSync(file, 0o000);
    try {
      expect(await resolveTaskFile({ taskFile: "LOCKED.md", resolved, homeDir: undefined })).toEqual({
        kind: "error",
        error: "unreadable",
      });
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("a file outside every effective root is outside_jail — even through a symlink alias", async () => {
    const outside = path.join(base, "outside.md");
    writeFileSync(outside, "# secret\n");
    expect(await resolveTaskFile({ taskFile: outside, resolved, homeDir: undefined })).toEqual({
      kind: "error",
      error: "outside_jail",
    });
    symlinkSync(outside, path.join(workdir, "ALIAS.md"));
    expect(await resolveTaskFile({ taskFile: "ALIAS.md", resolved, homeDir: undefined })).toEqual({
      kind: "error",
      error: "outside_jail",
    });
  });

  it("a symlink alias pointing INSIDE the roots resolves to its canonical target", async () => {
    const file = writeTask("REAL.md");
    symlinkSync(file, path.join(workdir, "ALIAS.md"));
    const resolvedFile = await resolveOk("ALIAS.md");
    expect(resolvedFile.aliasPath).toBe(path.join(resolved.cwd, "ALIAS.md"));
    expect(resolvedFile.canonicalPath).toBe(realpathSync(file));
  });

  it("a scratch-cwd run may name a file inside its scratch or the roots, nowhere else", async () => {
    const scratch = await jail.resolve({ workdir: null, serverRoots: [], loopId: "loop-1", runId: "run-2" });
    writeFileSync(path.join(scratch.cwd, "TASK.md"), "# Task\n");
    const inScratch = await resolveTaskFile({ taskFile: "TASK.md", resolved: scratch, homeDir: undefined });
    expect(inScratch).toMatchObject({ kind: "ok" });
    // The effective roots stay valid for a scratch run (plan §2.2: "有效
    // roots 或 scratch cwd").
    const inRoots = await resolveTaskFile({ taskFile: writeTask("WORK.md"), resolved: scratch, homeDir: undefined });
    expect(inRoots).toMatchObject({ kind: "ok" });
    const outside = path.join(base, "outside.md");
    writeFileSync(outside, "# secret\n");
    expect(await resolveTaskFile({ taskFile: outside, resolved: scratch, homeDir: undefined })).toEqual({
      kind: "error",
      error: "outside_jail",
    });
    await jail.release(scratch);
  });
});

describe("revalidateTaskFile — pre-spawn drift refuses the spawn", () => {
  it("passes when nothing moved; an atomic same-path replacement is fine", async () => {
    const file = await resolveOk(writeTask("TASK.md"));
    await revalidateTaskFile(file);
    const tmp = path.join(workdir, ".TASK.tmp");
    writeFileSync(tmp, "# v2\n");
    renameSync(tmp, file.aliasPath);
    await revalidateTaskFile(file);
  });

  it("a repointed alias throws (symlink swap)", async () => {
    const file = await resolveOk(writeTask("TASK.md"));
    const other = writeTask("OTHER.md");
    rmSync(file.aliasPath);
    symlinkSync(other, file.aliasPath);
    await expect(revalidateTaskFile(file)).rejects.toBeInstanceOf(TaskFileDriftError);
  });

  it("a deleted alias or target throws", async () => {
    const file = await resolveOk(writeTask("TASK.md"));
    rmSync(file.canonicalPath);
    await expect(revalidateTaskFile(file)).rejects.toBeInstanceOf(TaskFileDriftError);
  });
});

describe("snapshotTaskFile — the post-run sync classification", () => {
  it("reads the content of the SAME canonical path (atomic replacement allowed)", async () => {
    const file = await resolveOk(writeTask("TASK.md", "# v1\n"));
    const tmp = path.join(workdir, ".TASK.tmp");
    writeFileSync(tmp, "# v2\n");
    renameSync(tmp, file.aliasPath);
    expect(await snapshotTaskFile(file, [])).toEqual({ kind: "content", content: "# v2\n" });
  });

  it("a repointed alias is changed", async () => {
    const file = await resolveOk(writeTask("TASK.md"));
    const other = writeTask("OTHER.md");
    rmSync(file.aliasPath);
    symlinkSync(other, file.aliasPath);
    expect(await snapshotTaskFile(file, [])).toEqual({ kind: "error", error: "changed" });
  });

  it("a deleted file is missing (alias == canonical), a dangling alias symlink is missing", async () => {
    const direct = await resolveOk(writeTask("DIRECT.md"));
    rmSync(direct.canonicalPath);
    expect(await snapshotTaskFile(direct, [])).toEqual({ kind: "error", error: "missing" });

    const target = writeTask("REAL.md");
    symlinkSync(target, path.join(workdir, "ALIAS.md"));
    const viaAlias = await resolveOk("ALIAS.md");
    rmSync(target); // the alias now dangles
    expect(await snapshotTaskFile(viaAlias, [])).toEqual({ kind: "error", error: "missing" });
  });

  it("a symlink swapped IN at the canonical path is changed", async () => {
    const file = await resolveOk(writeTask("TASK.md"));
    const other = writeTask("OTHER.md");
    rmSync(file.canonicalPath);
    symlinkSync(other, file.canonicalPath);
    // The alias path itself is gone (it WAS the canonical path), so the
    // realpath of the alias now resolves through the symlink → drift.
    expect(await snapshotTaskFile(file, [])).toEqual({ kind: "error", error: "changed" });
  });

  it("NUL bytes and invalid UTF-8 are unreadable", async () => {
    const nul = await resolveOk(writeTask("NUL.md", Buffer.from([0x61, 0x00, 0x62])));
    expect(await snapshotTaskFile(nul, [])).toEqual({ kind: "error", error: "unreadable" });
    const bad = await resolveOk(writeTask("BAD.md", Buffer.from([0x61, 0xff, 0xfe, 0x62])));
    expect(await snapshotTaskFile(bad, [])).toEqual({ kind: "error", error: "unreadable" });
  });

  it("a file over 256 KiB is too_large", async () => {
    const big = await resolveOk(writeTask("BIG.md", "x".repeat(262_145)));
    expect(await snapshotTaskFile(big, [])).toEqual({ kind: "error", error: "too_large" });
  });

  it("exactly 256 KiB is legal", async () => {
    const exact = await resolveOk(writeTask("EXACT.md", "x".repeat(262_144)));
    const result = await snapshotTaskFile(exact, []);
    expect(result.kind).toBe("content");
  });

  it("a file containing a known provider secret is unreadable — content never leaves", async () => {
    const file = await resolveOk(writeTask("LEAK.md", `notes: ${SECRET} inside`));
    expect(await snapshotTaskFile(file, [SECRET])).toEqual({ kind: "error", error: "unreadable" });
    // …and a clean file with the same scanner is fine.
    const clean = await resolveOk(writeTask("CLEAN.md", "notes: nothing here"));
    expect(await snapshotTaskFile(clean, [SECRET])).toEqual({ kind: "content", content: "notes: nothing here" });
  });

  it.each([
    ["base64", Buffer.from(SECRET, "utf8").toString("base64")],
    ["base64url", Buffer.from(SECRET, "utf8").toString("base64url")],
    ["hex", Buffer.from(SECRET, "utf8").toString("hex")],
    ["percent", encodeURIComponent(SECRET)],
    ["chunked base64", (Buffer.from(SECRET, "utf8").toString("base64").match(/.{1,5}/g) ?? []).join("-")],
  ])("a Task File containing a %s-derived provider secret is unreadable", async (_label, encoded) => {
    const file = await resolveOk(writeTask("ENCODED.md", `notes: ${encoded}`));
    expect(await snapshotTaskFile(file, [SECRET])).toEqual({ kind: "error", error: "unreadable" });
  });

  it("the review's jail-escape repro: a symlink swap inside the check/use window reads NOTHING (SPEC-2/ADV-2)", async () => {
    // The lstat→readFile window the review exploited, replayed deterministically:
    // the alias still realpaths to the canonical path, but the injected open
    // swaps the canonical entry for a symlink to an OUT-OF-JAIL file before
    // the real open. Pre-fix this returned the outside content; O_NOFOLLOW
    // now turns it into drift.
    const file = await resolveOk(writeTask("TASK.md", "# in-jail\n"));
    const outside = path.join(base, "outside.md");
    writeFileSync(outside, "OUTSIDE-JAIL");
    const result = await snapshotTaskFile(file, [], {
      open: async (p, flags, mode) => {
        rmSync(p);
        symlinkSync(outside, p);
        return open(p, flags as never, mode as never);
      },
    });
    expect(result).toEqual({ kind: "error", error: "changed" });
  });

  it("an inode replacement AFTER the open (mid-read window) is caught by the post-read identity check", async () => {
    const file = await resolveOk(writeTask("TASK.md", "# v1\n"));
    const result = await snapshotTaskFile(file, [], {
      open: async (p, flags, mode) => {
        const handle = await open(p, flags as never, mode as never); // fd to the ORIGINAL file
        writeFileSync(path.join(workdir, ".swap.tmp"), "# swapped\n");
        rmSync(p);
        renameSync(path.join(workdir, ".swap.tmp"), p); // the path now names a NEW inode
        return handle;
      },
    });
    expect(result).toEqual({ kind: "error", error: "changed" });
  });

  it("a sparse file over 256 KiB apparent size is too_large without a whole-file read", async () => {
    const sparse = writeTask("SPARSE.md", "x");
    truncateSync(sparse, 300 * 1024);
    const file = await resolveOk(sparse);
    expect(await snapshotTaskFile(file, [])).toEqual({ kind: "error", error: "too_large" });
  });
});
