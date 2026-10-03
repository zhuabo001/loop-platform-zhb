/**
 * Local-file BlobStore adapter — runs the ONE shared contract suite
 * (testkit/blob-store-contract.ts) over a real filesystem root, plus the
 * local-only pins below: restart read (AB9), tmp-residue audit (AB3), REAL
 * symlinks including the dangling case that forces lstat over stat
 * (AB10/#66), no-clobber publish, traversal never touching the fs, the
 * namespace-dir symlink guard, a concurrent same-key smoke (adapter-level
 * only — the full AB5 concurrency scenarios belong to slice 5), and
 * crash-leftover tmp inertness (this batch ships no GC).
 *
 * Every case gets its own mkdtemp root with pid+seq isolation — tests NEVER
 * audit the shared system tmpdir (the 75e7e04 flake lesson).
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import fs, { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBlobStoreContractSuite, type BlobStoreHarness } from "../testkit/blob-store-contract.js";
import type { BlobKey, BlobReadResult, BlobStore } from "./blob-store.js";
import { createLocalBlobStore } from "./blob-store-local.js";

let seq = 0;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function tmpRoot(): Promise<string> {
  seq += 1;
  const dir = await mkdtemp(path.join(tmpdir(), `loopzhb-blob-${process.pid}-${seq}-`));
  dirs.push(dir);
  return dir;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* chunks(bytes: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  for (let off = 0; off < bytes.byteLength; off += chunkSize) yield bytes.subarray(off, off + chunkSize);
}

function patternBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 17 + 3) & 0xff;
  return bytes;
}

/** Capture the real FileHandle from the adapter's read-open and observe the
 * close path without changing the production adapter or using process-wide
 * fd counts (which can include unrelated work). */
async function readWithTrackedClose(store: BlobStore, key: BlobKey): Promise<{
  result: Extract<BlobReadResult, { ok: true }>;
  closeSpy: ReturnType<typeof vi.spyOn>;
}> {
  const openSpy = vi.spyOn(fs, "open");
  try {
    const result = await store.read(key);
    if (!result.ok) throw new Error(`expected readable blob, got ${result.failure}`);
    const opened = openSpy.mock.results.at(-1)?.value as Promise<fs.FileHandle> | undefined;
    if (!opened) throw new Error("read did not open a FileHandle");
    const handle = await opened;
    return { result, closeSpy: vi.spyOn(handle, "close") };
  } finally {
    openSpy.mockRestore();
  }
}

/** A chunk stream that serves the real file and then THROWS after `after`
 *  chunks — the adapter's own reduction must turn this into the terminal
 *  storage_error stream element (the injected impl replaces the read path,
 *  so the conversion code under test is the real one). */
async function* failingStream(p: string, after: number): AsyncIterable<Uint8Array> {
  let i = 0;
  for await (const chunk of createReadStream(p)) {
    if (i >= after) throw new Error("injected mid-read EIO");
    yield chunk as Uint8Array;
    i += 1;
  }
  throw new Error("injected mid-read EIO"); // armed past EOF: still fails
}

async function makeHarness(): Promise<BlobStoreHarness> {
  const rootDir = await tmpRoot();
  const armed = new Map<string, number>(); // blob path → fail after N chunks
  const store = createLocalBlobStore({
    rootDir,
    io: {
      streamChunksImpl: (p) => {
        const after = armed.get(p);
        return after === undefined ? undefined : failingStream(p, after);
      },
    },
  });
  return {
    store,
    faults: {
      parkNotRegular(key) {
        const nsDir = path.join(rootDir, key.namespaceId);
        mkdirSync(nsDir, { recursive: true });
        // A DANGLING symlink — a stat-based (following) check would see
        // ENOENT and misclassify as absent; lstat sees the link itself.
        symlinkSync(path.join(rootDir, "no-such-target"), path.join(nsDir, key.hash));
      },
      failMidRead(key, afterChunks = 1) {
        armed.set(path.join(rootDir, key.namespaceId, key.hash), afterChunks);
      },
    },
    async cleanup() {},
  };
}

runBlobStoreContractSuite("local", makeHarness);

describe("local BlobStore specifics", () => {
  const NS = "ns-1";

  it("a new instance over the same rootDir reads blobs written by a previous instance (AB9 restart)", async () => {
    const rootDir = await tmpRoot();
    const bytes = patternBytes(70 * 1024);
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    const storeA = createLocalBlobStore({ rootDir });
    expect(await storeA.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunks(bytes, 999) })).toEqual({
      ok: true,
      size: bytes.byteLength,
      published: true,
    });
    const storeB = createLocalBlobStore({ rootDir }); // the "restarted" process
    expect(await storeB.has(key)).toEqual({ ok: true, present: true });
    const rd = await storeB.read(key);
    expect(rd.ok).toBe(true);
    if (!rd.ok) throw new Error("unreachable");
    expect(rd.size).toBe(bytes.byteLength);
    const parts: Uint8Array[] = [];
    for await (const element of rd.bytes) {
      expect(element.ok).toBe(true);
      if (element.ok) parts.push(element.chunk);
    }
    expect(Buffer.concat(parts.map((p) => Buffer.from(p))).equals(Buffer.from(bytes))).toBe(true);
  });

  it("failed writes leave NO residue in the namespace dir (AB3)", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const bytes = new TextEncoder().encode("residue audit");
    // Short stream (clean EOF, wrong size):
    await store.writeVerified({
      namespaceId: NS,
      hash: sha256Hex(bytes),
      expectedSize: bytes.byteLength + 5,
      bytes: chunks(bytes, 4),
    });
    // Hash mismatch:
    await store.writeVerified({
      namespaceId: NS,
      hash: sha256Hex(new TextEncoder().encode("other content!")),
      expectedSize: bytes.byteLength,
      bytes: chunks(bytes, 4),
    });
    // Source throwing mid-iteration:
    async function* throwingSource(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 4);
      throw new Error("transport reset");
    }
    await store.writeVerified({
      namespaceId: NS,
      hash: sha256Hex(bytes),
      expectedSize: bytes.byteLength,
      bytes: throwingSource(),
    });
    // The namespace dir exists (the writes got that far) but is EMPTY: no
    // tmp residue, no half-published blob.
    expect(await readdir(path.join(rootDir, NS))).toEqual([]);
  });

  it("classifies a dangling symlink, a directory and a symlink-to-a-real-file at the blob path as not_regular_file (AB10, #66)", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const nsDir = path.join(rootDir, NS);
    mkdirSync(nsDir, { recursive: true });
    const flavors: { label: string; park(p: string): void }[] = [
      { label: "dangling symlink", park: (p) => symlinkSync(path.join(rootDir, "no-such-target"), p) },
      { label: "directory", park: (p) => mkdirSync(p) },
      {
        label: "symlink to a real file",
        park: (p) => {
          const target = path.join(rootDir, "real-target");
          writeFileSync(target, "real bytes");
          symlinkSync(target, p);
        },
      },
    ];
    for (const [i, flavor] of flavors.entries()) {
      const key: BlobKey = { namespaceId: NS, hash: sha256Hex(new Uint8Array([i, i, i])) };
      flavor.park(path.join(nsDir, key.hash));
      expect(await store.has(key), flavor.label).toEqual({ ok: false, failure: "not_regular_file" });
      expect(await store.read(key), flavor.label).toEqual({ ok: false, failure: "not_regular_file" });
    }
  });

  it("publish is no-clobber: pre-existing different bytes at the final path stay untouched and the write reports published:false", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const good = new TextEncoder().encode("the negotiated content");
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(good) };
    const nsDir = path.join(rootDir, NS);
    mkdirSync(nsDir, { recursive: true });
    const oldBytes = new TextEncoder().encode("old bytes already parked here");
    writeFileSync(path.join(nsDir, key.hash), oldBytes);
    // The uploaded bytes verify against the key's hash — but the final path
    // is occupied, so nothing is published and the old bytes are NOT
    // repaired (read-side never re-verifies either — the same philosophy).
    expect(await store.writeVerified({ ...key, expectedSize: good.byteLength, bytes: chunks(good, 5) })).toEqual({
      ok: true,
      size: good.byteLength,
      published: false,
    });
    expect(readFileSync(path.join(nsDir, key.hash)).equals(Buffer.from(oldBytes))).toBe(true);
    expect(await store.has(key)).toEqual({ ok: true, present: true });
  });

  it("an invalid key never touches the filesystem (AB10)", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const validHash = sha256Hex(new Uint8Array([1]));
    for (const namespaceId of ["..", "a/b", "A_B", ""]) {
      await store.writeVerified({
        namespaceId,
        hash: validHash,
        expectedSize: 1,
        bytes: chunks(new Uint8Array([1]), 1),
      });
      await store.has({ namespaceId, hash: validHash });
      await store.read({ namespaceId, hash: validHash });
    }
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("refuses ALL three methods when the namespace dir is a symlink (storage_error), while a symlinked ROOT works fine", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const bytes = new TextEncoder().encode("guarded namespace");
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    // An out-of-band attacker swaps the namespace dir for a symlink —
    // writing through it would escape the root. Classified storage_error
    // (not_regular_file is typed for the blob target only).
    const elsewhere = path.join(rootDir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(rootDir, NS), "dir");
    const res = await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunks(bytes, 4) });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.failure).toBe("storage_error");
    // Nothing at all landed through the symlink (the guard fires before the
    // tmp file is even opened).
    expect(await readdir(elsewhere)).toEqual([]);
    // has/read refuse too (#73) — NEVER a clean present:false/blob_missing
    // that would route the key onto the re-upload path.
    const h = await store.has(key);
    expect(h.ok).toBe(false);
    if (h.ok) throw new Error("unreachable");
    expect(h.failure).toBe("storage_error");
    const r = await store.read(key);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure).toBe("storage_error");
    // A symlinked ROOT is a legitimate deployment shape (macOS tmpdir:
    // /var → /private/var) and must work untouched.
    const realRoot = await tmpRoot();
    seq += 1;
    const alias = path.join(tmpdir(), `loopzhb-blob-alias-${process.pid}-${seq}`);
    symlinkSync(realRoot, alias, "dir");
    dirs.push(alias); // rm(recursive) on a symlink removes the link itself
    const aliasStore = createLocalBlobStore({ rootDir: alias });
    expect(
      await aliasStore.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunks(bytes, 4) }),
    ).toEqual({ ok: true, size: bytes.byteLength, published: true });
    expect(await aliasStore.has(key)).toEqual({ ok: true, present: true });
    // The blob physically landed in the real root.
    expect(readFileSync(path.join(realRoot, NS, key.hash)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a symlinked namespace is never followed on has/read — no cross-namespace reads (#73)", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const bytes = new TextEncoder().encode("namespace B content");
    const keyB: BlobKey = { namespaceId: "ns-b", hash: sha256Hex(bytes) };
    expect(await store.writeVerified({ ...keyB, expectedSize: bytes.byteLength, bytes: chunks(bytes, 4) })).toEqual({
      ok: true,
      size: bytes.byteLength,
      published: true,
    });
    // Park ns-a as a symlink to ns-b: without the guard, has/read of
    // (ns-a, B's hash) would follow the link and serve B's blob under A's
    // namespace — a cross-namespace isolation break needing no race.
    symlinkSync(path.join(rootDir, "ns-b"), path.join(rootDir, "ns-a"), "dir");
    const viaA: BlobKey = { namespaceId: "ns-a", hash: keyB.hash };
    const h = await store.has(viaA);
    expect(h.ok).toBe(false);
    if (h.ok) throw new Error("unreachable");
    expect(h.failure).toBe("storage_error");
    const r = await store.read(viaA);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure).toBe("storage_error");
    // The real namespace is unaffected.
    expect(await store.has(keyB)).toEqual({ ok: true, present: true });
  });

  it("a namespace symlink to a directory OUTSIDE root is refused on has/read (#73)", async () => {
    const rootDir = await tmpRoot();
    const outsideRoot = await tmpRoot();
    const bytes = new TextEncoder().encode("outside root content");
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    writeFileSync(path.join(outsideRoot, key.hash), bytes);
    symlinkSync(outsideRoot, path.join(rootDir, NS), "dir");
    const store = createLocalBlobStore({ rootDir });
    const present = await store.has(key);
    expect(present.ok).toBe(false);
    if (!present.ok) expect(present.failure).toBe("storage_error");
    const read = await store.read(key);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure).toBe("storage_error");
    expect(readFileSync(path.join(outsideRoot, key.hash)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a returned read stream stays bound to the inode verified at open time — a later path swap cannot redirect it (#74)", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const bytes = new TextEncoder().encode("original inode content");
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    expect(
      await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunks(bytes, 5) }),
    ).toEqual({ ok: true, size: bytes.byteLength, published: true });
    const rd = await store.read(key);
    expect(rd.ok).toBe(true);
    if (!rd.ok) throw new Error("unreachable");
    expect(rd.size).toBe(bytes.byteLength);
    // Swap the PATH's target AFTER read() returned: a new inode with
    // different bytes takes over the name. A path-reopening stream would
    // serve the swapped bytes; the fd-bound stream serves the ORIGINAL inode.
    const p = path.join(rootDir, NS, key.hash);
    await rm(p);
    writeFileSync(p, "swapped-in other bytes");
    const parts: Uint8Array[] = [];
    for await (const element of rd.bytes) {
      expect(element.ok).toBe(true);
      if (element.ok) parts.push(element.chunk);
    }
    expect(Buffer.concat(parts.map((c) => Buffer.from(c))).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a read returned before a symlink swap never follows the swapped target (#74)", async () => {
    const rootDir = await tmpRoot();
    const outsideRoot = await tmpRoot();
    const bytes = new TextEncoder().encode("original blob bytes");
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    const store = createLocalBlobStore({ rootDir });
    expect(await store.writeVerified({ ...key, expectedSize: bytes.length, bytes: chunks(bytes, 4) })).toMatchObject({ ok: true });
    const rd = await store.read(key);
    expect(rd.ok).toBe(true);
    if (!rd.ok) throw new Error("unreachable");
    const outside = path.join(outsideRoot, "secret");
    writeFileSync(outside, "different outside bytes");
    const p = path.join(rootDir, NS, key.hash);
    await rm(p);
    symlinkSync(outside, p);
    const parts: Uint8Array[] = [];
    for await (const element of rd.bytes) {
      expect(element.ok).toBe(true);
      if (element.ok) parts.push(element.chunk);
    }
    expect(rd.size).toBe(bytes.length);
    expect(Buffer.concat(parts.map((part) => Buffer.from(part))).equals(Buffer.from(bytes))).toBe(true);
  });

  it("read releases its handle on EOF, mid-stream failure, early break, and explicit close before iteration (#74)", async () => {
    const rootDir = await tmpRoot();
    const bytes = patternBytes(130 * 1024);
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    const store = createLocalBlobStore({ rootDir });
    expect(await store.writeVerified({ ...key, expectedSize: bytes.length, bytes: chunks(bytes, 4096) })).toMatchObject({ ok: true });

    const eof = await readWithTrackedClose(store, key);
    for await (const element of eof.result.bytes) expect(element.ok).toBe(true);
    expect(eof.closeSpy).toHaveBeenCalledTimes(1);
    await eof.result.close();
    expect(eof.closeSpy).toHaveBeenCalledTimes(1);

    const early = await readWithTrackedClose(store, key);
    for await (const element of early.result.bytes) {
      expect(element.ok).toBe(true);
      break;
    }
    expect(early.closeSpy).toHaveBeenCalledTimes(1);

    const untouched = await readWithTrackedClose(store, key);
    await untouched.result.close();
    await untouched.result.close();
    expect(untouched.closeSpy).toHaveBeenCalledTimes(1);

    const failing = createLocalBlobStore({
      rootDir,
      io: { streamChunksImpl: () => (async function* () {
        yield new Uint8Array([1]);
        throw new Error("injected read fault");
      })() },
    });
    const midFault = await readWithTrackedClose(failing, key);
    const elements = [];
    for await (const element of midFault.result.bytes) elements.push(element);
    expect(elements.at(-1)).toMatchObject({ ok: false, failure: "storage_error" });
    expect(midFault.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("two concurrent same-key writes publish exactly once and leave no residue (adapter-level AB5 smoke)", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const bytes = patternBytes(100 * 1024);
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    const write = () => store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunks(bytes, 4096) });
    const [r1, r2] = await Promise.all([write(), write()]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    expect([r1.published, r2.published].sort()).toEqual([false, true]);
    expect(readFileSync(path.join(rootDir, NS, key.hash)).equals(Buffer.from(bytes))).toBe(true);
    // Exactly the published blob — zero tmp residue.
    expect(await readdir(path.join(rootDir, NS))).toEqual([key.hash]);
  });

  it("a crash-leftover .tmp-* file is inert: it never shadows or breaks later operations, and this batch does NOT garbage-collect it", async () => {
    const rootDir = await tmpRoot();
    const store = createLocalBlobStore({ rootDir });
    const bytes = new TextEncoder().encode("real blob content");
    const key: BlobKey = { namespaceId: NS, hash: sha256Hex(bytes) };
    expect(
      await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunks(bytes, 4) }),
    ).toEqual({ ok: true, size: bytes.byteLength, published: true });
    // Simulate a crash-mid-write leftover from another upload.
    const garbage = path.join(rootDir, NS, ".tmp-deadbeef");
    writeFileSync(garbage, "partial garbage");
    // Normal operations are unaffected: presence, read, and a fresh write
    // of other content all behave.
    expect(await store.has(key)).toEqual({ ok: true, present: true });
    const other = new TextEncoder().encode("other blob");
    const otherKey: BlobKey = { namespaceId: NS, hash: sha256Hex(other) };
    expect(await store.has(otherKey)).toEqual({ ok: true, present: false });
    expect(
      await store.writeVerified({ ...otherKey, expectedSize: other.byteLength, bytes: chunks(other, 3) }),
    ).toEqual({ ok: true, size: other.byteLength, published: true });
    // No GC this batch: the leftover is still there, byte-identical.
    expect(readFileSync(garbage).equals(Buffer.from("partial garbage"))).toBe(true);
  });
});
