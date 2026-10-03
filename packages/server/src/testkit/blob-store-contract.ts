/**
 * The ONE BlobStore contract suite, run against BOTH adapters (ADR-010
 * 决策 14: the in-memory and local adapters share one contract test — this
 * file IS the AB10 dual-adapter parity evidence, and carries the
 * adapter-level closure evidence for #66: a mid-read I/O failure surfaces as
 * the terminal `{ok:false, failure:"storage_error"}` stream element with no
 * iterator throw (a), and a symlink/special file parked at the blob path
 * classifies `not_regular_file`, never a clean absence (b)).
 *
 * Lives in testkit, NOT src/artifact/: tsconfig.build.json excludes only
 * `src/**​/*.test.ts` and `src/testkit/**` — a non-test suite helper under
 * src/artifact/ would ship in dist with a vitest (devDependency) import.
 * Imported directly by path (`../testkit/blob-store-contract.js`); the
 * testkit index barrel is deliberately left untouched so nothing else pulls
 * vitest transitively.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { ARTIFACT_FILE_MAX_BYTES } from "@loopzhb/protocol";

import type { BlobKey, BlobStore, BlobStreamChunk } from "../artifact/blob-store.js";

/** One adapter under test plus its TEST-ONLY fault seams. A fresh harness is
 *  created per case and cleaned up in afterEach (the mount.test.ts
 *  dirs/handles precedent). */
export interface BlobStoreHarness {
  readonly store: BlobStore;
  readonly faults: {
    /** Park an anomaly at the key's blob location (local: a dangling
     *  symlink; memory: the notRegularKeys set) — has/read/write must
     *  classify it `not_regular_file`, NEVER a clean absence. */
    parkNotRegular(key: BlobKey): void | Promise<void>;
    /** Arm a mid-read storage failure: the next read of key yields
     *  `afterChunks` (default 1) good chunks, then the terminal
     *  `{ok:false, failure:"storage_error"}` element. */
    failMidRead(key: BlobKey, afterChunks?: number): void | Promise<void>;
  };
  cleanup(): Promise<void>;
}

const NS = "ns-1";
const NS2 = "ns-2";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A deterministic multi-chunk source over `bytes` (ragged tail included). */
async function* chunkedSource(bytes: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  for (let off = 0; off < bytes.byteLength; off += chunkSize) {
    yield bytes.subarray(off, off + chunkSize);
  }
}

/** A source recording how many chunks the store actually pulled. */
function countingSource(
  bytes: Uint8Array,
  chunkSize: number,
  counter: { pulled: number },
): AsyncIterable<Uint8Array> {
  const inner = chunkedSource(bytes, chunkSize);
  return (async function* () {
    for await (const chunk of inner) {
      counter.pulled += 1;
      yield chunk;
    }
  })();
}

/** Collect a read stream WITHOUT try/catch — the contract is that the
 *  iterator never throws for an I/O failure; a terminal {ok:false} element
 *  ends the stream. */
async function collect(stream: AsyncIterable<BlobStreamChunk>): Promise<BlobStreamChunk[]> {
  const elements: BlobStreamChunk[] = [];
  for await (const element of stream) elements.push(element);
  return elements;
}

function okBytes(elements: BlobStreamChunk[]): Buffer {
  return Buffer.concat(elements.flatMap((e) => (e.ok ? [Buffer.from(e.chunk)] : [])));
}

/** 256 KiB of deterministic binary content (no RNG — no flake surface). */
function binaryPayload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

export function runBlobStoreContractSuite(
  name: string,
  makeHarness: () => BlobStoreHarness | Promise<BlobStoreHarness>,
): void {
  describe(`BlobStore contract (${name} adapter)`, () => {
    const harnesses: BlobStoreHarness[] = [];
    afterEach(async () => {
      await Promise.all(harnesses.splice(0).map((h) => h.cleanup().catch(() => {})));
    });
    async function harness(): Promise<BlobStoreHarness> {
      const h = await makeHarness();
      harnesses.push(h);
      return h;
    }

    it("rejects unsafe storage keys on ALL three methods, never as a clean absence (AB10)", async () => {
      const { store } = await harness();
      const validHash = sha256Hex(new Uint8Array([1]));
      const source = new Uint8Array([1]);
      const badKeys: BlobKey[] = [
        ...["", "..", "a/b", "A_B", "-lead", "a".repeat(65)].map((namespaceId) => ({
          namespaceId,
          hash: validHash,
        })),
        ...["a".repeat(63), "A".repeat(64), "g".repeat(64), ""].map((hash) => ({
          namespaceId: NS,
          hash,
        })),
      ];
      for (const key of badKeys) {
        // has() must NOT swallow an invalid key into present:false — that
        // would route it onto the re-upload path (blob-store.ts has() TSDoc).
        expect(await store.has(key)).toEqual({ ok: false, failure: "invalid_key" });
        expect(await store.read(key)).toEqual({ ok: false, failure: "invalid_key" });
        const counter = { pulled: 0 };
        expect(
          await store.writeVerified({
            ...key,
            expectedSize: source.byteLength,
            bytes: countingSource(source, 1, counter),
          }),
        ).toEqual({ ok: false, failure: "invalid_key" });
        expect(counter.pulled).toBe(0); // an invalid key never consumes the source
      }
    });

    it("roundtrips the empty blob, 256 KiB binary and a small multi-chunk blob (AB9)", async () => {
      const { store } = await harness();
      const empty = new Uint8Array(0);
      expect(sha256Hex(empty)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      const payloads = [
        { label: "empty", bytes: empty, chunkSize: 1 },
        { label: "256 KiB binary", bytes: binaryPayload(256 * 1024), chunkSize: 1000 },
        { label: "small multi-chunk", bytes: new TextEncoder().encode("hello artifact blob"), chunkSize: 3 },
      ];
      for (const p of payloads) {
        const key = { namespaceId: NS, hash: sha256Hex(p.bytes) };
        expect(
          await store.writeVerified({ ...key, expectedSize: p.bytes.byteLength, bytes: chunkedSource(p.bytes, p.chunkSize) }),
          p.label,
        ).toEqual({ ok: true, size: p.bytes.byteLength, published: true });
        expect(await store.has(key), p.label).toEqual({ ok: true, present: true });
        const rd = await store.read(key);
        expect(rd.ok, p.label).toBe(true);
        if (!rd.ok) throw new Error("unreachable");
        expect(rd.size, p.label).toBe(p.bytes.byteLength);
        const elements = await collect(rd.bytes);
        expect(elements.every((e) => e.ok), p.label).toBe(true);
        expect(okBytes(elements).equals(Buffer.from(p.bytes)), p.label).toBe(true);
      }
    });

    it("classifies a clean-EOF short stream as content_mismatch and publishes nothing (AB3)", async () => {
      const { store } = await harness();
      const bytes = new TextEncoder().encode("six-by");
      const key = { namespaceId: NS, hash: sha256Hex(bytes) };
      expect(
        await store.writeVerified({ ...key, expectedSize: bytes.byteLength + 5, bytes: chunkedSource(bytes, 2) }),
      ).toEqual({ ok: false, failure: "content_mismatch" });
      expect(await store.has(key)).toEqual({ ok: true, present: false });
    });

    it("short-circuits a stream running PAST expectedSize without draining the source (AB3)", async () => {
      const { store } = await harness();
      const bytes = new Uint8Array(10).fill(7);
      const key = { namespaceId: NS, hash: sha256Hex(bytes.slice(0, 3)) };
      const counter = { pulled: 0 };
      expect(
        await store.writeVerified({ ...key, expectedSize: 3, bytes: countingSource(bytes, 1, counter) }),
      ).toEqual({ ok: false, failure: "content_mismatch" });
      expect(counter.pulled).toBeLessThan(10); // cancelled via the iterator's return()
      expect(await store.has(key)).toEqual({ ok: true, present: false });
    });

    it("classifies a byte-exact but hash-wrong stream as content_mismatch", async () => {
      const { store } = await harness();
      const bytes = new TextEncoder().encode("real content");
      const key = { namespaceId: NS, hash: sha256Hex(new TextEncoder().encode("other stuff!")) };
      expect(
        await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunkedSource(bytes, 4) }),
      ).toEqual({ ok: false, failure: "content_mismatch" });
      expect(await store.has(key)).toEqual({ ok: true, present: false });
    });

    it("classifies a source THROWING mid-iteration as storage_error and publishes nothing (AB3)", async () => {
      const { store } = await harness();
      const head = new Uint8Array([1, 2, 3]);
      const key = { namespaceId: NS, hash: sha256Hex(head) };
      async function* throwingSource(): AsyncIterable<Uint8Array> {
        yield head;
        throw new Error("transport reset");
      }
      const res = await store.writeVerified({ ...key, expectedSize: 6, bytes: throwingSource() });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.failure).toBe("storage_error");
      expect(res.cause).toBeInstanceOf(Error);
      expect(await store.has(key)).toEqual({ ok: true, present: false });
    });

    it("a duplicate PUT of the SAME correct bytes verifies again and reports published:false", async () => {
      const { store } = await harness();
      const bytes = new TextEncoder().encode("duplicate me");
      const key = { namespaceId: NS, hash: sha256Hex(bytes) };
      expect(
        await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunkedSource(bytes, 5) }),
      ).toEqual({ ok: true, size: bytes.byteLength, published: true });
      expect(
        await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunkedSource(bytes, 2) }),
      ).toEqual({ ok: true, size: bytes.byteLength, published: false });
      const rd = await store.read(key);
      expect(rd.ok).toBe(true);
      if (!rd.ok) throw new Error("unreachable");
      expect(okBytes(await collect(rd.bytes)).equals(Buffer.from(bytes))).toBe(true);
    });

    it("a duplicate PUT of WRONG bytes for an existing hash is content_mismatch — bytes are checked even when the target exists", async () => {
      const { store } = await harness();
      const good = new TextEncoder().encode("the good bytes");
      const bad = new TextEncoder().encode("the BAD!! bytes"); // same length, different content
      const key = { namespaceId: NS, hash: sha256Hex(good) };
      expect(
        await store.writeVerified({ ...key, expectedSize: good.byteLength, bytes: chunkedSource(good, 5) }),
      ).toEqual({ ok: true, size: good.byteLength, published: true });
      expect(
        await store.writeVerified({ ...key, expectedSize: bad.byteLength, bytes: chunkedSource(bad, 3) }),
      ).toEqual({ ok: false, failure: "content_mismatch" });
      // The original content is untouched.
      const rd = await store.read(key);
      expect(rd.ok).toBe(true);
      if (!rd.ok) throw new Error("unreachable");
      expect(okBytes(await collect(rd.bytes)).equals(Buffer.from(good))).toBe(true);
    });

    it("reports missing blobs distinctly on has (present:false) and read (blob_missing)", async () => {
      const { store } = await harness();
      const key = { namespaceId: NS, hash: sha256Hex(new Uint8Array([9])) };
      expect(await store.has(key)).toEqual({ ok: true, present: false });
      expect(await store.read(key)).toEqual({ ok: false, failure: "blob_missing" });
    });

    it("classifies a symlink/special file parked at the blob path as not_regular_file on ALL three methods, never a clean absence (AB10, #66)", async () => {
      const { store, faults } = await harness();
      const bytes = new TextEncoder().encode("anomaly target");
      const key = { namespaceId: NS, hash: sha256Hex(bytes) };
      await faults.parkNotRegular(key);
      expect(await store.has(key)).toEqual({ ok: false, failure: "not_regular_file" });
      expect(await store.read(key)).toEqual({ ok: false, failure: "not_regular_file" });
      // The write verifies its bytes FIRST and still refuses at publish
      // (both adapters classify in the same order).
      expect(
        await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunkedSource(bytes, 4) }),
      ).toEqual({ ok: false, failure: "not_regular_file" });
    });

    it("a mid-read storage failure arrives as a TERMINAL stream element — the iterator never throws (AB10, #66)", async () => {
      const { store, faults } = await harness();
      const bytes = binaryPayload(200 * 1024); // multi-chunk on both adapters
      const key = { namespaceId: NS, hash: sha256Hex(bytes) };
      expect(
        await store.writeVerified({ ...key, expectedSize: bytes.byteLength, bytes: chunkedSource(bytes, 4096) }),
      ).toEqual({ ok: true, size: bytes.byteLength, published: true });
      await faults.failMidRead(key, 1);
      const rd = await store.read(key);
      expect(rd.ok).toBe(true); // the failure is mid-stream, NOT opening-time
      if (!rd.ok) throw new Error("unreachable");
      expect(rd.size).toBe(bytes.byteLength);
      const elements = await collect(rd.bytes); // no try/catch — must not throw
      const failures = elements.filter((e) => !e.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ ok: false, failure: "storage_error" });
      // The terminal element is LAST — the stream ends right after it, with
      // at least one good chunk delivered before the failure.
      expect(elements.at(-1)).toBe(failures[0]);
      expect(elements.length).toBeGreaterThan(1);
      const received = okBytes(elements);
      expect(received.byteLength).toBeGreaterThan(0);
      expect(received.byteLength).toBeLessThan(bytes.byteLength);
    });

    it("isolates namespaces: the same hash is invisible across namespaces (AB10)", async () => {
      const { store } = await harness();
      const bytesA = new TextEncoder().encode("namespace A content");
      const bytesB = new TextEncoder().encode("namespace B content!!");
      const keyA = { namespaceId: NS, hash: sha256Hex(bytesA) };
      const keyB = { namespaceId: NS2, hash: sha256Hex(bytesB) };
      expect(
        await store.writeVerified({ ...keyA, expectedSize: bytesA.byteLength, bytes: chunkedSource(bytesA, 4) }),
      ).toEqual({ ok: true, size: bytesA.byteLength, published: true });
      // A's hash is absent in B's namespace.
      expect(await store.has({ namespaceId: NS2, hash: keyA.hash })).toEqual({ ok: true, present: false });
      expect(await store.read({ namespaceId: NS2, hash: keyA.hash })).toEqual({ ok: false, failure: "blob_missing" });
      // B stores its own different content and reads it back.
      expect(
        await store.writeVerified({ ...keyB, expectedSize: bytesB.byteLength, bytes: chunkedSource(bytesB, 4) }),
      ).toEqual({ ok: true, size: bytesB.byteLength, published: true });
      const rd = await store.read(keyB);
      expect(rd.ok).toBe(true);
      if (!rd.ok) throw new Error("unreachable");
      expect(okBytes(await collect(rd.bytes)).equals(Buffer.from(bytesB))).toBe(true);
    });

    it("rejects an out-of-domain expectedSize as content_mismatch WITHOUT pulling the source", async () => {
      const { store } = await harness();
      const bytes = new TextEncoder().encode("domain guard");
      const key = { namespaceId: NS, hash: sha256Hex(bytes) };
      for (const expectedSize of [ARTIFACT_FILE_MAX_BYTES + 1, -1, Number.NaN, 1.5]) {
        const counter = { pulled: 0 };
        expect(
          await store.writeVerified({ ...key, expectedSize, bytes: countingSource(bytes, 1, counter) }),
        ).toEqual({ ok: false, failure: "content_mismatch" });
        expect(counter.pulled).toBe(0);
      }
    });

    it("stores exactly the bytes the hash covered even when the source REUSES one buffer across yields (#75)", async () => {
      const { store } = await harness();
      // A contract-legal hostile source: the SAME buffer object yielded twice,
      // mutated between yields. Verification hashes [0x41, 0x42] (the content
      // AT EACH YIELD); an adapter retaining the reference would store
      // [0x42, 0x42] — verified bytes and stored bytes diverging.
      const reused = new Uint8Array([0x41]);
      async function* reusingSource(): AsyncIterable<Uint8Array> {
        yield reused;
        reused[0] = 0x42;
        yield reused;
      }
      const asYielded = new Uint8Array([0x41, 0x42]);
      const key = { namespaceId: NS, hash: sha256Hex(asYielded) };
      expect(await store.writeVerified({ ...key, expectedSize: 2, bytes: reusingSource() })).toEqual({
        ok: true,
        size: 2,
        published: true,
      });
      const rd = await store.read(key);
      expect(rd.ok).toBe(true);
      if (!rd.ok) throw new Error("unreachable");
      expect(okBytes(await collect(rd.bytes)).equals(Buffer.from(asYielded))).toBe(true);
    });

    it("lets a caller close a successful read without starting iteration (#74)", async () => {
      const { store } = await harness();
      const bytes = new TextEncoder().encode("unconsumed read");
      const key = { namespaceId: NS, hash: sha256Hex(bytes) };
      expect(await store.writeVerified({ ...key, expectedSize: bytes.length, bytes: chunkedSource(bytes, 3) })).toMatchObject({ ok: true });
      const rd = await store.read(key);
      expect(rd.ok).toBe(true);
      if (!rd.ok) throw new Error("unreachable");
      await rd.close();
      await rd.close(); // idempotent even when the stream was never started
    });
  });
}
