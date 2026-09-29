/**
 * Local-filesystem BlobStore adapter (ADR-010 决策 14, Phase 5 Batch 1
 * slice 3). Layout: `<rootDir>/<namespaceId>/<hash>` — manifest paths NEVER
 * map to disk paths; the storage key is the safe (namespaceId, hash) shape
 * and both sides are regex-validated before any filesystem touch (AB10:
 * `NAMESPACE_ID_RE` excludes `/`, `.` and traversal outright, the hash is
 * ARTIFACT_HASH_RE from @loopzhb/protocol so wire and store never disagree).
 *
 * Write path: the byte stream is the ONLY source of truth (the SHARED
 * verifyByteStream pipeline counts real bytes and hashes while streaming).
 * Bytes land in an EXCLUSIVE tmp file (`.tmp-<uuid>`, O_EXCL) inside the
 * target namespace dir — the same filesystem — then fsync, close, and an
 * atomic NO-CLOBBER publish via link(2): EEXIST is the atomic test-and-set
 * that makes `published` honest (two concurrent same-key writes get exactly
 * one `published: true`; rename-always could only lstat before publishing —
 * dishonest under a TOCTOU race). EPERM/EXDEV on exotic mounts classify
 * `storage_error` — honest failure, never a silent rename fallback. Any
 * failure unlinks THIS upload's tmp file; nothing else is ever deleted (no
 * GC this batch — crash-leftover tmp files are inert by name shape).
 *
 * Presence/read: lstat everywhere — a symlink or special file parked at the
 * blob path is an ANOMALY classified `not_regular_file`, never a clean
 * absence (S1/#66: a clean `present: false` would route it onto the
 * re-upload path). The NAMESPACE dir is guarded the same way on ALL three
 * methods (#73): a symlink parked at `<root>/<ns>` is refused
 * (storage_error) instead of being followed into another namespace or out
 * of the root. Read is TWO-PHASE: opening failures come back in the
 * BlobReadResult union; a failure WHILE STREAMING surfaces as the terminal
 * `{ok:false, failure:"storage_error"}` stream element — the iterator never
 * throws for an I/O failure. The stream is bound to the fd VERIFIED AT OPEN
 * TIME (#74): read() opens once (O_NOFOLLOW closes the lstat→open swap
 * window), fstats that handle for the real size, and the returned bytes
 * read from THAT handle — a path swap after read() returns cannot redirect
 * the stream onto different bytes. The handle is closed when the stream
 * completes, fails, or the consumer breaks out; an `ok: true` result whose
 * stream is never iterated leaks the fd, so callers MUST drain or break the
 * iteration (the contract's consumers always drain).
 *
 * Batch 1 wires this module from TESTS ONLY — no production composition
 * (决策 16).
 */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ARTIFACT_HASH_RE } from "@loopzhb/protocol";

import {
  NAMESPACE_ID_RE,
  type BlobKey,
  type BlobPresenceResult,
  type BlobReadResult,
  type BlobStore,
  type BlobStreamChunk,
  type BlobWriteResult,
} from "./blob-store.js";
import { isLegalExpectedSize, verifyByteStream } from "./blob-store-verify.js";

export interface LocalBlobStoreOptions {
  /** The storage root. Construction has ZERO fs side effects; the root is
   *  never symlink-checked itself — macOS tmpdirs legitimately traverse a
   *  symlink (`/var` → `/private/var`). */
  rootDir: string;
  io?: {
    /** TEST-ONLY seam (the bounded-read `openImpl` precedent): replaces the
     *  per-read chunk stream so a test can inject a REAL mid-stream failure
     *  through the adapter's own reduction path (the terminal-element
     *  conversion is what gets exercised, not a hook point). Returning
     *  `undefined` falls back to the default fd-bound reader — the seam
     *  takes the path for convenience; the PRODUCTION default never
     *  re-opens by path (it streams from the handle verified at read()
     *  time, #74). */
    streamChunksImpl?: (path: string) => AsyncIterable<Uint8Array> | undefined;
  };
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined;
}

function isValidKey(key: BlobKey): boolean {
  return NAMESPACE_ID_RE.test(key.namespaceId) && ARTIFACT_HASH_RE.test(key.hash);
}

/** The namespace dir must be a REAL directory — a symlink parked at
 *  `<root>/<ns>` (out-of-band tampering) would be FOLLOWED by every path
 *  syscall underneath it, escaping the namespace or the root (#73: the write
 *  path had this guard, has/read did not). Classified storage_error —
 *  not_regular_file is typed for the blob target only. Returns the refusal,
 *  or null when the dir is real. THROWS ENOENT when the namespace does not
 *  exist — has/read map that to absent/missing, write never reaches it
 *  (mkdir ran first). */
async function nsDirGuard(nsDir: string): Promise<{ ok: false; failure: "storage_error"; cause: unknown } | null> {
  const nsStat = await fs.lstat(nsDir);
  if (nsStat.isSymbolicLink() || !nsStat.isDirectory()) {
    return { ok: false, failure: "storage_error", cause: new Error(`namespace dir is not a real directory: ${nsDir}`) };
  }
  return null;
}

/** The default chunk stream: reads from the ALREADY-OPEN, verified handle
 *  (#74) — never re-opens by path, so a path swap after read() returned
 *  cannot redirect the bytes onto a different file. Yields COPIES off one
 *  scratch buffer (a consumer may mutate its chunks). Iteration THROWS on a
 *  read error; the two-phase reduction lives in `streamBlob` below. */
async function* defaultStreamChunks(handle: fs.FileHandle): AsyncIterable<Uint8Array> {
  const scratch = new Uint8Array(64 * 1024);
  for (;;) {
    const { bytesRead } = await handle.read(scratch, 0, scratch.byteLength, null);
    if (bytesRead === 0) return;
    yield scratch.slice(0, bytesRead);
  }
}

/** The mid-stream reduction (S1): an I/O failure while streaming can no
 *  longer change the already-returned BlobReadResult, so it surfaces as the
 *  TERMINAL storage_error element and the stream ends — the iterator never
 *  throws. OWNS `handle`: closed when the stream completes, fails, or the
 *  consumer breaks out early (for-await's return() runs this finally). */
async function* streamBlob(
  handle: fs.FileHandle,
  path: string,
  impl: ((path: string) => AsyncIterable<Uint8Array> | undefined) | undefined,
): AsyncIterable<BlobStreamChunk> {
  try {
    const stream = impl?.(path) ?? defaultStreamChunks(handle);
    for await (const chunk of stream) yield { ok: true, chunk };
  } catch (cause) {
    yield { ok: false, failure: "storage_error", cause };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A single write(2) may legitimately short-write; loop until the whole
 *  chunk is on the fd (the adapter owns it exclusively). */
async function writeAll(handle: fs.FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0;
  while (off < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk.subarray(off));
    if (bytesWritten === 0) throw new Error("zero-byte write to blob tmp file");
    off += bytesWritten;
  }
}

export function createLocalBlobStore(options: LocalBlobStoreOptions): BlobStore {
  const rootDir = options.rootDir;
  const streamChunksImpl = options.io?.streamChunksImpl;
  const nsDirOf = (namespaceId: string): string => path.join(rootDir, namespaceId);
  const blobPathOf = (key: BlobKey): string => path.join(nsDirOf(key.namespaceId), key.hash);

  return {
    async writeVerified(input): Promise<BlobWriteResult> {
      if (!isValidKey(input)) return { ok: false, failure: "invalid_key" };
      // Domain-invalid declarations reject BEFORE any fs side effect and
      // without pulling the source (verifyByteStream re-checks internally).
      if (!isLegalExpectedSize(input.expectedSize)) return { ok: false, failure: "content_mismatch" };
      const nsDir = nsDirOf(input.namespaceId);
      const finalPath = blobPathOf(input);
      // The namespace dir must be a REAL directory (see nsDirGuard) — the
      // guard runs AFTER mkdir so a legitimately absent namespace is created,
      // but a parked symlink/file is refused before any tmp file opens.
      try {
        await fs.mkdir(nsDir, { recursive: true });
        const guard = await nsDirGuard(nsDir);
        if (guard) return guard;
      } catch (cause) {
        return { ok: false, failure: "storage_error", cause };
      }
      const tmpPath = path.join(nsDir, `.tmp-${randomUUID()}`);
      let handle: fs.FileHandle | null = null;
      /** Every failure path below unlinks THIS upload's tmp file (ignore
       *  errors — the failure being returned is the real one). */
      const cleanupTmp = async (): Promise<void> => {
        if (handle) {
          await handle.close().catch(() => {});
          handle = null;
        }
        await fs.unlink(tmpPath).catch(() => {});
      };
      try {
        handle = await fs.open(tmpPath, "wx");
      } catch (cause) {
        return { ok: false, failure: "storage_error", cause };
      }
      const verified = await verifyByteStream({
        expectedHash: input.hash,
        expectedSize: input.expectedSize,
        bytes: input.bytes,
        onChunk: async (chunk) => {
          if (handle) await writeAll(handle, chunk);
        },
      });
      if (!verified.ok) {
        await cleanupTmp();
        return verified;
      }
      try {
        await handle.sync();
        await handle.close();
        handle = null;
      } catch (cause) {
        await cleanupTmp();
        return { ok: false, failure: "storage_error", cause };
      }
      // Atomic no-clobber publish. EEXIST: lstat (NOT stat — a dangling
      // symlink would misclassify as ENOENT under stat) — an anomaly is
      // not_regular_file; a regular file is the already-published blob with
      // hash-identical content, reported published:false WITHOUT
      // re-verifying or repairing the old bytes (same philosophy as read).
      try {
        await fs.link(tmpPath, finalPath);
      } catch (cause) {
        if (errorCode(cause) === "EEXIST") {
          await cleanupTmp();
          try {
            const st = await fs.lstat(finalPath);
            if (st.isSymbolicLink() || !st.isFile()) return { ok: false, failure: "not_regular_file" };
            return { ok: true, size: verified.size, published: false };
          } catch (lstatCause) {
            return { ok: false, failure: "storage_error", cause: lstatCause };
          }
        }
        await cleanupTmp();
        return { ok: false, failure: "storage_error", cause };
      }
      await fs.unlink(tmpPath).catch(() => {});
      return { ok: true, size: verified.size, published: true };
    },

    async has(key): Promise<BlobPresenceResult> {
      if (!isValidKey(key)) return { ok: false, failure: "invalid_key" };
      try {
        // Same namespace-symlink guard as the write path (#73) — following a
        // parked symlink would read ANOTHER namespace's blobs (or worse). An
        // absent namespace is a clean absence (ENOENT below).
        const guard = await nsDirGuard(nsDirOf(key.namespaceId));
        if (guard) return guard;
        const st = await fs.lstat(blobPathOf(key));
        if (st.isSymbolicLink() || !st.isFile()) return { ok: false, failure: "not_regular_file" };
        return { ok: true, present: true };
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return { ok: true, present: false };
        return { ok: false, failure: "storage_error", cause };
      }
    },

    async read(key): Promise<BlobReadResult> {
      if (!isValidKey(key)) return { ok: false, failure: "invalid_key" };
      const p = blobPathOf(key);
      let handle: fs.FileHandle;
      let size: number;
      try {
        const guard = await nsDirGuard(nsDirOf(key.namespaceId));
        if (guard) return guard;
        const st = await fs.lstat(p);
        if (st.isSymbolicLink() || !st.isFile()) return { ok: false, failure: "not_regular_file" };
        // Open ONCE — O_NOFOLLOW closes the lstat→open race window (a
        // final-component symlink swapped in between fails ELOOP) — and keep
        // the handle: the returned stream reads from THIS verified fd (#74),
        // so a path swap after read() returns cannot redirect the bytes.
        // O_NOFOLLOW may be absent on non-POSIX platforms (?? 0) — the lstat
        // pre-check still classifies every parked symlink deterministically.
        handle = await fs.open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        // fstat the OPEN handle: the REAL size and file-ness of the inode
        // actually bound to the stream (the lstat above is pre-open). A
        // TOCTOU deletion after this point surfaces honestly as the
        // mid-stream terminal element, never a thrown iteration.
        const fst = await handle.stat().catch(async (statCause: unknown) => {
          await handle.close().catch(() => {});
          throw statCause;
        });
        if (!fst.isFile()) {
          await handle.close().catch(() => {});
          return { ok: false, failure: "not_regular_file" };
        }
        size = fst.size;
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return { ok: false, failure: "blob_missing" };
        if (errorCode(cause) === "ELOOP") return { ok: false, failure: "not_regular_file" };
        return { ok: false, failure: "storage_error", cause };
      }
      // streamBlob takes handle ownership — an ok:true read holds the fd
      // until the stream is drained or broken (see the module header).
      return { ok: true, size, bytes: streamBlob(handle, p, streamChunksImpl) };
    },
  };
}
