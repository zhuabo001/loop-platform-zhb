/**
 * Artifact root resolution pins (slice 3, plan AJ1–AJ3 and the root half of
 * AJ4; ADR-010 决策 23). The fixture base is realpath'd up front because
 * macOS tmpdir() is itself behind a symlink (/var → /private/var) and this
 * resolver speaks only canonical paths.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ARTIFACT_SYNC_FAILURES } from "@loopzhb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveArtifactRoot, type ArtifactScanFailure } from "./artifact-jail.js";

let base: string;

const p = (...parts: string[]): string => path.join(base, ...parts);

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-artifact-jail-test-"));
  mkdirSync(p("work", "proj"), { recursive: true });
  mkdirSync(p("narrow", "work"), { recursive: true });
  mkdirSync(p("secret"), { recursive: true });
  mkdirSync(p("foo"), { recursive: true });
  mkdirSync(p("foobar"), { recursive: true });
  writeFileSync(p("a-file"), "x");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function expectFailure(
  input: Parameters<typeof resolveArtifactRoot>[0],
  failure: ArtifactScanFailure,
): Promise<string> {
  const result = await resolveArtifactRoot(input);
  if (result.kind !== "failed") throw new Error(`expected a failure, got ok with root ${result.resolved.root}`);
  expect(result.failure).toBe(failure);
  return result.detail;
}

describe("ArtifactScanFailure domain", () => {
  it("is the shared taxonomy minus the two classes a local scan never invents", () => {
    // Compile-time pin: this record must name every member of the alias.
    const handled: Record<ArtifactScanFailure, true> = {
      directory_missing: true,
      unreadable: true,
      outside_jail: true,
      symlink: true,
      special_file: true,
      unstable: true,
      too_large: true,
    };
    const expected = ARTIFACT_SYNC_FAILURES.filter((failure) => failure !== "watcher_error" && failure !== "timeout");
    expect(Object.keys(handled).sort()).toEqual([...expected].sort());
    expect(expected).toHaveLength(7);
  });
});

describe("AJ1 — workdir-relative resolution", () => {
  it("resolves a relative artifactDir against the explicit workdir and returns the realpath", async () => {
    const result = await resolveArtifactRoot({
      artifactDir: "proj",
      workdir: p("work"),
      serverRoots: [base],
      daemonRoots: [base],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.root).toBe(p("work", "proj"));
    expect(result.resolved.effectiveRoots).toEqual([base]);
  });

  it("a `..` chain that escapes the effective roots is outside_jail", async () => {
    // Resolves to <base>/secret — still inside the DAEMON root but outside
    // the server's narrowing, which is the whole point of the intersection.
    await expectFailure(
      {
        artifactDir: "../../secret",
        workdir: p("narrow", "work"),
        serverRoots: [p("narrow")],
        daemonRoots: [base],
      },
      "outside_jail",
    );
  });

  it("a missing relative target is directory_missing", async () => {
    await expectFailure(
      { artifactDir: "missing", workdir: p("work"), serverRoots: [base], daemonRoots: [base] },
      "directory_missing",
    );
  });

  it("NEVER resolves against the process cwd (a path that would exist there is still refused)", async () => {
    // If this relative path were resolved against process.cwd() it would land
    // exactly on <base>/work/proj and pass containment — so `outside_jail`
    // proves the cwd fallback does not exist.
    const cwdRelative = path.relative(process.cwd(), p("work", "proj"));
    expect(cwdRelative.startsWith("/")).toBe(false);
    await expectFailure(
      { artifactDir: cwdRelative, workdir: null, serverRoots: [base], daemonRoots: [base] },
      "outside_jail",
    );
  });
});

describe("AJ2 — absolute artifactDir, no workdir", () => {
  it("accepts an absolute path inside the roots", async () => {
    const result = await resolveArtifactRoot({
      artifactDir: p("work", "proj"),
      workdir: null,
      serverRoots: [base],
      daemonRoots: [base],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.root).toBe(p("work", "proj"));
  });

  it("refuses a relative path when there is no workdir to resolve it", async () => {
    await expectFailure(
      { artifactDir: "proj", workdir: null, serverRoots: [base], daemonRoots: [base] },
      "outside_jail",
    );
  });

  it("refuses an absolute path outside every root, and a relative workdir", async () => {
    await expectFailure(
      { artifactDir: realpathSync(tmpdir()), workdir: null, serverRoots: [base], daemonRoots: [base] },
      "outside_jail",
    );
    await expectFailure(
      { artifactDir: "proj", workdir: "work", serverRoots: [base], daemonRoots: [base] },
      "outside_jail",
    );
  });
});

describe("AJ3 — the daemon ∩ server roots intersection", () => {
  it("keeps the narrower root and exposes effectiveRoots", async () => {
    const result = await resolveArtifactRoot({
      artifactDir: p("narrow", "work"),
      workdir: null,
      serverRoots: [p("narrow")],
      daemonRoots: [base],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.effectiveRoots).toEqual([p("narrow")]);
  });

  it("drops a child root already covered by a surviving parent", async () => {
    const result = await resolveArtifactRoot({
      artifactDir: p("work"),
      workdir: null,
      serverRoots: [base, p("work")],
      daemonRoots: [base],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.effectiveRoots).toEqual([base]);
  });

  it("an empty server root set means every daemon root", async () => {
    const result = await resolveArtifactRoot({
      artifactDir: p("work"),
      workdir: null,
      serverRoots: [],
      daemonRoots: [base, p("narrow")],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.effectiveRoots).toEqual([base, p("narrow")]);
  });

  it("disjoint sets are outside_jail", async () => {
    await expectFailure(
      { artifactDir: p("foo"), workdir: null, serverRoots: [p("foobar")], daemonRoots: [p("foo")] },
      "outside_jail",
    );
  });

  it("an illegal server root (missing, relative, non-directory, `..`) is outside_jail", async () => {
    const shared = { artifactDir: p("work"), workdir: null, daemonRoots: [base] } as const;
    await expectFailure({ ...shared, serverRoots: [p("missing")] }, "outside_jail");
    await expectFailure({ ...shared, serverRoots: ["relative/root"] }, "outside_jail");
    await expectFailure({ ...shared, serverRoots: [p("a-file")] }, "outside_jail");
    await expectFailure({ ...shared, serverRoots: [`..${path.sep}${path.basename(base)}`] }, "outside_jail");
  });

  it("a post-realpath stat failure is outside_jail — no raw errno escapes (#89)", async () => {
    // The root exists for the realpath and then the stat fails: the shared
    // canonicalizer must convert the expected filesystem fault into ITS
    // contract (JailError), so the resolver keeps returning a result instead
    // of throwing — the failure domain stays closed for slice 4/5 callers.
    for (const code of ["ENOENT", "EACCES", "EPERM"]) {
      const result = await resolveArtifactRoot({
        artifactDir: p("work"),
        workdir: null,
        serverRoots: [base],
        daemonRoots: [base],
        io: {
          stat: async (target) => {
            if (target === base) throw Object.assign(new Error(`injected ${code}`), { code });
            return fs.stat(target);
          },
        },
      });
      if (result.kind !== "failed") throw new Error(`expected a failure for ${code}, got ok with ${result.resolved.root}`);
      expect(result.failure, code).toBe("outside_jail");
    }
  });

  it("a non-directory server root is outside_jail (real filesystem, same domain)", async () => {
    await expectFailure(
      { artifactDir: p("work"), workdir: null, serverRoots: [p("a-file")], daemonRoots: [base] },
      "outside_jail",
    );
  });

  it("no daemon root at all is outside_jail, checked before anything else", async () => {
    await expectFailure(
      { artifactDir: "", workdir: null, serverRoots: [], daemonRoots: [] },
      "outside_jail",
    );
  });
});

describe("AJ4 (root half) — a symlinked artifactDir is followed, then jailed", () => {
  it("a root symlink landing inside the effective roots resolves to its target", async () => {
    symlinkSync(p("work", "proj"), p("link-in"));
    const result = await resolveArtifactRoot({
      artifactDir: p("link-in"),
      workdir: null,
      serverRoots: [base],
      daemonRoots: [base],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.root).toBe(p("work", "proj"));
  });

  it("a root symlink landing outside the NARROWED roots is outside_jail", async () => {
    symlinkSync(p("secret"), p("link-out"));
    await expectFailure(
      { artifactDir: p("link-out"), workdir: null, serverRoots: [p("narrow")], daemonRoots: [base] },
      "outside_jail",
    );
    // …while the same link inside an unnarrowed set resolves to the target.
    const result = await resolveArtifactRoot({
      artifactDir: p("link-out"),
      workdir: null,
      serverRoots: [],
      daemonRoots: [base],
    });
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.failure}: ${result.detail}`);
    expect(result.resolved.root).toBe(p("secret"));
  });

  it("a dangling root symlink is directory_missing and a loop is symlink", async () => {
    symlinkSync(p("nowhere"), p("dangling"));
    await expectFailure(
      { artifactDir: p("dangling"), workdir: null, serverRoots: [base], daemonRoots: [base] },
      "directory_missing",
    );
    symlinkSync(p("loop-b"), p("loop-a"));
    symlinkSync(p("loop-a"), p("loop-b"));
    await expectFailure(
      { artifactDir: p("loop-a"), workdir: null, serverRoots: [base], daemonRoots: [base] },
      "symlink",
    );
  });

  it("an empty or NUL-bearing artifactDir fails before any filesystem work", async () => {
    const shared = { workdir: null, serverRoots: [base], daemonRoots: [base] } as const;
    await expectFailure({ ...shared, artifactDir: "" }, "directory_missing");
    await expectFailure({ ...shared, artifactDir: "a\0b" }, "unreadable");
  });
});
