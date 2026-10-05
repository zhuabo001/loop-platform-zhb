/**
 * Pre-upload verification pins (slice 3, ADR-010 决策 23): the containment
 * guard reads nothing, the classification is finer than the wire taxonomy,
 * and verification ALWAYS re-reads and recomputes — the cache is written
 * back, never consulted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ARTIFACT_FILE_MAX_BYTES } from "@loopzhb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createArtifactHashCache, type ArtifactHashCache } from "./artifact-hash-cache.js";
import type { ResolvedArtifactRoot } from "./artifact-jail.js";
import type { ArtifactScanIo } from "./artifact-scan.js";
import { verifyArtifactEntry, type ArtifactVerifyFailure, type ArtifactVerifyResult } from "./artifact-verify.js";

let base: string;

const p = (...parts: string[]): string => path.join(base, ...parts);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const root: () => ResolvedArtifactRoot = () => ({ root: base, effectiveRoots: [base] });

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-artifact-verify-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function expectFailure(
  resultPromise: Promise<ArtifactVerifyResult>,
  failure: ArtifactVerifyFailure,
): Promise<void> {
  const result = await resultPromise;
  if (result.kind !== "failed") throw new Error(`expected a failure, got ok for ${result.entry.path}`);
  expect(result.failure).toBe(failure);
}

const expectedFor = (relPath: string, text: string): { path: string; hash: string; size: number } => ({
  path: relPath,
  hash: sha256(text),
  size: Buffer.byteLength(text),
});

describe("containment guard — nothing outside the root is ever read", () => {
  it("a `..` chain that escapes the root is `changed` with zero opens", async () => {
    writeFileSync(p("outside.txt"), "OUTSIDE");
    mkdirSync(p("tree"));
    let opens = 0;
    const io: ArtifactScanIo = {
      open: async (target, flags, mode) => {
        opens++;
        return fs.open(target, flags as never, mode as never);
      },
    };
    const resolved = { root: p("tree"), effectiveRoots: [p("tree")] };
    await expectFailure(
      verifyArtifactEntry(resolved, expectedFor("../outside.txt", "OUTSIDE"), { cache: createArtifactHashCache(), io }),
      "changed",
    );
    expect(opens).toBe(0);
  });

  it("an absolute path is `changed` even when that file's content matches", async () => {
    writeFileSync(p("outside.txt"), "OUTSIDE");
    mkdirSync(p("tree"));
    let opens = 0;
    const io: ArtifactScanIo = {
      open: async (target, flags, mode) => {
        opens++;
        return fs.open(target, flags as never, mode as never);
      },
    };
    const resolved = { root: p("tree"), effectiveRoots: [p("tree")] };
    await expectFailure(
      verifyArtifactEntry(resolved, { path: p("outside.txt"), hash: sha256("OUTSIDE"), size: 7 }, { cache: createArtifactHashCache(), io }),
      "changed",
    );
    expect(opens).toBe(0);
  });
});

describe("classification", () => {
  it("verifies a matching entry and returns it verbatim", async () => {
    writeFileSync(p("a.txt"), "hello");
    const result = await verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: createArtifactHashCache() });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.entry).toEqual({ path: "a.txt", hash: sha256("hello"), size: 5 });
  });

  it("a missing path is `missing`; a directory is `special_file`", async () => {
    await expectFailure(
      verifyArtifactEntry(root(), expectedFor("gone.txt", "x"), { cache: createArtifactHashCache() }),
      "missing",
    );
    mkdirSync(p("a-dir"));
    await expectFailure(
      verifyArtifactEntry(root(), expectedFor("a-dir", "x"), { cache: createArtifactHashCache() }),
      "special_file",
    );
  });

  it("rewritten content is `changed`", async () => {
    writeFileSync(p("a.txt"), "hello");
    writeFileSync(p("a.txt"), "world");
    await expectFailure(
      verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: createArtifactHashCache() }),
      "changed",
    );
  });

  it("a symlink is `symlink` with zero opens; a special file is `special_file`", async () => {
    writeFileSync(p("target.txt"), "TARGET");
    symlinkSync(p("target.txt"), p("link.txt"));
    let opens = 0;
    const io: ArtifactScanIo = {
      open: async (target, flags, mode) => {
        opens++;
        return fs.open(target, flags as never, mode as never);
      },
    };
    await expectFailure(
      verifyArtifactEntry(root(), expectedFor("link.txt", "TARGET"), { cache: createArtifactHashCache(), io }),
      "symlink",
    );
    expect(opens).toBe(0);

    const fifo = p("fifo");
    writeFileSync(fifo, "");
    const fakeSpecial = {
      dev: 1,
      ino: 2,
      size: 0,
      mtimeMs: 1,
      ctimeMs: 1,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => false,
    } as unknown as Stats;
    const specialIo: ArtifactScanIo = { lstat: async (target) => (target === fifo ? fakeSpecial : fs.lstat(target)) };
    await expectFailure(
      verifyArtifactEntry(root(), expectedFor("fifo", ""), { cache: createArtifactHashCache(), io: specialIo }),
      "special_file",
    );
  });

  it("an EACCES lstat is `unreadable`; an over-ceiling file is `too_large`", async () => {
    writeFileSync(p("a.txt"), "hello");
    const denied: ArtifactScanIo = {
      lstat: async (target) => {
        if (target === p("a.txt")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fs.lstat(target);
      },
    };
    await expectFailure(
      verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: createArtifactHashCache(), io: denied }),
      "unreadable",
    );

    const big = p("big.bin");
    writeFileSync(big, "");
    truncateSync(big, ARTIFACT_FILE_MAX_BYTES + 1);
    await expectFailure(
      verifyArtifactEntry(root(), { path: "big.bin", hash: sha256("x"), size: 1 }, { cache: createArtifactHashCache() }),
      "too_large",
    );
  });
});

describe("the cache is write-only here (U3)", () => {
  it("re-reads instead of trusting a cached hash whose identity still matches", async () => {
    // The cache's identity is the CURRENT one, so no identity rule can catch
    // the lie — only the re-read can. A cache fast-path would answer ok here.
    writeFileSync(p("a.txt"), "hello");
    const stat = await fs.lstat(p("a.txt"));
    const cache: ArtifactHashCache = createArtifactHashCache();
    cache.set(p("a.txt"), {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      hash: "f".repeat(64),
    });
    await expectFailure(
      verifyArtifactEntry(root(), { path: "a.txt", hash: "f".repeat(64), size: stat.size }, { cache }),
      "changed",
    );
  });

  it("detects a same-size rewrite (content moved, identity did too)", async () => {
    writeFileSync(p("a.txt"), "hello");
    const cache: ArtifactHashCache = createArtifactHashCache();
    writeFileSync(p("a.txt"), "world");
    await expectFailure(verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache }), "changed");
  });

  it("writes the verified identity back after a successful read", async () => {
    writeFileSync(p("a.txt"), "hello");
    const cache = createArtifactHashCache();
    const result = await verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}`);
    const cached = cache.get(p("a.txt"));
    expect(cached?.hash).toBe(sha256("hello"));
    const stat = await fs.lstat(p("a.txt"));
    expect({ dev: cached!.dev, ino: cached!.ino, size: cached!.size }).toEqual({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
    });
  });

  it("never caches a failed verification", async () => {
    writeFileSync(p("a.txt"), "world");
    const cache = createArtifactHashCache();
    await expectFailure(verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache }), "changed");
    expect(cache.size).toBe(0);
  });
});
