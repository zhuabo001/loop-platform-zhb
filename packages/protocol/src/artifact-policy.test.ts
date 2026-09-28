import { describe, expect, it } from "vitest";

import { prepareArtifactSyncRequestSchema } from "./artifact.js";
import {
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_MANIFEST_MAX_ENTRIES,
  ARTIFACT_MANIFEST_MAX_TOTAL_BYTES,
  ARTIFACT_PATH_MAX_UTF8_BYTES,
  ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES,
  ARTIFACT_SYNC_V1_CAPABILITY,
  NEVER_SYNC_DIRECTORY_RULES,
  NEVER_SYNC_FILE_RULES,
  canonicalJsonString,
  canonicalPreparePayloadString,
  canonicalWatchConfigString,
  hasArtifactSyncV1,
  isNeverSyncPath,
  normalizeManifestEntries,
  parseBoundedJsonText,
  validateArtifactPath,
} from "./artifact-policy.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function entry(path: string, hash = HASH_A, size = 1): { path: string; hash: string; size: number } {
  return { path, hash, size };
}

describe("AP1: path legality and traversal matrix", () => {
  it("accepts canonical POSIX relative paths, kept VERBATIM", () => {
    for (const path of [
      "a",
      "a/b/c",
      "a..b", // only EXACT "." and ".." segments reject
      "...",
      "x y/z.txt",
      "文档/报告.txt", // legal UTF-8, no normalization
      "-rf/something",
    ]) {
      expect(validateArtifactPath(path)).toEqual({ ok: true, path });
    }
  });

  it("rejects the traversal/malformation matrix with stable failure literals", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["/etc/passwd", "path_absolute"],
      ["//unc/path", "path_absolute"],
      ["C:/Users", "path_drive_letter"],
      ["c:foo", "path_drive_letter"],
      ["a\\b", "path_backslash"],
      ["C:\\Users", "path_backslash"], // backslash rejects before the drive letter
      ["a//b", "path_empty_segment"],
      ["a/", "path_empty_segment"],
      [".", "path_dot_segment"],
      ["..", "path_dot_segment"],
      ["a/./b", "path_dot_segment"],
      ["a/../b", "path_dot_segment"],
    ];
    for (const [path, failure] of cases) {
      const result = validateArtifactPath(path);
      expect(!result.ok && result.failure).toBe(failure);
    }
  });
});

describe("AP2: duplicate paths and file/dir conflicts", () => {
  it("rejects an exact duplicate path", () => {
    const result = normalizeManifestEntries([entry("a"), entry("a")]);
    expect(result).toMatchObject({ ok: false, failure: "duplicate_path", index: 1, path: "a" });
  });

  it("rejects file/dir conflicts in BOTH wire orders", () => {
    for (const paths of [
      ["a", "a/b"],
      ["a/b", "a"],
      ["a/b", "a/b/c"],
      ["a/b/c", "a/b"],
      ["a", "a/b/c"],
      ["a/b/c", "a"],
    ]) {
      const result = normalizeManifestEntries(paths.map((p) => entry(p)));
      expect(!result.ok && result.failure).toBe("file_dir_conflict");
    }
  });

  it("accepts sibling and prefix-free paths (a/b + a/c, a + ab)", () => {
    for (const paths of [
      ["a/b", "a/c"],
      ["a", "ab"],
      ["a/b", "a/b2"],
    ]) {
      const result = normalizeManifestEntries(paths.map((p) => entry(p)));
      expect(result.ok).toBe(true);
    }
  });

  it("reports the first failure in wire order deterministically", () => {
    // index 1 duplicates before index 2 could conflict.
    const result = normalizeManifestEntries([entry("x"), entry("x"), entry("x/y")]);
    expect(result).toMatchObject({ ok: false, failure: "duplicate_path", index: 1 });
  });
});

describe("AP3: NUL, malformed unicode and the UTF-8 byte-length boundary", () => {
  it("rejects NUL anywhere in the path", () => {
    expect(validateArtifactPath("a\0b")).toMatchObject({ ok: false, failure: "path_contains_nul" });
    expect(validateArtifactPath("\0")).toMatchObject({ ok: false, failure: "path_contains_nul" });
  });

  it("rejects unpaired surrogates (lone high and lone low)", () => {
    expect(validateArtifactPath("a\ud800b")).toMatchObject({ ok: false, failure: "path_malformed_unicode" });
    expect(validateArtifactPath("\udc00")).toMatchObject({ ok: false, failure: "path_malformed_unicode" });
  });

  it("measures the 1024-byte cap in UTF-8 BYTES, not UTF-16 code units", () => {
    // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes.
    expect(validateArtifactPath("é".repeat(512)).ok).toBe(true); // exactly 1024 bytes — inclusive
    expect(validateArtifactPath("é".repeat(511) + "a").ok).toBe(true); // 1023 bytes
    expect(validateArtifactPath("é".repeat(513))).toMatchObject({ ok: false, failure: "path_too_long" }); // 1026 bytes
    // UTF-16 length (600) is UNDER the cap while UTF-8 bytes (1200) are over.
    expect(validateArtifactPath("é".repeat(600))).toMatchObject({ ok: false, failure: "path_too_long" });
  });
});

describe("AP4: hash shape and same-hash-different-size", () => {
  it("rejects malformed hashes (length, case, alphabet)", () => {
    for (const hash of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), ""]) {
      const result = normalizeManifestEntries([entry("a", hash)]);
      expect(result).toMatchObject({ ok: false, failure: "hash_malformed", index: 0 });
    }
    expect(normalizeManifestEntries([entry("a", HASH_A)]).ok).toBe(true);
  });

  it("rejects negative, fractional, non-finite and unsafe-integer sizes; 0 is legal", () => {
    for (const size of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 53]) {
      const result = normalizeManifestEntries([entry("a", HASH_A, size)]);
      expect(result).toMatchObject({ ok: false, failure: "size_invalid", index: 0 });
    }
    expect(normalizeManifestEntries([entry("a", HASH_A, 0)]).ok).toBe(true);
  });

  it("rejects the same hash declared with different sizes, accepts it at many paths with one size", () => {
    const conflict = normalizeManifestEntries([entry("a", HASH_A, 1), entry("b", HASH_A, 2)]);
    expect(conflict).toMatchObject({ ok: false, failure: "hash_size_mismatch", index: 1 });
    const fine = normalizeManifestEntries([entry("a", HASH_A, 7), entry("b", HASH_A, 7), entry("c/d", HASH_A, 7)]);
    expect(fine.ok).toBe(true);
  });
});

describe("AP5: single-file byte cap (10 MiB, inclusive)", () => {
  it("accepts exactly 10 MiB and rejects 10 MiB + 1", () => {
    expect(normalizeManifestEntries([entry("a", HASH_A, ARTIFACT_FILE_MAX_BYTES)]).ok).toBe(true);
    const over = normalizeManifestEntries([entry("a", HASH_A, ARTIFACT_FILE_MAX_BYTES + 1)]);
    expect(over).toMatchObject({ ok: false, failure: "file_too_large" });
  });
});

describe("AP6: aggregate byte cap charged PER PATH", () => {
  it("accepts exactly 256 MiB and rejects 256 MiB + 1", () => {
    // 25 × 10 MiB + 6 291 456 = 268 435 456 exactly.
    const exact = Array.from({ length: 25 }, (_, i) => entry(`f${i}`, HASH_A, ARTIFACT_FILE_MAX_BYTES));
    exact.push(entry("tail", HASH_B, ARTIFACT_MANIFEST_MAX_TOTAL_BYTES - 25 * ARTIFACT_FILE_MAX_BYTES));
    expect(normalizeManifestEntries(exact).ok).toBe(true);
    exact.push(entry("one-more", HASH_C, 1));
    expect(normalizeManifestEntries(exact)).toMatchObject({ ok: false, failure: "manifest_too_large" });
  });

  it("charges identical content once PER PATH (dedupe applies to upload, not capacity)", () => {
    // 26 paths sharing ONE 10 MiB hash: 1 unique blob to upload, 260 MiB of manifest.
    const entries = Array.from({ length: 26 }, (_, i) => entry(`f${i}`, HASH_A, ARTIFACT_FILE_MAX_BYTES));
    expect(normalizeManifestEntries(entries)).toMatchObject({ ok: false, failure: "manifest_too_large" });
  });
});

describe("AP7: entry count cap (5000 inclusive)", () => {
  it("accepts 5000 entries and rejects 5001", () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => entry(`f${i}`, HASH_A, 0));
    expect(normalizeManifestEntries(build(5000)).ok).toBe(true);
    expect(normalizeManifestEntries(build(5001))).toMatchObject({ ok: false, failure: "too_many_entries" });
  });
});

describe("AP8: bounded raw-text JSON parsing (8 MiB over the RAW text)", () => {
  it("accepts a request of exactly the cap and rejects cap + 1", () => {
    const pad = (n: number) => `{"pad":"${"x".repeat(n)}"}`;
    const exact = pad(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES - 10); // {"pad":"…"} = pad + 10
    expect(exact.length).toBe(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES);
    expect(parseBoundedJsonText(exact, ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES).ok).toBe(true);
    expect(parseBoundedJsonText(pad(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES - 9), ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES))
      .toEqual({ ok: false, failure: "too_large" });
  });

  it("counts UNKNOWN fields toward the cap — stripping rescues nothing", () => {
    // The meaningful payload is tiny; the unknown padding field pushes the RAW
    // text over the limit. cap-on-raw precedes tolerant-reader strip (ADR-010 决策 5).
    const raw =
      `{"requestId":"r","loopId":"l","configRevision":1,"baseManifestRevision":0,"entries":[],` +
      `"pad":"${"x".repeat(1000)}"}`;
    expect(prepareArtifactSyncRequestSchema.parse(JSON.parse(raw))).toEqual({
      requestId: "r",
      loopId: "l",
      configRevision: 1,
      baseManifestRevision: 0,
      entries: [],
    }); // strips fine
    expect(parseBoundedJsonText(raw, 64)).toEqual({ ok: false, failure: "too_large" }); // but the cap already rejected it
  });

  it("classifies malformed JSON as not_json; the cap wins over syntax", () => {
    expect(parseBoundedJsonText("{nope", 64)).toEqual({ ok: false, failure: "not_json" });
    expect(parseBoundedJsonText("x".repeat(65), 64)).toEqual({ ok: false, failure: "too_large" }); // not even tried
  });

  it("parses values as unknown without schema validation (two composable steps)", () => {
    expect(parseBoundedJsonText('{"a":[1,true,null]}', 64)).toEqual({ ok: true, value: { a: [1, true, null] } });
    expect(parseBoundedJsonText("123", 64)).toEqual({ ok: true, value: 123 });
  });
});

describe("AP9: never-sync VCS / dependency / worktree / cache rules", () => {
  it("excludes VCS and dependency directories at ANY depth", () => {
    for (const path of [
      ".git",
      "a/.git",
      "a/.git/config",
      ".hg", "a/b/.hg/x",
      ".svn", "a/.svn/entries",
      "node_modules",
      "x/node_modules/y/index.js",
      ".worktrees", "a/.worktrees/w1/f",
    ]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("excludes tool caches and build directories", () => {
    for (const path of [
      ".venv/bin/python", "a/venv/bin", ".yarn/cache", ".pnpm-store/v3",
      ".cache/x", ".next/build", ".nuxt/dist", ".svelte-kit/out", ".turbo/cache",
      ".parcel-cache/lock", ".gradle/wrapper", "__pycache__/m.cpython-313.pyc",
      "a/.pytest_cache/v", ".mypy_cache/x", ".ruff_cache/x", ".tox/py/bin",
    ]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("excludes the control-directory prefixes", () => {
    for (const path of ["loopzhb-control-abc/x", "a/loopzhb-runs-1/state", "lzc-tmp/file"]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("matches ASCII-case-insensitively", () => {
    for (const path of [".GIT", "A/.Git/config", "Node_Modules/x", "LOOPZHB-CONTROL-1/x"]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("does NOT over-match lookalike names", () => {
    for (const path of ["git/keep", "my.gitignore", "node_modulesx/y", "lzc", "a/lzc", "venv2/x"]) {
      expect(isNeverSyncPath(path), path).toBe(false);
    }
  });
});

describe("AP10: never-sync control-directory and credential rules", () => {
  it("excludes control and credential directories, incl. the .config/gcloud segment PAIR", () => {
    for (const path of [
      ".loopzhb/x", "a/.loopany/state", ".claude/settings.json", ".codex/config",
      ".ssh/id_rsa", "home/.ssh/known_hosts", ".aws/credentials", ".azure/token",
      ".kube/config", ".gnupg/secring.gpg",
      ".config/gcloud/application_default_credentials.json",
      "home/user/.config/gcloud/logs/x",
    ]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("excludes credential FILES by basename", () => {
    for (const path of [
      ".DS_Store", "a/b/.DS_Store",
      ".env", ".env.local", "config/.env.production",
      ".npmrc", ".netrc", ".pypirc",
      "credentials", "a/credentials.json",
      "server.pem", "x/private.key",
      "id_rsa", "id_rsa.pub", "a/id_ed25519", "id_ed25519.pub",
    ]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("matches file rules ASCII-case-insensitively", () => {
    for (const path of [".ENV", "Config/.Env.Local", "ID_RSA", "CERT.PEM"]) {
      expect(isNeverSyncPath(path), path).toBe(true);
    }
  });

  it("does NOT over-match lookalike names", () => {
    for (const path of [
      ".envrc", // the rule is `.env` / `.env.*` — the literal dot guards this
      "a/keep.pem.bak",
      "credentials.txt",
      "a/credentials.json.bak",
      ".config/gcloudx/y", // not the exact segment pair
      "myid_rsa", // the rule is a PREFIX
    ]) {
      expect(isNeverSyncPath(path), path).toBe(false);
    }
  });
});

describe("AP11: whole-manifest rejection, normalization and order-independent fingerprint", () => {
  it("one illegal entry rejects the WHOLE manifest — no skip, no truncation", () => {
    const entries = Array.from({ length: 4999 }, (_, i) => entry(`f${i}`, HASH_A, 0));
    entries.push(entry("bad//path"));
    const result = normalizeManifestEntries(entries);
    expect(result).toMatchObject({ ok: false, failure: "path_empty_segment", index: 4999 });
    // A never-sync entry anywhere does the same.
    const withNeverSync = [entry("ok"), entry("x/.git/config")];
    expect(normalizeManifestEntries(withNeverSync)).toMatchObject({ ok: false, failure: "path_never_sync", index: 1 });
  });

  it("normalization sorts by path in UTF-16 code-unit order and keeps values verbatim", () => {
    const result = normalizeManifestEntries([entry("b"), entry("A"), entry("a"), entry("文档")]);
    expect(result.ok && result.entries.map((e) => e.path)).toEqual(["A", "a", "b", "文档"]);
  });

  it("the canonical payload is independent of the wire entry order", () => {
    const a = normalizeManifestEntries([entry("x", HASH_A, 1), entry("y", HASH_B, 2)]);
    const b = normalizeManifestEntries([entry("y", HASH_B, 2), entry("x", HASH_A, 1)]);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    const base = { loopId: "loop-01", configRevision: 3, baseManifestRevision: 2 };
    expect(canonicalPreparePayloadString({ ...base, entries: a.entries })).toBe(
      canonicalPreparePayloadString({ ...base, entries: b.entries }),
    );
  });

  it("every payload field perturbs the canonical string (incl. config/base revisions)", () => {
    const ok = normalizeManifestEntries([entry("a", HASH_A, 1)]);
    if (!ok.ok) throw new Error("expected ok");
    const base = { loopId: "loop-01", configRevision: 3, baseManifestRevision: 2, entries: ok.entries };
    const canonical = canonicalPreparePayloadString(base);
    const variants = [
      { ...base, loopId: "loop-02" },
      { ...base, configRevision: 4 },
      { ...base, baseManifestRevision: 3 },
      { ...base, entries: [{ path: "b", hash: HASH_A, size: 1 }] },
      { ...base, entries: [{ path: "a", hash: HASH_B, size: 1 }] },
      { ...base, entries: [{ path: "a", hash: HASH_A, size: 2 }] },
    ];
    for (const variant of variants) {
      expect(canonicalPreparePayloadString(variant)).not.toBe(canonical);
    }
  });

  it("stripped unknown fields never reach the fingerprint", () => {
    // The pipeline order is cap-on-raw → strip → validate → fingerprint-on-
    // normalized: an unknown field parses away BEFORE the fingerprint, so a
    // retry with/without it is the SAME payload (ADR-010 决策 6).
    const wire = { requestId: "r", loopId: "loop-01", configRevision: 3, baseManifestRevision: 2, entries: [entry("a")] };
    const stripped = prepareArtifactSyncRequestSchema.parse({ ...wire, futureField: { nested: [1] } });
    const ok = normalizeManifestEntries(stripped.entries);
    if (!ok.ok) throw new Error("expected ok");
    const fromStripped = canonicalPreparePayloadString({
      loopId: stripped.loopId,
      configRevision: stripped.configRevision,
      baseManifestRevision: stripped.baseManifestRevision,
      entries: ok.entries,
    });
    const baseline = canonicalPreparePayloadString({
      loopId: "loop-01",
      configRevision: 3,
      baseManifestRevision: 2,
      entries: ok.entries,
    });
    expect(fromStripped).toBe(baseline);
  });

  it("pins the canonical prepare string byte-for-byte (golden, hand-computed)", () => {
    const canonical = canonicalPreparePayloadString({
      loopId: "loop-01",
      configRevision: 3,
      baseManifestRevision: 2,
      entries: [{ path: "a.txt", hash: HASH_A, size: 12 }],
    });
    expect(canonical).toBe(
      `{"baseManifestRevision":2,"configRevision":3,"entries":[{"hash":"${HASH_A}","path":"a.txt","size":12}],"loopId":"loop-01"}`,
    );
  });

  it("canonicalJsonString sorts keys recursively, keeps array order, escapes like JSON", () => {
    expect(canonicalJsonString({ b: 1, a: { d: [3, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
    expect(canonicalJsonString([{ z: null, a: true }])).toBe('[{"a":true,"z":null}]');
    expect(canonicalJsonString("a\"b\\c")).toBe(JSON.stringify("a\"b\\c"));
    expect(canonicalJsonString(null)).toBe("null");
  });

  it("the watch-config canonical string is set-semantic (item order + root order/dupes ignored)", () => {
    const item = (loopId: string) => ({
      loopId,
      artifactDir: "dist",
      workdir: null,
      roots: ["/b", "/a", "/a"],
      configRevision: 1,
    });
    const one = canonicalWatchConfigString([item("l2"), item("l1")]);
    const two = canonicalWatchConfigString([item("l1"), item("l2")]);
    expect(one).toBe(two);
    expect(one).toBe(
      `[{"artifactDir":"dist","configRevision":1,"loopId":"l1","roots":["/a","/b"],"workdir":null},` +
        `{"artifactDir":"dist","configRevision":1,"loopId":"l2","roots":["/a","/b"],"workdir":null}]`,
    );
  });
});

describe("limits, rule tables and capability are pinned verbatim", () => {
  it("pins the limit constants (all INCLUSIVE bounds)", () => {
    expect(ARTIFACT_FILE_MAX_BYTES).toBe(10_485_760);
    expect(ARTIFACT_MANIFEST_MAX_TOTAL_BYTES).toBe(268_435_456);
    expect(ARTIFACT_MANIFEST_MAX_ENTRIES).toBe(5000);
    expect(ARTIFACT_PATH_MAX_UTF8_BYTES).toBe(1024);
    expect(ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES).toBe(8_388_608);
  });

  it("pins the never-sync rule tables against silent drift", () => {
    expect(NEVER_SYNC_DIRECTORY_RULES).toEqual([
      ".git", ".hg", ".svn", "node_modules", ".worktrees", ".venv", "venv", ".yarn", ".pnpm-store",
      ".cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".gradle", "__pycache__",
      ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".loopzhb", ".loopany", ".claude", ".codex",
      ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".config/gcloud",
      "loopzhb-control-*", "loopzhb-runs-*", "lzc-*",
    ]);
    expect(NEVER_SYNC_FILE_RULES).toEqual([
      ".DS_Store", ".env", ".env.*", ".npmrc", ".netrc", ".pypirc",
      "credentials", "credentials.json", "*.pem", "*.key", "id_rsa*", "id_ed25519*",
    ]);
  });

  it("pins the artifact-sync-v1 capability and its membership check", () => {
    expect(ARTIFACT_SYNC_V1_CAPABILITY).toBe("artifact-sync-v1");
    expect(hasArtifactSyncV1(["terminal-journal-v1", "artifact-sync-v1"])).toBe(true);
    expect(hasArtifactSyncV1(["terminal-journal-v1"])).toBe(false);
    expect(hasArtifactSyncV1([])).toBe(false);
    expect(hasArtifactSyncV1(null)).toBe(false);
    expect(hasArtifactSyncV1(undefined)).toBe(false);
  });
});
