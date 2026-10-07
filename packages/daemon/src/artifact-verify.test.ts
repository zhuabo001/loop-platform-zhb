/**
 * Pre-upload verification pins (slice 3, ADR-010 决策 23): the containment
 * guard reads nothing, the classification is finer than the wire taxonomy,
 * and verification ALWAYS re-reads and recomputes — the cache is written
 * back, never consulted.
 */
import { execFileSync } from "node:child_process";
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
import {
  readVerifiedArtifactEntry,
  verifyArtifactEntry,
  type ArtifactVerifiedRead,
  type ArtifactVerifyFailure,
  type ArtifactVerifyResult,
} from "./artifact-verify.js";

let base: string;

const p = (...parts: string[]): string => path.join(base, ...parts);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const root: () => ResolvedArtifactRoot = () => ({ root: base, effectiveRoots: [base] });

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

async function expectReadFailure(
  resultPromise: Promise<ArtifactVerifiedRead>,
  failure: ArtifactVerifyFailure,
  label = "readVerifiedArtifactEntry",
): Promise<void> {
  const result = await resultPromise;
  if (result.kind !== "failed") throw new Error(`${label}: expected a failure, got ok for ${result.entry.path}`);
  expect(result.failure, label).toBe(failure);
  expect("bytes" in result, label).toBe(false); // a failed read never hands back bytes
}

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

  it("a FIFO swapped in between lstat and open is `special_file`, promptly (#87)", async () => {
    // The same check/use window as the scanner's: a blocking open would wait
    // for a writer forever, so the verifier would hang instead of reporting.
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
    await expectFailure(
      withDeadline(
        verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: createArtifactHashCache(), io }),
        5000,
        "the FIFO-swapped verification",
      ),
      "special_file",
    );
    expect(handles).toHaveLength(1);
    expect(handles[0]!.fd).toBe(-1); // closed, not leaked
  });

  it("a post-read EACCES/EPERM is `unreadable`, not `changed` (#88)", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      writeFileSync(p("a.txt"), "hello");
      const target = p("a.txt");
      let looks = 0;
      const io: ArtifactScanIo = {
        lstat: async (absolutePath) => {
          if (absolutePath === target) {
            looks++;
            // 1st look = the read's own inspection, 2nd = the post-read one.
            if (looks === 2) throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return fs.lstat(absolutePath);
        },
      };
      await expectFailure(
        verifyArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: createArtifactHashCache(), io }),
        "unreadable",
      );
      rmSync(target);
    }
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

describe("readVerifiedArtifactEntry — the verified bytes ARE the upload bytes (U3)", () => {
  it("returns the entry plus exactly the bytes that hash to the declared sha256", async () => {
    const content = Buffer.from([0x00, 0x68, 0x69, 0xff, 0x0a, 0x00]); // binary, NUL-delimited
    writeFileSync(p("a.bin"), content);
    const declared = { path: "a.bin", hash: createHash("sha256").update(content).digest("hex"), size: content.length };
    const cache = createArtifactHashCache();
    const result = await readVerifiedArtifactEntry(root(), declared, { cache });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.bytes.equals(content)).toBe(true);
    expect(createHash("sha256").update(result.bytes).digest("hex")).toBe(declared.hash);
    expect(result.entry).toEqual(declared);
    // The cache key stays the ABSOLUTE path — the resolved read path, not the
    // manifest-relative one.
    expect(cache.get(p("a.bin"))?.hash).toBe(declared.hash);
  });

  it("hands back the verified bytes even after the path is rewritten (no re-read)", async () => {
    writeFileSync(p("a.txt"), "hello");
    const result = await readVerifiedArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: createArtifactHashCache() });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    writeFileSync(p("a.txt"), "world"); // drift between verification and upload
    expect(result.bytes.toString()).toBe("hello");
    expect(createHash("sha256").update(result.bytes).digest("hex")).toBe(sha256("hello"));
  });

  it("classifies every failure arm exactly as verifyArtifactEntry does", async () => {
    writeFileSync(p("plain.txt"), "hello");
    mkdirSync(p("a-dir"));
    symlinkSync(p("plain.txt"), p("a-link"));
    writeFileSync(p("denied.txt"), "hello");
    writeFileSync(p("big.bin"), "");
    truncateSync(p("big.bin"), ARTIFACT_FILE_MAX_BYTES + 1);
    const denied: ArtifactScanIo = {
      lstat: async (target) => {
        if (target === p("denied.txt")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fs.lstat(target);
      },
    };
    const arms: Array<{ name: string; path: string; hash: string; size: number; failure: ArtifactVerifyFailure; io?: ArtifactScanIo }> = [
      { name: "missing", path: "gone.txt", hash: sha256("x"), size: 1, failure: "missing" },
      { name: "symlink", path: "a-link", hash: sha256("hello"), size: 5, failure: "symlink" },
      { name: "special_file", path: "a-dir", hash: sha256("x"), size: 1, failure: "special_file" },
      { name: "unreadable", path: "denied.txt", hash: sha256("hello"), size: 5, failure: "unreadable", io: denied },
      { name: "too_large", path: "big.bin", hash: sha256("x"), size: 1, failure: "too_large" },
      { name: "changed", path: "plain.txt", hash: sha256("world"), size: 5, failure: "changed" },
    ];
    for (const arm of arms) {
      const expected = { path: arm.path, hash: arm.hash, size: arm.size };
      const plain = await verifyArtifactEntry(root(), expected, { cache: createArtifactHashCache(), io: arm.io });
      const read = await readVerifiedArtifactEntry(root(), expected, { cache: createArtifactHashCache(), io: arm.io });
      expect(plain.kind, arm.name).toBe("failed");
      expect(read.kind, arm.name).toBe("failed");
      if (plain.kind !== "failed" || read.kind !== "failed") throw new Error(arm.name);
      expect(plain.failure, arm.name).toBe(arm.failure);
      expect(read.failure, arm.name).toBe(arm.failure);
      expect("bytes" in read, arm.name).toBe(false);
    }
  });

  it("still refuses an escaping path FIRST — zero opens, zero bytes, zero cache writes", async () => {
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
    const cache = createArtifactHashCache();
    await expectReadFailure(
      readVerifiedArtifactEntry(resolved, expectedFor("../outside.txt", "OUTSIDE"), { cache, io }),
      "changed",
      "the `..` chain",
    );
    await expectReadFailure(
      readVerifiedArtifactEntry(resolved, { path: p("outside.txt"), hash: sha256("OUTSIDE"), size: 7 }, { cache, io }),
      "changed",
      "the absolute path",
    );
    expect(opens).toBe(0);
    expect(cache.size).toBe(0);
  });

  it("writes the cache only on success — never for a failure", async () => {
    writeFileSync(p("a.txt"), "hello");
    const ok = createArtifactHashCache();
    const result = await readVerifiedArtifactEntry(root(), expectedFor("a.txt", "hello"), { cache: ok });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(ok.get(p("a.txt"))?.hash).toBe(sha256("hello"));

    const mismatch = createArtifactHashCache();
    await expectReadFailure(
      readVerifiedArtifactEntry(root(), expectedFor("a.txt", "world"), { cache: mismatch }),
      "changed",
      "the content mismatch",
    );
    expect(mismatch.size).toBe(0);

    writeFileSync(p("big.bin"), "");
    truncateSync(p("big.bin"), ARTIFACT_FILE_MAX_BYTES + 1);
    const over = createArtifactHashCache();
    await expectReadFailure(
      readVerifiedArtifactEntry(root(), { path: "big.bin", hash: sha256("x"), size: 1 }, { cache: over }),
      "too_large",
      "the over-ceiling file",
    );
    expect(over.size).toBe(0);
  });

  it("a file rewritten mid-read is `changed`, with no bytes", async () => {
    writeFileSync(p("a.txt"), "abc");
    let opens = 0;
    const io: ArtifactScanIo = {
      open: async (target, flags, mode) => {
        if (++opens === 1) await fs.appendFile(target as string, "EXTRA");
        return fs.open(target, flags as never, mode as never);
      },
    };
    await expectReadFailure(
      readVerifiedArtifactEntry(root(), expectedFor("a.txt", "abc"), { cache: createArtifactHashCache(), io }),
      "changed",
    );
  });
});
