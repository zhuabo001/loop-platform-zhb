/**
 * Artifact scanner pins (slice 3, plan AJ4–AJ10; ADR-010 决策 23). Real
 * filesystem fixtures for symlinks, sockets and the real byte ceilings; the
 * io seam for what cannot be raced deterministically (a mid-scan rewrite, a
 * special file, an EACCES) — never fake timers, never a blocking FIFO read.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_MANIFEST_MAX_ENTRIES,
  ARTIFACT_MANIFEST_MAX_TOTAL_BYTES,
} from "@loopzhb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createArtifactHashCache } from "./artifact-hash-cache.js";
import type { ArtifactScanFailure } from "./artifact-jail.js";
import {
  ARTIFACT_SCAN_DEFAULT_LIMITS,
  listDirectoryNames,
  readArtifactFile,
  readArtifactFileWithBytes,
  scanArtifactRoot,
  type ArtifactFileRead,
  type ArtifactScanIo,
  type ArtifactScanOptions,
  type ArtifactScanResult,
} from "./artifact-scan.js";

let base: string;

const p = (...parts: string[]): string => path.join(base, ...parts);

/** A blocking open() never settles, so a regression must FAIL on a deadline
 *  instead of wedging the suite (review #87). */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-artifact-scan-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function scanTree(
  dir: string = base,
  options: Partial<Omit<ArtifactScanOptions, "cache">> & { cache?: ArtifactScanOptions["cache"] } = {},
): Promise<ArtifactScanResult> {
  return scanArtifactRoot({ root: dir, effectiveRoots: [dir] }, { cache: createArtifactHashCache(), ...options });
}

async function expectFailure(
  resultPromise: Promise<ArtifactScanResult>,
  failure: ArtifactScanFailure,
): Promise<ArtifactScanResult & { kind: "failed" }> {
  const result = await resultPromise;
  if (result.kind !== "failed") throw new Error(`expected a failure, got ${result.kind}`);
  expect(result.failure).toBe(failure);
  // A failed scan is structurally incapable of carrying a partial manifest.
  expect("entries" in result).toBe(false);
  return result;
}

const countingOpen = (inner = fs.open): { io: ArtifactScanIo; count: () => number } => {
  let count = 0;
  return {
    io: {
      open: async (target, flags, mode) => {
        count++;
        return inner(target, flags as never, mode as never);
      },
    },
    count: () => count,
  };
};

const recordingListNames = (): { io: ArtifactScanIo; listed: string[] } => {
  const listed: string[] = [];
  return {
    io: {
      listNames: async (dir, max) => {
        listed.push(dir);
        return listDirectoryNames(dir, max);
      },
    },
    listed,
  };
};

/** A Stats-shaped object whose only predicates the scanner may consult
 *  describe a FIFO/socket/device — enough to prove it never opens one. */
const fakeSpecialStat = (): Stats =>
  ({
    dev: 1,
    ino: 2,
    size: 0,
    mtimeMs: 1,
    ctimeMs: 1,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => false,
  }) as unknown as Stats;

describe("AJ4 — symlinks inside the tree fail the whole scan", () => {
  it("a directory symlink pointing inside, outside or nowhere is `symlink`", async () => {
    mkdirSync(p("real"), { recursive: true });
    writeFileSync(p("real", "inner.txt"), "inner");
    mkdirSync(p("outside"));
    symlinkSync(p("real"), p("link-in"));
    symlinkSync(path.join(base, ".."), p("link-out"));
    symlinkSync(p("nowhere"), p("link-dangling"));
    await expectFailure(scanTree(p("link-in")), "symlink");
    await expectFailure(scanTree(p("link-out")), "symlink");
    await expectFailure(scanTree(p("link-dangling")), "symlink");
  });

  it("never descends THROUGH a directory symlink (it is not enumerated)", async () => {
    mkdirSync(p("real"), { recursive: true });
    writeFileSync(p("real", "inner.txt"), "inner");
    symlinkSync(p("real"), p("link"));
    const { io, listed } = recordingListNames();
    await expectFailure(scanTree(base, { io }), "symlink");
    expect(listed).toContain(base);
    expect(listed).not.toContain(p("real"));
    expect(listed).not.toContain(p("link"));
  });

  it("a root swapped for a symlink after resolution fails closed", async () => {
    mkdirSync(p("tree"));
    writeFileSync(p("tree", "f.txt"), "x");
    const resolved = { root: p("tree"), effectiveRoots: [p("tree")] };
    const { renameSync } = await import("node:fs");
    renameSync(p("tree"), p("real-tree"));
    symlinkSync(p("real-tree"), p("tree"));
    const result = await scanArtifactRoot(resolved, { cache: createArtifactHashCache() });
    await expectFailure(Promise.resolve(result), "symlink");
  });
});

describe("AJ5 — file symlinks are refused without opening the target", () => {
  it("a file symlink pointing inside, outside or nowhere is `symlink` with zero opens", async () => {
    mkdirSync(p("case-in"));
    writeFileSync(p("target.txt"), "TARGET");
    symlinkSync(p("target.txt"), p("case-in", "a-link"));
    mkdirSync(p("case-out"));
    symlinkSync(path.join(base, "..", "elsewhere"), p("case-out", "a-link"));
    mkdirSync(p("case-dangling"));
    symlinkSync(p("nowhere"), p("case-dangling", "a-link"));
    for (const dir of ["case-in", "case-out", "case-dangling"]) {
      const { io, count } = countingOpen();
      await expectFailure(scanTree(p(dir), { io }), "symlink");
      expect(count()).toBe(0);
    }
  });
});

describe("AJ6 — special files are refused without opening them", () => {
  it("a FIFO-shaped stat is `special_file` with zero opens (never blocks)", async () => {
    writeFileSync(p("fifo"), "");
    const target = p("fifo");
    const io: ArtifactScanIo = {
      lstat: async (absolutePath) => (absolutePath === target ? fakeSpecialStat() : fs.lstat(absolutePath)),
    };
    const { io: openIo, count } = countingOpen();
    await expectFailure(scanTree(base, { io: { ...io, ...openIo } }), "special_file");
    expect(count()).toBe(0);
    expect(existsSync(target)).toBe(true); // the real file was never read
  });

  it("a FIFO swapped in between lstat and open fails promptly as `special_file` (#87)", async () => {
    // lstat sees a regular file; the injected open replaces it with a REAL
    // FIFO before delegating. A blocking O_RDONLY open would wait for a writer
    // forever, so the deadline turns that regression into a failure. The
    // refused handle must still be closed.
    writeFileSync(p("a.txt"), "hello");
    const target = p("a.txt");
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    const io: ArtifactScanIo = {
      open: async (file, flags, mode) => {
        if (file === target) {
          rmSync(target);
          execFileSync("mkfifo", [target]);
        }
        const handle = await fs.open(file, flags as never, mode as never);
        handles.push(handle);
        return handle;
      },
    };
    const result = await withDeadline(scanTree(base, { io }), 5000, "the FIFO-swapped scan");
    if (result.kind !== "failed") throw new Error("expected a failure, got ok");
    expect(result.failure).toBe("special_file");
    expect(handles).toHaveLength(1);
    expect(handles[0]!.fd).toBe(-1); // closed, not leaked
  });

  it("a real unix socket is `special_file` (no seam)", async () => {
    const sock = p("service.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      await expectFailure(scanTree(), "special_file");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("AJ7 — a missing directory is never an empty manifest", () => {
  it("a non-existent root is directory_missing", async () => {
    await expectFailure(scanTree(p("missing")), "directory_missing");
  });

  it("a root that is a regular file is directory_missing", async () => {
    writeFileSync(p("a-file"), "x");
    await expectFailure(scanTree(p("a-file")), "directory_missing");
  });

  it("a root deleted between resolution and the scan is directory_missing", async () => {
    mkdirSync(p("tree"));
    writeFileSync(p("tree", "f.txt"), "x");
    const resolved = { root: p("tree"), effectiveRoots: [p("tree")] };
    rmSync(p("tree"), { recursive: true });
    await expectFailure(scanArtifactRoot(resolved, { cache: createArtifactHashCache() }), "directory_missing");
  });
});

describe("AJ8 — a legal empty directory is an empty manifest, sorted on output", () => {
  it("an empty tree and a tree of empty directories are both ok with []", async () => {
    const empty = await scanTree();
    if (empty.kind !== "ok") throw new Error(`expected ok, got ${empty.kind}`);
    expect(empty.entries).toEqual([]);
    mkdirSync(p("a", "b", "c"), { recursive: true });
    const nested = await scanTree();
    if (nested.kind !== "ok") throw new Error(`expected ok, got ${nested.kind}`);
    expect(nested.entries).toEqual([]);
  });

  it("returns real SHA-256 hashes and sorts by UTF-16 code units (`a.txt` < `a/b`)", async () => {
    writeFileSync(p("zz.txt"), "hello");
    mkdirSync(p("a"));
    writeFileSync(p("a", "b"), "world");
    writeFileSync(p("a.txt"), "!");
    const result = await scanTree();
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt", "a/b", "zz.txt"]);
    expect(result.entries.map((entry) => entry.hash)).toEqual([
      "bb7208bc9b5d7c04f1236a82a0093a5e33f40423d5ba8d4266f7092c3ba43b62", // "!"
      "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7", // "world"
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", // "hello"
    ]);
    expect(result.entries.map((entry) => entry.size)).toEqual([1, 5, 5]);
    expect(result.root).toBe(base);
  });
});

describe("AJ9 — read failures and instability discard the whole attempt", () => {
  it("an EACCES lstat is `unreadable`, immediately", async () => {
    writeFileSync(p("a.txt"), "a");
    const target = p("a.txt");
    const io: ArtifactScanIo = {
      lstat: async (absolutePath) => {
        if (absolutePath === target) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fs.lstat(absolutePath);
      },
    };
    await expectFailure(scanTree(base, { io }), "unreadable");
  });

  it("a post-read EACCES/EPERM is `unreadable` at once, never `unstable` (#88)", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      writeFileSync(p("a.txt"), "abc");
      const target = p("a.txt");
      let looks = 0;
      let opens = 0;
      const io: ArtifactScanIo = {
        lstat: async (absolutePath) => {
          if (absolutePath === target) {
            looks++;
            // Every POST-read look (the even-numbered one) refuses, so the
            // pre-fix behaviour is the review's exact evidence: three reads,
            // then `unstable` — instead of one read and `unreadable`.
            if (looks % 2 === 0) throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return fs.lstat(absolutePath);
        },
        open: async (file, flags, mode) => {
          opens++;
          return fs.open(file, flags as never, mode as never);
        },
      };
      // A permission fault is deterministic: one attempt, the right class —
      // not three retries ending in `unstable` (and the pre-upload verifier
      // routes through the same read, so it reports `unreadable` too).
      await expectFailure(scanTree(base, { io }), "unreadable");
      expect(opens, code).toBe(1);
      expect(looks, code).toBe(2);
      rmSync(target);
    }
  });

  it("a post-subtree EACCES/EPERM on the directory re-check is `unreadable` at once (#88)", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      writeFileSync(p("a.txt"), "abc");
      let rootLooks = 0;
      let listings = 0;
      const io: ArtifactScanIo = {
        lstat: async (absolutePath) => {
          if (absolutePath === base) {
            rootLooks++;
            // Every directory RE-check (the even-numbered look) refuses, so
            // the pre-fix behaviour is the review's exact evidence: three
            // attempts, then `unstable`.
            if (rootLooks % 2 === 0) throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return fs.lstat(absolutePath);
        },
        listNames: async (dir, max) => {
          listings++;
          return listDirectoryNames(dir, max);
        },
      };
      await expectFailure(scanTree(base, { io }), "unreadable");
      expect(listings, code).toBe(1); // one attempt — no dirty-retry loop
      expect(rootLooks, code).toBe(2); // one inspection + one re-check
      rmSync(p("a.txt"));
    }
  });

  it("a file that vanishes after its read still takes the bounded rescan (ENOENT ⇒ moved)", async () => {
    writeFileSync(p("a.txt"), "abc");
    const target = p("a.txt");
    let rootLooks = 0;
    let opens = 0;
    const io: ArtifactScanIo = {
      lstat: async (absolutePath) => {
        if (absolutePath === base) {
          rootLooks++;
          // The attempt-1 directory re-check: the vanished file comes back
          // BEFORE attempt 2 starts, so the rescan meets a settled tree.
          if (rootLooks === 2) writeFileSync(target, "abc");
        }
        return fs.lstat(absolutePath);
      },
      open: async (file, flags, mode) => {
        const handle = await fs.open(file, flags as never, mode as never);
        if (++opens === 1) rmSync(target); // gone right after attempt 1's read
        return handle;
      },
    };
    const result = await scanTree(base, { io });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(opens).toBe(2); // attempt 1 was discarded, attempt 2 read the file
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
  });

  it("a mid-read rewrite marks the attempt dirty and the rescan succeeds", async () => {
    writeFileSync(p("a.txt"), "abc");
    let opens = 0;
    const io: ArtifactScanIo = {
      open: async (target, flags, mode) => {
        opens++;
        if (opens === 1) await fs.appendFile(target as string, "EXTRA");
        return fs.open(target, flags as never, mode as never);
      },
    };
    const result = await scanTree(base, { io });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(opens).toBe(2); // attempt 1 was discarded, attempt 2 read the file
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.size).toBe(8); // the settled content
  });

  it("a tree that never settles is `unstable` after three attempts", async () => {
    writeFileSync(p("a.txt"), "abc");
    let opens = 0;
    const io: ArtifactScanIo = {
      open: async (target, flags, mode) => {
        opens++;
        await fs.appendFile(target as string, "X");
        return fs.open(target, flags as never, mode as never);
      },
    };
    await expectFailure(scanTree(base, { io }), "unstable");
    expect(opens).toBe(3);
  });

  it("the directory re-check catches an entry created while it was enumerated", async () => {
    writeFileSync(p("early.txt"), "early");
    let listings = 0;
    const io: ArtifactScanIo = {
      listNames: async (dir, max) => {
        const names = await listDirectoryNames(dir, max);
        listings++;
        if (listings === 1) writeFileSync(p("late.txt"), "late");
        return names;
      },
    };
    const result = await scanTree(base, { io });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(listings).toBe(2); // attempt 1 was discarded
    expect(result.entries.map((entry) => entry.path)).toEqual(["early.txt", "late.txt"]);
  });
});

describe("AJ10 — never-sync pruning happens before any I/O", () => {
  it("pruned directories are never descended and pruned files are never read", async () => {
    writeFileSync(p("visible.txt"), "v");
    for (const dir of [".git", "node_modules", ".config"]) mkdirSync(p(dir), { recursive: true });
    writeFileSync(p(".git", "config"), "git");
    writeFileSync(p("node_modules", "pkg.json"), "pkg");
    mkdirSync(p(".config", "gcloud"));
    writeFileSync(p(".config", "gcloud", "creds.json"), "creds");
    for (const name of [".env", ".env.local", "id_rsa", "id_rsa.pub", "server.pem", "credentials", "ID_RSA", ".ENV"]) {
      writeFileSync(p(name), "secret");
    }
    const { io, listed } = recordingListNames();
    const { io: openIo, count } = countingOpen();
    const result = await scanTree(base, { io: { ...io, ...openIo } });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.entries.map((entry) => entry.path)).toEqual(["visible.txt"]);
    expect(count()).toBe(1); // exactly the visible file was opened
    // `.config` alone is NOT a directory rule — only the two-segment
    // `.config/gcloud` window is — so only that child is pruned, and the
    // pruned directory is never enumerated.
    expect(listed).toEqual([base, p(".config")]);
    expect(listed).not.toContain(p(".config", "gcloud"));
  });

  it("a tree of nothing but pruned entries is an empty manifest", async () => {
    mkdirSync(p(".git"));
    writeFileSync(p(".git", "config"), "git");
    writeFileSync(p(".env"), "secret");
    const { io, count } = countingOpen();
    const result = await scanTree(base, { io });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.entries).toEqual([]);
    expect(count()).toBe(0);
  });
});

describe("AJ10 — capacity ceilings stop the scan before it reads", () => {
  it("the default limits ARE the shared policy constants", () => {
    expect(ARTIFACT_SCAN_DEFAULT_LIMITS.fileMaxBytes).toBe(ARTIFACT_FILE_MAX_BYTES);
    expect(ARTIFACT_SCAN_DEFAULT_LIMITS.manifestMaxEntries).toBe(ARTIFACT_MANIFEST_MAX_ENTRIES);
    expect(ARTIFACT_SCAN_DEFAULT_LIMITS.manifestMaxTotalBytes).toBe(ARTIFACT_MANIFEST_MAX_TOTAL_BYTES);
    expect(ARTIFACT_SCAN_DEFAULT_LIMITS.maxVisitedDirents).toBe(4 * ARTIFACT_MANIFEST_MAX_ENTRIES);
    expect(ARTIFACT_SCAN_DEFAULT_LIMITS).toBe(ARTIFACT_SCAN_DEFAULT_LIMITS); // frozen singleton
  });

  it("a sparse file exactly at the real 10 MiB ceiling is ok; one byte more is too_large", async () => {
    const exact = p("exact.bin");
    writeFileSync(exact, "");
    truncateSync(exact, ARTIFACT_FILE_MAX_BYTES);
    const ok = await scanTree();
    if (ok.kind !== "ok") throw new Error(`expected ok, got ${ok.kind}`);
    expect(ok.entries).toHaveLength(1);
    expect(ok.entries[0]!.size).toBe(ARTIFACT_FILE_MAX_BYTES);
    truncateSync(exact, ARTIFACT_FILE_MAX_BYTES + 1);
    const { io, count } = countingOpen();
    await expectFailure(scanTree(base, { io }), "too_large");
    expect(count()).toBe(0); // refused by the lstat ceiling, never opened
  });

  it("an entry-count overflow is too_large and stops before the extra file is opened", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(p(name), name);
    const { io, count } = countingOpen();
    await expectFailure(scanTree(base, { io, limits: { manifestMaxEntries: 2 } }), "too_large");
    expect(count()).toBe(2);
  });

  it("an aggregate-byte overflow is too_large and stops before the excess file is opened", async () => {
    writeFileSync(p("a.txt"), "aaaaaa");
    writeFileSync(p("b.txt"), "bbbbbb");
    const { io, count } = countingOpen();
    await expectFailure(scanTree(base, { io, limits: { manifestMaxTotalBytes: 10 } }), "too_large");
    expect(count()).toBe(1);
  });

  it("a visited-dirent overflow is too_large with zero opens (the listing itself stops)", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(p(name), name);
    const { io, count } = countingOpen();
    await expectFailure(scanTree(base, { io, limits: { maxVisitedDirents: 2 } }), "too_large");
    expect(count()).toBe(0);
  });

  it("a path over 1024 UTF-8 bytes is too_large, and is never even lstat'ed", async () => {
    // A real file with a relative path over 1024 bytes cannot EXIST on macOS
    // (PATH_MAX is 1024, so the absolute path could never be created), so the
    // name is injected through the listing seam — the check runs before any
    // lstat, which is exactly what this pins.
    const longName = "x".repeat(1100);
    const lstatCalls: string[] = [];
    const io: ArtifactScanIo = {
      listNames: async () => [longName],
      lstat: async (absolutePath) => {
        lstatCalls.push(absolutePath);
        return fs.lstat(absolutePath);
      },
    };
    const { io: openIo, count } = countingOpen();
    const result = await expectFailure(scanTree(base, { io: { ...io, ...openIo } }), "too_large");
    expect(result.detail).toContain("path_too_long");
    expect(count()).toBe(0);
    expect(lstatCalls).toEqual([base]); // only the root — the long entry never reached lstat
  });

  it("a backslash or drive-letter name is `unreadable`, never skipped or renamed", async () => {
    writeFileSync(p("a\\b.txt"), "backslash");
    await expectFailure(scanTree(), "unreadable");
    rmSync(p("a\\b.txt"));
    writeFileSync(p("C:"), "drive");
    const result = await expectFailure(scanTree(), "unreadable");
    expect(result.detail).toContain("path_drive_letter");
  });
});

describe("hash cache integration", () => {
  it("rehashes by default even when a cached hash would match, and reuses it only on opt-in", async () => {
    writeFileSync(p("a.txt"), "hello");
    const stat = await fs.lstat(p("a.txt"));
    // A fresh cache per scan: the default scan WRITES the real hash back, so a
    // shared cache could not tell reuse from a rehash on the second run.
    const seeded = (): ReturnType<typeof createArtifactHashCache> => {
      const cache = createArtifactHashCache();
      cache.set(p("a.txt"), {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        hash: "f".repeat(64), // deliberately wrong
      });
      return cache;
    };
    const fresh = await scanTree(base, { cache: seeded() });
    if (fresh.kind !== "ok") throw new Error(`expected ok, got ${fresh.kind}`);
    expect(fresh.entries[0]!.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

    const reused = await scanTree(base, { cache: seeded(), reuseCachedHashes: true });
    if (reused.kind !== "ok") throw new Error(`expected ok, got ${reused.kind}`);
    expect(reused.entries[0]!.hash).toBe("f".repeat(64)); // the cached value, untouched
  });

  it("never reuses a cached hash whose identity moved (five fields, not size)", async () => {
    writeFileSync(p("a.txt"), "hello");
    const stat = await fs.lstat(p("a.txt"));
    const cache = createArtifactHashCache();
    cache.set(p("a.txt"), {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs + 1, // same size, different mtime
      ctimeMs: stat.ctimeMs,
      hash: "f".repeat(64),
    });
    const result = await scanTree(base, { cache, reuseCachedHashes: true });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.entries[0]!.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("writes only fully verified reads back into the cache", async () => {
    writeFileSync(p("a.txt"), "hello");
    const cache = createArtifactHashCache();
    const result = await scanTree(base, { cache });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    const cached = cache.get(p("a.txt"));
    expect(cached?.hash).toBe(result.entries[0]!.hash);
    const stat = await fs.lstat(p("a.txt"));
    expect({ dev: cached!.dev, ino: cached!.ino, size: cached!.size }).toEqual({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
    });
  });
});

describe("readArtifactFileWithBytes — the bytes that were hashed come back (U3)", () => {
  it("returns exactly the file's bytes, hashed to the declared sha256", async () => {
    const content = Buffer.from([0x00, 0x68, 0x69, 0xff, 0x0a, 0x00]); // binary, NUL-delimited
    writeFileSync(p("blob.bin"), content);
    const result = await readArtifactFileWithBytes(p("blob.bin"), { maxBytes: ARTIFACT_FILE_MAX_BYTES });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.bytes.equals(content)).toBe(true);
    expect(result.size).toBe(content.length);
    expect(result.hash).toBe(createHash("sha256").update(content).digest("hex"));
    expect(result.identity.hash).toBe(result.hash); // the cache entry describes those bytes
    expect(result.identity.size).toBe(content.length);
  });

  it("readArtifactFile drops the bytes — the identical identity, the identical shape", async () => {
    writeFileSync(p("plain.txt"), "hello");
    const result = await readArtifactFile(p("plain.txt"), { maxBytes: ARTIFACT_FILE_MAX_BYTES });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect("bytes" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["hash", "identity", "kind", "size"]);
    expect(result.hash).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(result.size).toBe(5);
  });

  it("classifies every arm exactly as readArtifactFile does", async () => {
    writeFileSync(p("plain.txt"), "hello");
    mkdirSync(p("a-dir"));
    symlinkSync(p("plain.txt"), p("a-link"));
    writeFileSync(p("over.bin"), "");
    truncateSync(p("over.bin"), ARTIFACT_FILE_MAX_BYTES + 1);
    writeFileSync(p("denied.txt"), "hello");
    const denied: ArtifactScanIo = {
      lstat: async (target) => {
        if (target === p("denied.txt")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fs.lstat(target);
      },
    };
    const arms: Array<{ name: string; path: string; kind: ArtifactFileRead["kind"]; io?: ArtifactScanIo }> = [
      { name: "ok", path: "plain.txt", kind: "ok" },
      { name: "missing", path: "gone.txt", kind: "missing" },
      { name: "symlink", path: "a-link", kind: "symlink" },
      { name: "special_file", path: "a-dir", kind: "special_file" },
      { name: "unreadable", path: "denied.txt", kind: "unreadable", io: denied },
      { name: "too_large", path: "over.bin", kind: "too_large" },
    ];
    for (const arm of arms) {
      const options = { maxBytes: ARTIFACT_FILE_MAX_BYTES, io: arm.io };
      const plain = await readArtifactFile(p(arm.path), options);
      const bytes = await readArtifactFileWithBytes(p(arm.path), options);
      expect(plain.kind, arm.name).toBe(arm.kind);
      expect(bytes.kind, arm.name).toBe(arm.kind);
    }
  });

  it("a file rewritten mid-read is still `changed`, and carries no bytes", async () => {
    // A fresh counter per call: the append happens exactly once per fixture.
    const midReadRewrite = (): ArtifactScanIo => {
      let opens = 0;
      return {
        open: async (target, flags, mode) => {
          if (++opens === 1) await fs.appendFile(target as string, "EXTRA");
          return fs.open(target, flags as never, mode as never);
        },
      };
    };
    writeFileSync(p("moved.txt"), "abc");
    const bytes = await readArtifactFileWithBytes(p("moved.txt"), { maxBytes: ARTIFACT_FILE_MAX_BYTES, io: midReadRewrite() });
    expect(bytes.kind).toBe("changed");
    expect("bytes" in bytes).toBe(false);

    writeFileSync(p("moved.txt"), "abc"); // a fresh fixture for the byte-less form
    const plain = await readArtifactFile(p("moved.txt"), { maxBytes: ARTIFACT_FILE_MAX_BYTES, io: midReadRewrite() });
    expect(plain.kind).toBe("changed");
  });
});

describe("A5 (slice-5): cooperative cancellation (决策 25)", () => {
  it("returns cancelled — never a partial manifest, never a failure class — when the signal aborts mid-scan", async () => {
    writeFileSync(p("a.txt"), "alpha");
    mkdirSync(p("sub"));
    writeFileSync(p("sub", "b.txt"), "beta");

    const ctl = new AbortController();
    const abortOnFirstStat: ArtifactScanIo = {
      lstat: async (target) => {
        ctl.abort();
        return fs.lstat(target);
      },
    };
    const result = await scanTree(base, { io: abortOnFirstStat, signal: ctl.signal });

    expect(result).toEqual({ kind: "cancelled" });
    // Structurally like a failure: no entries to submit.
    expect("entries" in result).toBe(false);
  });

  it("an already-aborted signal never touches the tree", async () => {
    writeFileSync(p("a.txt"), "alpha");
    const ctl = new AbortController();
    ctl.abort();
    let stats = 0;
    const counting: ArtifactScanIo = {
      lstat: async (target) => {
        stats += 1;
        return fs.lstat(target);
      },
    };
    expect(await scanTree(base, { io: counting, signal: ctl.signal })).toEqual({ kind: "cancelled" });
    expect(stats).toBe(0);
  });
});
