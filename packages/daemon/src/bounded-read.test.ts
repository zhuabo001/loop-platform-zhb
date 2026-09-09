/**
 * bounded-read pins (review ADV-4 / SPEC-2 / SPEC-4): no-follow open,
 * fstat-guarded regular-file + size ceiling, bounded allocation, and the
 * TEST-ONLY open seam that deterministically replays a check/use swap.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRegularFileNoFollow } from "./bounded-read.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "loopzhb-bounded-read-test-"));
  mkdirSync(path.join(base, "sub"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("readRegularFileNoFollow", () => {
  it("reads a regular file within the ceiling", async () => {
    const file = path.join(base, "f.txt");
    writeFileSync(file, "hello");
    const result = await readRegularFileNoFollow(file, 16);
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.bytes.toString("utf8")).toBe("hello");
    const stat = await fs.lstat(file);
    expect({ dev: result.dev, ino: result.ino }).toEqual({ dev: stat.dev, ino: stat.ino });
  });

  it("exactly maxBytes is ok; maxBytes+1 is too_large via fstat (no allocation)", async () => {
    const exact = path.join(base, "exact");
    writeFileSync(exact, Buffer.alloc(64, 0x61));
    expect((await readRegularFileNoFollow(exact, 64)).kind).toBe("ok");
    const over = path.join(base, "over");
    writeFileSync(over, Buffer.alloc(65, 0x61));
    expect((await readRegularFileNoFollow(over, 64)).kind).toBe("too_large");
  });

  it("a sparse file far beyond the ceiling is refused by fstat, instantly", async () => {
    const sparse = path.join(base, "sparse");
    writeFileSync(sparse, "x");
    truncateSync(sparse, 1024 * 1024 * 1024); // 1 GiB apparent size, ~no blocks
    const started = Date.now();
    expect((await readRegularFileNoFollow(sparse, 128)).kind).toBe("too_large");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a file that GROWS past the ceiling mid-read is still too_large (bounded buffer)", async () => {
    // fstat sees 4 bytes; the injected open appends beyond the ceiling before
    // the real open, so the read loop must stop at maxBytes+1.
    const file = path.join(base, "growing");
    writeFileSync(file, "abcd");
    const result = await readRegularFileNoFollow(file, 8, async (p, flags, mode) => {
      await fs.appendFile(p, "0123456789"); // 4 + 10 = 14 > 8
      return fs.open(p, flags as never, mode as never);
    });
    expect(result.kind).toBe("too_large");
  });

  it("a terminal symlink is refused (ELOOP), never followed", async () => {
    const outside = path.join(base, "outside");
    writeFileSync(outside, "OUTSIDE");
    const link = path.join(base, "sub", "link");
    symlinkSync(outside, link);
    expect((await readRegularFileNoFollow(link, 64)).kind).toBe("symlink");
  });

  it("a check/use swap between the caller's lstat and the open is caught (deterministic)", async () => {
    // The caller already lstat'ed `file` as regular; the injected open swaps
    // it for a symlink to an outside file before delegating — the exact
    // TOCTOU window from the review. O_NOFOLLOW turns it into `symlink`.
    const file = path.join(base, "record");
    writeFileSync(file, "record");
    const outside = path.join(base, "outside");
    writeFileSync(outside, "OUTSIDE");
    const result = await readRegularFileNoFollow(file, 64, async (p, flags, mode) => {
      rmSync(p);
      symlinkSync(outside, p);
      return fs.open(p, flags as never, mode as never);
    });
    expect(result.kind).toBe("symlink");
  });

  it("a directory is not_regular; missing is not_found; other errors unreadable", async () => {
    expect((await readRegularFileNoFollow(path.join(base, "sub"), 64)).kind).toBe("not_regular");
    expect((await readRegularFileNoFollow(path.join(base, "gone"), 64)).kind).toBe("not_found");
    expect((await readRegularFileNoFollow(path.join(base, "gone", "nested"), 64)).kind).toBe("not_found"); // ENOTDIR
    const file = path.join(base, "f");
    writeFileSync(file, "x");
    const result = await readRegularFileNoFollow(file, 64, async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(result.kind).toBe("unreadable");
  });
});
