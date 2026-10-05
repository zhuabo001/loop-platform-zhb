/**
 * Slice-5 (#91, ADR-010 决策 25) unit coverage for the artifact-root guard.
 * The predicate itself is protocol's (`isNeverSyncDirectoryPath`, the A5
 * suite); here we pin the guard's LANDING resolution — the root itself, an
 * ancestor symlink and a root symlink all resolve through realpath before the
 * match — plus the two deliberate non-refusals (a directory named after a FILE
 * rule, an unresolvable root owned by the scan's own classification).
 *
 * Mutation that reddens this file: judging the raw argument instead of the
 * realpath (`artifact-root-guard.ts` guardArtifactRoot).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardArtifactRoot } from "./artifact-root-guard.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-root-guard-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("artifact-root guard (#91, 决策 25)", () => {
  it("allows ordinary roots, including a directory named after a FILE rule", async () => {
    mkdirSync(path.join(base, "proj", "credentials"), { recursive: true });
    expect(await guardArtifactRoot(path.join(base, "proj"))).toEqual({ kind: "ok" });
    // `.env`/`credentials` are FILE rules: the root is a directory, not a secret.
    expect(await guardArtifactRoot(path.join(base, "proj", "credentials"))).toEqual({ kind: "ok" });
  });

  it("refuses a root inside a never-sync directory, with the landed path in the detail", async () => {
    mkdirSync(path.join(base, "real", ".ssh", "keys"), { recursive: true });
    const verdict = await guardArtifactRoot(path.join(base, "real", ".ssh", "keys"));
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") expect(verdict.detail).toContain(".ssh");
  });

  it("refuses a root whose ANCESTOR is a symlink into a never-sync region", async () => {
    mkdirSync(path.join(base, "real", ".ssh", "proj"), { recursive: true });
    mkdirSync(path.join(base, "work"));
    symlinkSync(path.join(base, "real", ".ssh"), path.join(base, "work", "link"));
    // The argument contains NO never-sync segment — only its realpath does.
    expect(await guardArtifactRoot(path.join(base, "work", "link", "proj"))).toMatchObject({ kind: "refused" });
  });

  it("refuses a root SYMLINK whose landing point is a never-sync region", async () => {
    mkdirSync(path.join(base, "real", ".config", "gcloud"), { recursive: true });
    symlinkSync(path.join(base, "real", ".config", "gcloud"), path.join(base, "gcloud-link"));
    expect(await guardArtifactRoot(path.join(base, "gcloud-link"))).toMatchObject({ kind: "refused" });
  });

  it("is NOT a refusal when the root cannot be resolved — the scan owns that classification", async () => {
    expect(await guardArtifactRoot(path.join(base, "missing"))).toEqual({ kind: "ok" });
    const failing = (): Promise<string> => Promise.reject(new Error("EACCES: permission denied"));
    expect(await guardArtifactRoot(path.join(base, "unreadable"), { realpath: failing })).toEqual({ kind: "ok" });
  });
});
