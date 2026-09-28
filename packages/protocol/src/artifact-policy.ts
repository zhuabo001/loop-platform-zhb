/**
 * Artifact policy — the Phase 5 manifest/path/limit rules daemon and server
 * must execute identically (ADR-010; ADR-002 决策 4 的第二个窄例外).
 *
 * Why this module exists: a manifest is validated TWICE — by the daemon
 * (local pre-classification while scanning, before the network is involved)
 * and again by the server as a defensive layer (it never trusts the daemon).
 * Two copies would drift, so the single source lives here in the protocol
 * package, next to terminal-policy.ts (the first recorded exception). The
 * artifactDir workdir/jail rule is a SINGLE-SIDE server rule and deliberately
 * does NOT live here (ADR-010 决策 8).
 *
 * Pure functions only: no I/O, no clock, no node builtins (TextEncoder is a
 * Web standard global, available in browsers and modern node alike). SHA-256
 * composition lives in the `./node` subpath, never here.
 */
import type { ArtifactManifestEntry, ArtifactWatchItem } from "./artifact.js";
import type { JsonValue } from "./json.js";

// ---- shared byte measurement ----

const encoder = new TextEncoder();

/** Exact UTF-8 byte length. Fast path: a string longer than `maxBytes` in
 *  UTF-16 code units is always over (UTF-8 never shrinks). Private copy — the
 *  same helper lives in terminal-policy.ts; small pure helpers stay
 *  module-private until a real cross-module caller exists. */
function utf8BytesExceed(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true;
  return encoder.encode(value).length > maxBytes;
}

/** True when `value` contains an unpaired UTF-16 surrogate (lone high or low). */
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1); // NaN past the end — fails the pair test
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ---- capability (declared in Batch 1; the claim gate opens in Batch 2) ----

/** The capability artifact sync gates on: loops with an artifactDir require
 *  it, unconfigured loops keep the old claim conditions (ADR-010 决策 16). */
export const ARTIFACT_SYNC_V1_CAPABILITY = "artifact-sync-v1";

/** Membership check — never a version-string comparison. */
export function hasArtifactSyncV1(capabilities: readonly string[] | null | undefined): boolean {
  return capabilities?.includes(ARTIFACT_SYNC_V1_CAPABILITY) ?? false;
}

// ---- limits (ADR-010 决策 3 — every bound is INCLUSIVE) ----

/** Single-file ceiling: 10 MiB. */
export const ARTIFACT_FILE_MAX_BYTES = 10_485_760;
/** Current complete manifest ceiling: 256 MiB, charged PER PATH (the same
 *  content at N paths costs N×size; only upload content dedupes by hash). */
export const ARTIFACT_MANIFEST_MAX_TOTAL_BYTES = 268_435_456;
/** Current complete manifest ceiling: 5000 entries. */
export const ARTIFACT_MANIFEST_MAX_ENTRIES = 5000;
/** Per-path ceiling: 1024 UTF-8 bytes. */
export const ARTIFACT_PATH_MAX_UTF8_BYTES = 1024;
/** Prepare-request ceiling: 8 MiB over the RAW request text, measured before
 *  JSON.parse so unknown fields count too (ADR-010 决策 5). */
export const ARTIFACT_PREPARE_REQUEST_MAX_UTF8_BYTES = 8_388_608;
/** Pending sync-session lifetime: 1 hour, judged by the server's injected
 *  Clock. A committed receipt never expires. */
export const ARTIFACT_SYNC_SESSION_TTL_MILLIS = 3_600_000;

/** The one hash shape: 64 lowercase hex chars (SHA-256). It is also the
 *  BlobStore's storage-key shape — the server imports it from here so the
 *  wire and the store can never disagree. */
export const ARTIFACT_HASH_RE = /^[0-9a-f]{64}$/;

// ---- never-sync (ADR-010 决策 4 — first version: no exceptions, no off switch) ----

/** Directory rules, matched against ANY contiguous segment window of the
 *  path (`.config/gcloud` is a two-segment window). `*` matches any substring
 *  within one segment. ASCII case-insensitive. Frozen verbatim from the
 *  Batch 1 plan — the test pins this table literally. */
export const NEVER_SYNC_DIRECTORY_RULES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".worktrees",
  ".venv",
  "venv",
  ".yarn",
  ".pnpm-store",
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".loopzhb",
  ".loopany",
  ".claude",
  ".codex",
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".gnupg",
  ".config/gcloud",
  "loopzhb-control-*",
  "loopzhb-runs-*",
  "lzc-*",
];

/** File rules, matched against the path's BASENAME only. `*` matches any
 *  substring. ASCII case-insensitive. Frozen verbatim from the Batch 1 plan. */
export const NEVER_SYNC_FILE_RULES: readonly string[] = [
  ".DS_Store",
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
];

/** ASCII-only case fold (A-Z → a-z). Matching folds; manifest values stay
 *  verbatim — no case folding, no Unicode normalization (ADR-010 决策 2). */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** One rule segment against one path segment; `*` matches any substring
 *  (a leading `*` is a suffix rule, a trailing `*` a prefix rule). Rules
 *  carry at most one `*`. */
function segmentMatches(rule: string, segment: string): boolean {
  const star = rule.indexOf("*");
  if (star === -1) return rule === segment;
  const head = rule.slice(0, star);
  const tail = rule.slice(star + 1);
  return segment.length >= head.length + tail.length && segment.startsWith(head) && segment.endsWith(tail);
}

/** True when `path` (already validated as a canonical relative path) hits a
 *  never-sync rule: a directory rule matching any contiguous segment window,
 *  or a file rule matching the basename. ASCII case-insensitive. */
export function isNeverSyncPath(path: string): boolean {
  const segments = path.split("/").map(asciiLower);
  for (const rule of NEVER_SYNC_DIRECTORY_RULES) {
    const ruleSegments = asciiLower(rule).split("/");
    window: for (let start = 0; start + ruleSegments.length <= segments.length; start++) {
      for (let i = 0; i < ruleSegments.length; i++) {
        if (!segmentMatches(ruleSegments[i]!, segments[start + i]!)) continue window;
      }
      return true;
    }
  }
  const basename = segments[segments.length - 1]!;
  for (const rule of NEVER_SYNC_FILE_RULES) {
    if (segmentMatches(asciiLower(rule), basename)) return true;
  }
  return false;
}

// ---- path validation (ADR-010 决策 2) ----

export type ArtifactPathFailure =
  | "path_empty"
  | "path_contains_nul"
  | "path_malformed_unicode"
  | "path_backslash"
  | "path_absolute"
  | "path_drive_letter"
  | "path_empty_segment"
  | "path_dot_segment"
  | "path_too_long";

export type ArtifactPathValidation = { ok: true; path: string } | { ok: false; failure: ArtifactPathFailure };

/**
 * Validate a manifest path: a CANONICAL POSIX relative path, kept VERBATIM —
 * no URL decoding, no case folding, no Unicode normalization. The check order
 * is fixed so the first failure is deterministic: empty → NUL → unpaired
 * surrogate → backslash → absolute → drive letter → per-segment analysis in
 * wire order (empty segment, then exact `.`/`..`) → UTF-8 byte length.
 * `a..b` and `...` are LEGAL segments; only exact `.` and `..` reject.
 */
export function validateArtifactPath(raw: string): ArtifactPathValidation {
  if (raw === "") return { ok: false, failure: "path_empty" };
  if (raw.includes("\0")) return { ok: false, failure: "path_contains_nul" };
  if (hasUnpairedSurrogate(raw)) return { ok: false, failure: "path_malformed_unicode" };
  if (raw.includes("\\")) return { ok: false, failure: "path_backslash" };
  if (raw.startsWith("/")) return { ok: false, failure: "path_absolute" };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, failure: "path_drive_letter" };
  for (const segment of raw.split("/")) {
    if (segment === "") return { ok: false, failure: "path_empty_segment" };
    if (segment === "." || segment === "..") return { ok: false, failure: "path_dot_segment" };
  }
  if (utf8BytesExceed(raw, ARTIFACT_PATH_MAX_UTF8_BYTES)) return { ok: false, failure: "path_too_long" };
  return { ok: true, path: raw };
}

// ---- manifest validation & normalization (ADR-010 决策 2/3) ----

export type ArtifactEntryFailure =
  | ArtifactPathFailure
  | "path_never_sync"
  | "hash_malformed"
  | "size_invalid"
  | "file_too_large";

export type ArtifactManifestFailure =
  | ArtifactEntryFailure
  | "duplicate_path"
  | "file_dir_conflict"
  | "hash_size_mismatch"
  | "too_many_entries"
  | "manifest_too_large";

/** One manifest entry after validation — the value is VERBATIM, only the
 *  collection order changes. */
export type NormalizedManifestEntry = { path: string; hash: string; size: number };

export type ManifestValidation =
  | { ok: true; entries: NormalizedManifestEntry[] }
  | { ok: false; failure: ArtifactManifestFailure; index?: number; path?: string; hash?: string };

/**
 * Validate and normalize the CURRENT COMPLETE manifest in one wire-order
 * pass. ANY illegal, oversize or never-sync entry rejects the WHOLE manifest
 * — never skip, never truncate: on commit an absent path DELETES that file
 * from the current view, so a partial manifest is data loss.
 *
 * Per-entry check order (deterministic first failure): path validity →
 * never-sync → hash shape → size domain → per-file cap → duplicate path →
 * file/dir conflict (both wire orders: `a`+`a/b` and `a/b`+`a`) → hash-size
 * consistency. After the pass: the entry-count cap, then the aggregate byte
 * cap charged PER PATH. Normalization = validation + ordering: values stay
 * verbatim; entries come back sorted by path in UTF-16 code-unit order
 * (JavaScript's default string comparison — no locale).
 */
export function normalizeManifestEntries(entries: readonly ArtifactManifestEntry[]): ManifestValidation {
  const seenPaths = new Set<string>(); // accepted file paths
  const seenDirPrefixes = new Set<string>(); // every proper prefix of an accepted path
  const seenHashes = new Map<string, number>();
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const pathResult = validateArtifactPath(entry.path);
    if (!pathResult.ok) return { ok: false, failure: pathResult.failure, index, path: entry.path };
    if (isNeverSyncPath(entry.path)) return { ok: false, failure: "path_never_sync", index, path: entry.path };
    if (!ARTIFACT_HASH_RE.test(entry.hash)) {
      return { ok: false, failure: "hash_malformed", index, path: entry.path, hash: entry.hash };
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      return { ok: false, failure: "size_invalid", index, path: entry.path, hash: entry.hash };
    }
    if (entry.size > ARTIFACT_FILE_MAX_BYTES) {
      return { ok: false, failure: "file_too_large", index, path: entry.path, hash: entry.hash };
    }
    if (seenPaths.has(entry.path)) return { ok: false, failure: "duplicate_path", index, path: entry.path };
    const segments = entry.path.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix === "" ? segments[i]! : `${prefix}/${segments[i]!}`;
      // An earlier FILE sits at a proper prefix of this path.
      if (seenPaths.has(prefix)) return { ok: false, failure: "file_dir_conflict", index, path: entry.path };
    }
    // This path IS a proper prefix of an earlier file.
    if (seenDirPrefixes.has(entry.path)) return { ok: false, failure: "file_dir_conflict", index, path: entry.path };
    const seenSize = seenHashes.get(entry.hash);
    if (seenSize !== undefined && seenSize !== entry.size) {
      return { ok: false, failure: "hash_size_mismatch", index, path: entry.path, hash: entry.hash };
    }
    seenPaths.add(entry.path);
    prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix === "" ? segments[i]! : `${prefix}/${segments[i]!}`;
      seenDirPrefixes.add(prefix);
    }
    seenHashes.set(entry.hash, entry.size);
    totalBytes += entry.size;
  }
  if (entries.length > ARTIFACT_MANIFEST_MAX_ENTRIES) return { ok: false, failure: "too_many_entries" };
  if (totalBytes > ARTIFACT_MANIFEST_MAX_TOTAL_BYTES) return { ok: false, failure: "manifest_too_large" };
  const normalized = entries.map((entry) => ({ path: entry.path, hash: entry.hash, size: entry.size }));
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, entries: normalized };
}

// ---- bounded JSON parsing (ADR-010 决策 5) ----

export type BoundedJsonParse = { ok: true; value: unknown } | { ok: false; failure: "too_large" | "not_json" };

/**
 * Parse JSON text under a byte ceiling measured over the RAW text — BEFORE
 * JSON.parse, so unknown fields count toward the limit (tolerant-reader
 * stripping happens later and rescues nothing). The pipeline order is frozen:
 * cap-on-raw → strip → validate → fingerprint-on-normalized.
 *
 * Returns the parsed value as `unknown` WITHOUT any schema validation:
 * bounded parsing (syntax + size) and shape validation stay two composable
 * steps. Batch 2's HTTP adapter must gate prepare routes with BOTH a
 * bodyLimit at the same ceiling AND this tool (defense in depth); internal
 * non-HTTP paths share this same function.
 */
export function parseBoundedJsonText(raw: string, maxBytes: number): BoundedJsonParse {
  if (utf8BytesExceed(raw, maxBytes)) return { ok: false, failure: "too_large" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, failure: "not_json" };
  }
}

// ---- canonical normalization & fingerprints (ADR-010 决策 6) ----

/**
 * Stable JSON serialization: object keys sorted in UTF-16 code-unit order
 * (no locale), arrays kept in order, numbers via JSON.stringify (the policy
 * domain is non-negative safe integers, exactly representable), no
 * whitespace. PRECONDITION: `value` is plain JSON data as zod/JSON.parse
 * produced it — no getters, Proxies, cycles or non-JSON leaves; this is
 * trusted-data ordering, not the adversarial-input traversal of json.ts.
 */
export function canonicalJsonString(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJsonString(item)).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonString(value[key]!)}`).join(",")}}`;
    }
    default:
      throw new Error("canonicalJsonString: not a JSON value");
  }
}

/** The normalized prepare payload the session fingerprint covers: EVERYTHING
 *  except `requestId` (the idempotency KEY, not payload). Same key + same
 *  canonical payload ⇒ reuse the session; same key + a different payload
 *  (including a stale configRevision/baseManifestRevision) ⇒ conflict. */
export type NormalizedPreparePayload = {
  loopId: string;
  configRevision: number;
  baseManifestRevision: number;
  /** Validated entries sorted by path (normalizeManifestEntries output). */
  entries: readonly NormalizedManifestEntry[];
};

/** Canonical string of a normalized prepare payload — order-independent over
 *  the wire entry order, insensitive to stripped unknown fields (the
 *  fingerprint is computed AFTER strip + validation, over known normalized
 *  fields only). */
export function canonicalPreparePayloadString(payload: NormalizedPreparePayload): string {
  return canonicalJsonString({
    loopId: payload.loopId,
    configRevision: payload.configRevision,
    baseManifestRevision: payload.baseManifestRevision,
    entries: payload.entries.map((entry) => ({ path: entry.path, hash: entry.hash, size: entry.size })),
  });
}

/** Canonical string of the COMPLETE watch configuration set: items sorted by
 *  loopId, each item's roots deduped + sorted (a set, not a list). Covers the
 *  watch CONFIGURATION only — never file content — so it does not change as
 *  files sync. */
export function canonicalWatchConfigString(items: readonly ArtifactWatchItem[]): string {
  const normalized = items
    .map((item) => ({
      loopId: item.loopId,
      artifactDir: item.artifactDir,
      workdir: item.workdir,
      roots: [...new Set(item.roots)].sort(),
      configRevision: item.configRevision,
    }))
    .sort((a, b) => (a.loopId < b.loopId ? -1 : a.loopId > b.loopId ? 1 : 0));
  return canonicalJsonString(normalized);
}
